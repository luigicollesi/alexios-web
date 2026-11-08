import "server-only";
import {randomUUID} from "node:crypto";
import {query, numeric} from "@/lib/agent-db";
import {fastFloorEligible, parseFastDecision, type FastDecision} from "@/lib/v3/fast-protocol";
import {v3Messages} from "@/lib/v3/persona-core";
import type {Stance} from "@/lib/v3/protocol";
import {FRESH_FLOOR_TURNS_SQL, formatFreshFloorTurns, type FloorTurn}
  from "@/lib/v3/floor-turns";
import {
  fastModelCandidates, fastCompletionBody, fastFailureCode,
  fastShouldTryFallback, FastProviderHttpError,
} from "@/lib/v3/fast-provider";

type ClaimedFastFloor = {
  event_id: string;
  agent_id: string;
  run_id: string;
  sequence: string | number;
  activity_epoch: string | number;
  received_at: string;
  context_text: string;
  character_stance: Stance;
  character_waiting_variant: number;
  active_run_id: string;
  latest_activity: string | number;
  power: string;
  desired_power: string;
  lease_fresh: boolean;
};
type SpeechRow = {fast_status: string; speech_published: boolean};
async function claim(eventId: string, token: string): Promise<ClaimedFastFloor | null> {
  const rows = await query<ClaimedFastFloor>(
    `WITH claimed AS (
      UPDATE public.alexios_v3_events e
      SET fast_status = 'running', fast_token = $2::uuid,
          fast_started_at = now(), fast_error = NULL
      WHERE e.event_id = $1::uuid AND e.event_type = 'floor_open'
        AND e.fast_status = 'pending'
      RETURNING *
    )
    SELECT e.event_id, e.agent_id, e.run_id, e.sequence, e.activity_epoch,
      e.received_at, s.context_text, s.character_stance,
      s.character_waiting_variant, st.active_run_id,
      st.activity_epoch AS latest_activity, s.power, s.desired_power,
      (s.last_poll_at > now() - interval '45 seconds'
        AND s.protocol_version = 3 AND s.run_id = e.run_id) AS lease_fresh
    FROM claimed e
    JOIN public.alexios_v3_streams st ON st.agent_id = e.agent_id
    JOIN public.alexios_sessions s ON s.agent_id = e.agent_id`,
    [eventId, token],
  );
  return rows[0] || null;
}

async function fetchTurns(floor: ClaimedFastFloor): Promise<string> {
  const rows = await query<FloorTurn>(FRESH_FLOOR_TURNS_SQL, [
    floor.agent_id, floor.run_id, numeric(floor.sequence),
  ]);
  return formatFreshFloorTurns(rows, 360, 1400);
}

async function decideSpeech(floor: ClaimedFastFloor, recentTurns: string) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY ausente.");
  const candidates = fastModelCandidates({
    shared: process.env.OPENROUTER_MODEL,
    primary: process.env.ALEXIOS_V3_FAST_MODEL,
    fallback: process.env.ALEXIOS_V3_FAST_FALLBACK_MODEL,
    timeoutMs: process.env.ALEXIOS_V3_FAST_MODEL_TIMEOUT_MS,
  });
  const messages = v3Messages({
    context: floor.context_text,
    stance: floor.character_stance,
    waitingVariant: floor.character_waiting_variant,
    freshSpeech: recentTurns,
    responseWindow: true,
  });
  let lastError: unknown = new Error("No response received");
  const t0 = Date.now();
  for (const [index, candidate] of candidates.entries()) {
    const attemptedAt = Date.now();
    try {
      // Response format and provider filters are intentionally omitted.
      // Many free endpoint/provider combinations do not accept all settings.
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
          "HTTP-Referer": "https://alexios-web.vercel.app",
          "X-Title": "Alexios V3 Fast",
        },
        body: JSON.stringify(fastCompletionBody(candidate, messages)),
        signal: AbortSignal.timeout(candidate.timeoutMs),
      });
      if (!response.ok) throw new FastProviderHttpError(response.status);
      const data = await response.json() as {
        choices?: Array<{
          finish_reason?: string | null;
          message?: {content?: unknown};
        }>;
      };
      const first = data.choices?.[0];
      if (first?.finish_reason === "length") {
        throw new SyntaxError("Fast model JSON truncated by max_tokens.");
      }
      const decision = parseFastDecision(first?.message?.content);
      return {
        ...decision,
        modelMs: Date.now() - attemptedAt,
        totalModelMs: Date.now() - t0,
        modelIndex: index,
        model: candidate.model,
      };
    } catch (error) {
      lastError = error;
      const reason = fastFailureCode(error);
      console.warn("[Alexios V3 FAST] modelo falhou", {
        eventId: floor.event_id,
        model: candidate.model,
        reason,
        elapsedMs: Date.now() - attemptedAt,
        fallbackAvailable: index < candidates.length - 1 && fastShouldTryFallback(reason),
      });
      if (!fastShouldTryFallback(reason)) break;
    }
  }
  throw lastError;
}

async function finalize(
  floor: ClaimedFastFloor, token: string, decision: FastDecision, modelMs: number,
): Promise<SpeechRow | null> {
  // Persist the AI-generated memory/pose even on voluntary silence. A floor
  // is consumed exactly once. The run/epoch/lease/FIM gate prevents stale
  // results; optimistic context comparison prevents a slow result from
  // overwriting another inference's newer consolidated memory.
  const rows = await query<SpeechRow>(
    `WITH gate AS MATERIALIZED (
      SELECT e.event_id, e.agent_id
      FROM public.alexios_v3_events e
      JOIN public.alexios_v3_streams st ON st.agent_id = e.agent_id
      JOIN public.alexios_sessions s ON s.agent_id = e.agent_id
      WHERE e.event_id = $1::uuid AND e.fast_token = $2::uuid
        AND e.fast_status = 'running'
        AND st.active_run_id = e.run_id
        AND st.activity_epoch = e.activity_epoch
        AND s.run_id = e.run_id AND s.protocol_version = 3
        AND s.power = 'running' AND s.desired_power = 'running'
        AND s.last_poll_at > now() - interval '45 seconds'
        AND now() - e.received_at < interval '9 seconds'
      FOR UPDATE OF st, s
    ), persisted AS (
      UPDATE public.alexios_sessions s SET
        context_text = CASE WHEN s.context_text = $6::text
          THEN $5::text ELSE s.context_text END,
        character_stance = CASE WHEN s.context_text = $6::text
          THEN $7::text ELSE s.character_stance END,
        character_waiting_variant = CASE WHEN s.context_text = $6::text
          THEN $8::smallint ELSE s.character_waiting_variant END,
        speech_text = CASE WHEN $3::text <> ''
          THEN $3::text ELSE s.speech_text END,
        speech_seq = speech_seq + CASE WHEN $3::text <> '' THEN 1 ELSE 0 END,
        speech_at = CASE WHEN $3::text <> '' THEN now() ELSE s.speech_at END,
        expression_id = CASE WHEN $3::text <> ''
          THEN 'speaking' ELSE 'idle' END,
        character_frame = CASE WHEN $3::text <> ''
          THEN 'speaking'
          WHEN $8::smallint = 2 THEN 'waiting_2' ELSE 'waiting_1' END,
        character_speaking_until = CASE WHEN $3::text <> ''
          THEN now() +
            LEAST(12, GREATEST(3, LENGTH($3::text) / 17)) * interval '1 second'
          ELSE NULL END,
        version = version + 1, updated_at = now()
      WHERE s.agent_id = (SELECT agent_id FROM gate)
      RETURNING s.agent_id
    ), finished AS (
      UPDATE public.alexios_v3_events e SET
        fast_status = CASE
          WHEN EXISTS (SELECT 1 FROM persisted) AND $3::text <> '' THEN 'published'
          WHEN EXISTS (SELECT 1 FROM persisted) THEN 'silent'
          ELSE 'revoked' END,
        fast_finished_at = now(), fast_model_ms = $4::integer, fast_token = NULL,
        fast_error = CASE WHEN EXISTS (SELECT 1 FROM persisted) THEN NULL
          ELSE 'floor_invalidated_before_publication' END
      WHERE e.event_id = $1::uuid AND e.fast_token = $2::uuid
        AND e.fast_status = 'running'
      RETURNING e.fast_status
    )
    SELECT fast_status,
      (fast_status = 'published') AS speech_published
    FROM finished`,
    [floor.event_id, token, decision.shouldSpeak ? decision.speech : "",
     modelMs, decision.context, floor.context_text,
     decision.stance, decision.waitingVariant],
  );
  return rows[0] || null;
}

async function failFast(
  eventId: string, token: string, error: string,
  status: "revoked" | "silent" = "silent",
) {
  await query(
    `UPDATE public.alexios_v3_events SET
      fast_status = $4::text, fast_finished_at = now(), fast_token = NULL,
      fast_error = $3::text
    WHERE event_id = $1::uuid AND fast_token = $2::uuid
      AND fast_status = 'running'`,
    [eventId, token, error.slice(0, 90), status],
  );
}

/**
 * Executed using Next.js after() following the 202 HTTP acknowledgement.
 * The DB-persisted event and queue consumer remain the recovery source.
 */
export async function processFastFloorV3(eventId: string): Promise<void> {
  const token = randomUUID();
  let current: ClaimedFastFloor | null = null;
  const started = Date.now();
  try {
    current = await claim(eventId, token);
    if (!current) return; // already claimed/published by another invocation
    const valid = fastFloorEligible({
      runId: current.run_id, activeRunId: current.active_run_id,
      activityEpoch: numeric(current.activity_epoch),
      latestActivityEpoch: numeric(current.latest_activity),
      power: current.power, desiredPower: current.desired_power,
      pollFresh: current.lease_fresh,
      receivedAtMs: Date.parse(current.received_at), nowMs: Date.now(),
    });
    if (!valid) {
      await failFast(eventId, token, "floor_invalid_before_model", "revoked");
      return;
    }
    const recent = await fetchTurns(current);
    if (!recent.trim()) {
      await failFast(eventId, token, "no_recent_turns");
      return;
    }
    const result = await decideSpeech(current, recent);
    const saved = await finalize(current, token, result, result.modelMs);
    console.info("[Alexios V3 FAST] finalizado", {
      eventId,
      modelMs: result.modelMs,
      totalModelMs: result.totalModelMs,
      model: result.model,
      modelIndex: result.modelIndex,
      endToEndMs: Date.now() - started,
      published: saved?.speech_published ?? false,
      status: saved?.fast_status ?? "already_finalized",
    });
  } catch (error) {
    const reason = fastFailureCode(error);
    console.warn("[Alexios V3 FAST] inferencia indisponivel", {
      eventId, reason, elapsedMs: Date.now() - started,
    });
    if (current) await failFast(eventId, token, reason);
  }
}
