import "server-only";
import {randomUUID} from "node:crypto";
import {query, numeric} from "@/lib/agent-db";
import {observeV3, respondV3} from "@/lib/v3/model-service";
import {FRESH_FLOOR_TURNS_SQL, formatFreshFloorTurns, type FloorTurn}
  from "@/lib/v3/floor-turns";
import type {Stance, Frame} from "@/lib/v3/protocol";
import {floorRejectReason} from "@/lib/v3/floor-policy";
import {FAST_WORKER_TIMEOUT_MS, fastFloorTerminal, type FastResponseStatus} from "@/lib/v3/fast-protocol";

type Claimed = {
  event_id: string;
  agent_id: string;
  run_id: string;
  sequence: string | number;
  event_type: "turn_end" | "turn_chunk" | "floor_open";
  fast_status: FastResponseStatus;
  transcript: string | null;
  speaker_id: string | null;
  activity_epoch: string | number;
  received_at: string;
  context_text: string;
  context_revision: string | number;
  character_stance: Stance;
  character_waiting_variant: number;
  character_frame: Frame;
  latest_activity: string | number;
  active_run_id: string;
  power: string;
  desired_power: string;
};
type State = {status: string; sequence: number | string;
  last_processed_sequence: number | string; processing: boolean};

export class V3DeferredError extends Error {
  constructor() {
    super("V3 aguardando evento anterior ou inferência ativa.");
    this.name = "V3DeferredError";
  }
}

async function claim(eventId: string, token: string): Promise<Claimed | null> {
  const result = await query<Claimed>(
    `WITH candidate AS (
      SELECT event_id, agent_id, sequence FROM public.alexios_v3_events
      WHERE event_id = $1::uuid AND status IN ('pending', 'running')
    ), reserved AS (
      UPDATE public.alexios_v3_streams st SET
        processing_token = $2::uuid, processing_started_at = now(), updated_at = now()
      WHERE st.agent_id = (SELECT agent_id FROM candidate)
        AND st.last_processed_sequence + 1 = (SELECT sequence FROM candidate)
        AND (st.processing_token IS NULL OR
             st.processing_started_at < now() - interval '110 seconds')
      RETURNING st.agent_id, st.activity_epoch AS latest_activity, st.active_run_id
    ), marked AS (
      UPDATE public.alexios_v3_events e SET
        status = 'running', attempts = attempts + 1,
        started_at = now(), last_error = NULL
      WHERE e.event_id = $1::uuid AND EXISTS (SELECT 1 FROM reserved)
      RETURNING *
    )
    SELECT e.event_id, e.agent_id, e.run_id, e.sequence,
      e.event_type, e.fast_status, e.transcript, e.speaker_id, e.activity_epoch, e.received_at,
      s.context_text, s.context_revision, s.character_stance, s.character_waiting_variant, s.character_frame,
      st.latest_activity, st.active_run_id, s.power, s.desired_power
    FROM marked e JOIN reserved st ON e.agent_id = st.agent_id
      JOIN public.alexios_sessions s ON s.agent_id = e.agent_id`,
    [eventId, token],
  );
  return result[0] ?? null;
}

async function releaseClaim(agentId: string, eventId: string, token: string, issue: string) {
  await query(
    `WITH released AS (
      UPDATE public.alexios_v3_streams SET
        processing_token = NULL, processing_started_at = NULL, updated_at = now()
      WHERE agent_id = $1::uuid AND processing_token = $2::uuid
      RETURNING agent_id
    )
    UPDATE public.alexios_v3_events SET
      status = 'pending', started_at = NULL, last_error = $4
    WHERE event_id = $3::uuid AND agent_id IN (SELECT agent_id FROM released)`,
    [agentId, token, eventId, issue.slice(0, 180)],
  );
  await query(
    "UPDATE public.alexios_sessions SET last_error = $2 WHERE agent_id = $1::uuid",
    [agentId, issue.slice(0, 180)],
  );
}

/** Close an already-decided fast floor without executing RESPOND again.
 * This NEVER touches speech_seq, speech_text, the active avatar or memory.
 */
async function finalizeFastFloor(
  job: Claimed, token: string,
): Promise<boolean> {
  const rows = await query<{event_id: string}>(
    `WITH moved AS (
      UPDATE public.alexios_v3_streams SET
        last_processed_sequence = $3::bigint, processing_token = NULL,
        processing_started_at = NULL, updated_at = now()
      WHERE agent_id = $1::uuid AND processing_token = $2::uuid
        AND last_processed_sequence + 1 = $3::bigint
      RETURNING agent_id
    ), finished AS (
      UPDATE public.alexios_v3_events e SET
        status = CASE WHEN e.fast_status IN ('published','silent')
          THEN 'processed' ELSE 'obsolete' END,
        processed_at = now(),
        last_error = CASE WHEN e.fast_status IN ('published','silent')
          THEN NULL ELSE COALESCE(e.fast_error, 'fast_response_expired') END
      WHERE e.event_id = $4::uuid
        AND e.agent_id IN (SELECT agent_id FROM moved)
      RETURNING event_id
    )
    SELECT event_id FROM finished`,
    [job.agent_id, token, numeric(job.sequence), job.event_id],
  );
  return Boolean(rows[0]);
}

async function expireStuckFastFloor(eventId: string): Promise<void> {
  await query(
    `UPDATE public.alexios_v3_events SET
      fast_status = 'timed_out', fast_finished_at = now(),
      fast_token = NULL, fast_error = 'fast_lane_deadline'
    WHERE event_id = $1::uuid AND fast_status IN ('pending','running')`,
    [eventId],
  );
}

async function advance(
  data: Claimed, token: string,
  decision: {context: string; stance: Stance; waitingVariant: number;
             speech?: string; shouldSpeak?: boolean; degraded?: boolean} | null,
  obsolete: boolean,
  obsoleteReason: string | null = null,
): Promise<{advanced: boolean; speechPublished: boolean; floorEligible: boolean}> {
  const response = decision && decision.shouldSpeak ? (decision.speech || "") : "";
  const rows = await query<{
    event_id: string;
    speech_published: boolean;
    floor_eligible: boolean;
  }>(
    `WITH moved AS (
      UPDATE public.alexios_v3_streams st SET
        last_processed_sequence = $3::bigint,
        processing_token = NULL, processing_started_at = NULL, updated_at = now()
      WHERE st.agent_id = $1::uuid AND st.processing_token = $2::uuid
        AND st.last_processed_sequence + 1 = $3::bigint
      RETURNING st.agent_id, st.active_run_id, st.activity_epoch
    ), persisted AS (
      UPDATE public.alexios_sessions s SET
        context_text = CASE
          -- Never replace another inference's newer memory with a stale
          -- snapshot. A legitimate legacy RESPOND also refreshes context.
          WHEN $8::boolean OR moved.active_run_id <> $5::uuid OR s.context_revision <> $16::bigint THEN s.context_text
          WHEN $4::text = 'floor_open'
            AND (moved.active_run_id <> $5::uuid
                 OR moved.activity_epoch <> $6::bigint
                 OR s.power <> 'running' OR s.desired_power <> 'running'
                 OR now() - $7::timestamptz >= interval '60 seconds')
          THEN s.context_text
          ELSE $9::text END,
        context_revision = CASE
          WHEN $8::boolean OR moved.active_run_id <> $5::uuid OR s.context_revision <> $16::bigint
            THEN s.context_revision
          WHEN $4::text = 'floor_open'
            AND (moved.active_run_id <> $5::uuid
                 OR moved.activity_epoch <> $6::bigint
                 OR s.power <> 'running' OR s.desired_power <> 'running'
                 OR now() - $7::timestamptz >= interval '60 seconds')
            THEN s.context_revision
          ELSE s.context_revision + 1 END,
        character_stance = CASE
          WHEN $8::boolean OR moved.active_run_id <> $5::uuid OR s.context_revision <> $16::bigint
            OR ($4::text = 'floor_open'
              AND (moved.active_run_id <> $5::uuid
                   OR moved.activity_epoch <> $6::bigint
                   OR s.power <> 'running' OR s.desired_power <> 'running'
                   OR now() - $7::timestamptz >= interval '60 seconds'))
          THEN s.character_stance ELSE $10::text END,
        character_waiting_variant = CASE
          WHEN $8::boolean OR moved.active_run_id <> $5::uuid OR s.context_revision <> $16::bigint
            OR ($4::text = 'floor_open'
              AND (moved.active_run_id <> $5::uuid
                   OR moved.activity_epoch <> $6::bigint
                   OR s.power <> 'running' OR s.desired_power <> 'running'
                   OR now() - $7::timestamptz >= interval '60 seconds'))
          THEN s.character_waiting_variant ELSE $11::smallint END,
        speech_text = CASE WHEN $4::text = 'floor_open'
          AND NOT $8::boolean AND $12::text <> ''
          AND moved.active_run_id = $5::uuid
          AND moved.activity_epoch = $6::bigint
          AND s.power = 'running' AND s.desired_power = 'running'
          AND s.protocol_version = 3
          AND now() - $7::timestamptz < interval '60 seconds'
          THEN $12::text ELSE s.speech_text END,
        speech_seq = speech_seq + CASE WHEN $4::text = 'floor_open'
          AND NOT $8::boolean AND $12::text <> ''
          AND moved.active_run_id = $5::uuid
          AND moved.activity_epoch = $6::bigint
          AND s.power = 'running' AND s.desired_power = 'running'
          AND s.protocol_version = 3
          AND now() - $7::timestamptz < interval '60 seconds'
          THEN 1 ELSE 0 END,
        speech_at = CASE WHEN $4::text = 'floor_open'
          AND NOT $8::boolean AND $12::text <> ''
          AND moved.active_run_id = $5::uuid
          AND moved.activity_epoch = $6::bigint
          AND s.power = 'running' AND s.desired_power = 'running'
          AND s.protocol_version = 3
          AND now() - $7::timestamptz < interval '60 seconds'
          THEN now() ELSE s.speech_at END,
        character_speaking_until = CASE WHEN $4::text = 'floor_open'
          AND NOT $8::boolean AND $12::text <> ''
          AND moved.active_run_id = $5::uuid
          AND moved.activity_epoch = $6::bigint
          AND s.power = 'running' AND s.desired_power = 'running'
          AND s.protocol_version = 3
          AND now() - $7::timestamptz < interval '60 seconds'
          THEN now() + (LEAST(12, GREATEST(3, LENGTH($12::text) / 17)) * interval '1 second')
          ELSE CASE WHEN s.character_speaking_until > now()
              AND moved.activity_epoch = $6::bigint
              THEN s.character_speaking_until
              ELSE NULL END END,
        character_frame = CASE
          WHEN moved.active_run_id <> $5::uuid THEN s.character_frame
          WHEN $4::text <> 'floor_open'
            AND s.character_speaking_until > now()
            AND moved.activity_epoch = $6::bigint
            AND s.character_frame = 'speaking'
          THEN 'speaking'
          WHEN $4::text = 'floor_open' AND NOT $8::boolean
            AND $12::text <> ''
            AND moved.active_run_id = $5::uuid
            AND moved.activity_epoch = $6::bigint
            AND s.power = 'running' AND s.desired_power = 'running'
            AND s.protocol_version = 3
            AND now() - $7::timestamptz < interval '60 seconds'
            THEN 'speaking'
          WHEN moved.active_run_id <> $5::uuid
             OR moved.activity_epoch > $6::bigint
             OR $4::text = 'turn_chunk'
            THEN 'listening'
          WHEN $11::smallint = 2 THEN 'waiting_2'
          ELSE 'waiting_1' END,
        expression_id = CASE
          WHEN moved.active_run_id <> $5::uuid THEN s.expression_id
          WHEN $4::text = 'floor_open' AND NOT $8::boolean
            AND $12::text <> ''
            AND moved.active_run_id = $5::uuid
            AND moved.activity_epoch = $6::bigint
            AND s.power = 'running' AND s.desired_power = 'running'
            AND s.protocol_version = 3
            AND now() - $7::timestamptz < interval '60 seconds'
            THEN 'speaking'
          WHEN moved.active_run_id <> $5::uuid
            OR moved.activity_epoch > $6::bigint
            OR $4::text = 'turn_chunk' THEN 'listening'
          ELSE 'idle' END,
        last_ai_at = CASE WHEN $8::boolean THEN s.last_ai_at ELSE now() END,
        last_error = CASE WHEN $14::boolean
          THEN 'OpenRouter indisponível ou respondeu JSON inválido; modo de recuperação.'
          ELSE NULL END,
        version = version + 1, updated_at = now()
      FROM moved
      WHERE s.agent_id = moved.agent_id AND s.protocol_version = 3
      RETURNING s.agent_id,
        (
          moved.active_run_id = $5::uuid
          AND moved.activity_epoch = $6::bigint
          AND s.power = 'running'
          AND s.desired_power = 'running'
          AND s.protocol_version = 3
          AND now() - $7::timestamptz < interval '60 seconds'
        ) AS floor_eligible,
        (
          $4::text = 'floor_open' AND $12::text <> ''
          AND s.speech_at = now()
        ) AS speech_published
    ), finished AS (
      UPDATE public.alexios_v3_events SET
        status = CASE
          WHEN $8::boolean
            OR NOT EXISTS (SELECT 1 FROM persisted)
            OR ($4::text = 'floor_open'
              AND NOT EXISTS (SELECT 1 FROM persisted WHERE floor_eligible))
          THEN 'obsolete'
          ELSE 'processed' END,
        processed_at = now(),
        last_error = CASE
          WHEN $8::boolean THEN $15::text
          WHEN $4::text = 'floor_open'
            AND NOT EXISTS (SELECT 1 FROM persisted WHERE floor_eligible)
          THEN 'revoked_during_inference'
          ELSE NULL END
      WHERE event_id = $13::uuid
        AND agent_id IN (SELECT agent_id FROM moved)
      RETURNING event_id
    )
    SELECT finished.event_id,
      EXISTS (
        SELECT 1 FROM persisted
        WHERE persisted.speech_published
      ) AS speech_published,
      EXISTS (
        SELECT 1 FROM persisted
        WHERE persisted.floor_eligible
      ) AS floor_eligible
    FROM finished`,
    [data.agent_id, token, numeric(data.sequence), data.event_type,
     data.run_id, numeric(data.activity_epoch), data.received_at,
     obsolete, decision?.context ?? data.context_text,
     decision?.stance ?? data.character_stance,
     decision?.waitingVariant ?? data.character_waiting_variant,
     response, data.event_id, decision?.degraded === true, obsoleteReason,
     numeric(data.context_revision)],
  );
  return {
    advanced: Boolean(rows[0]),
    speechPublished: Boolean(rows[0]?.speech_published),
    floorEligible: Boolean(rows[0]?.floor_eligible),
  };
}

async function recentTurnsForFloor(event: Claimed): Promise<string> {
  const rows = await query<FloorTurn>(FRESH_FLOOR_TURNS_SQL, [
    event.agent_id, event.run_id, numeric(event.sequence),
  ]);
  return formatFreshFloorTurns(rows);
}

function floorInvalidReason(data: Claimed): string | null {
  return floorRejectReason({
    runId: data.run_id,
    activeRunId: data.active_run_id,
    eventEpoch: numeric(data.activity_epoch),
    latestEpoch: numeric(data.latest_activity),
    power: data.power,
    desiredPower: data.desired_power,
    receivedAt: data.received_at,
  });
}

export async function processEventV3(eventId: string): Promise<{handled: boolean; reason?: string}> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new Error("ID de evento V3 inválido.");
  const token = randomUUID();
  const job = await claim(eventId, token);
  if (!job) {
    const rows = await query<State>(
      `SELECT e.status, e.sequence, st.last_processed_sequence,
        st.processing_token IS NOT NULL AS processing
       FROM public.alexios_v3_events e
       JOIN public.alexios_v3_streams st ON st.agent_id = e.agent_id
       WHERE e.event_id = $1::uuid`, [eventId],
    );
    const state = rows[0];
    if (!state || state.status === "processed" || state.status === "obsolete") {
      return {handled: false, reason: "already-finished"};
    }
    if (state.status === "failed") return {handled: false, reason: "requires-recovery"};
    throw new V3DeferredError();
  }
  const startedAt = Date.now();
  const sequence = numeric(job.sequence);
  const latencyBeforeProcessingMs = Date.now() - Date.parse(job.received_at);
  try {
    if (job.event_type === "floor_open" && job.fast_status !== "legacy") {
      if (!fastFloorTerminal(job.fast_status)) {
        const age = Date.now() - Date.parse(job.received_at);
        if (age < FAST_WORKER_TIMEOUT_MS) {
          throw new V3DeferredError();
        }
        // Background invocation disappeared or missed its deadline.
        // Expire without ever letting the older queued inference speak.
        await expireStuckFastFloor(job.event_id);
      }
      if (!await finalizeFastFloor(job, token)) throw new V3DeferredError();
      console.info("[Alexios V3 FAST] cursor avançado", {
        eventId, sequence, fastStatus: job.fast_status,
      });
      return {handled: true, reason: "fast-floor-complete"};
    }

    const floorReason = job.event_type === "floor_open"
      ? floorInvalidReason(job) : null;
    if (floorReason) {
      const outcome = await advance(job, token, null, true, floorReason);
      if (!outcome.advanced) throw new V3DeferredError();
      console.info("[Alexios V3] piso de fala obsoleto", {
        eventId, sequence, latencyBeforeProcessingMs,
        reason: floorReason,
        eventEpoch: numeric(job.activity_epoch),
        latestEpoch: numeric(job.latest_activity),
        power: job.power,
        desiredPower: job.desired_power,
      });
      return {handled: true, reason: floorReason};
    }
    const current = {
      context: job.context_text, stance: job.character_stance,
      waitingVariant: job.character_waiting_variant,
      frame: job.character_frame,
    };
    const freshTurns = job.event_type === "floor_open"
      ? await recentTurnsForFloor(job) : null;
    // A floor with no new speech is consumed silently, without another
    // provider request or any opportunity to replay old questions.
    const decision = job.event_type === "floor_open"
      ? freshTurns
        ? await respondV3({...current, recentTurns: freshTurns})
        : {...current, shouldSpeak: false, speech: ""}
      : await observeV3({
          ...current,
          speakerId: job.run_id.slice(0, 8) + "/" + (job.speaker_id ?? "speaker_unknown"),
          transcript: job.transcript ?? "",
        });
    const outcome = await advance(job, token, decision, false);
    if (!outcome.advanced) throw new V3DeferredError();
    console.info("[Alexios V3] evento processado", {
      eventId, sequence, type: job.event_type,
      latencyBeforeProcessingMs,
      inferenceAndCommitMs: Date.now() - startedAt,
      degraded: "degraded" in decision && decision.degraded === true,
      responseRequested: job.event_type === "floor_open"
        ? ("shouldSpeak" in decision && decision.shouldSpeak) : false,
      responsePublished: outcome.speechPublished,
      ...(job.event_type === "floor_open" && !outcome.floorEligible
        ? {reason: "revoked_during_inference"} : {}),
      // Report the committed result, not just the LLM's intention.
    });
    return {handled: true};
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error instanceof V3DeferredError) {
      // Expected: fast inference is completing in a separate function.
      await query(
        `WITH released AS (
          UPDATE public.alexios_v3_streams SET
            processing_token = NULL, processing_started_at = NULL, updated_at = now()
          WHERE agent_id = $1::uuid AND processing_token = $2::uuid
          RETURNING agent_id
        )
        UPDATE public.alexios_v3_events SET
          status = 'pending', started_at = NULL
        WHERE event_id = $3::uuid AND agent_id IN (SELECT agent_id FROM released)`,
        [job.agent_id, token, job.event_id],
      );
      throw error;
    }
    console.error("[Alexios V3] falha de processamento", {
      eventId, sequence, type: job.event_type, durationMs: Date.now() - startedAt,
      reason: msg.slice(0, 140),
    });
    await releaseClaim(job.agent_id, job.event_id, token, msg);
    throw error;
  }
}
