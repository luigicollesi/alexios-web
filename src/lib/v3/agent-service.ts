import "server-only";
import { AgentError, query, numeric } from "@/lib/agent-db";
import { connected, findInstance, sessionFor } from "@/lib/v2/agent-service";
import { parseIdentity, parseActivity, parseV3Event, type IncomingEvent, type V3EventKind } from "@/lib/v3/protocol";

type Auth = {agentId: string; runId: string};

async function authorizeV3(identity: {instanceId: string; runId: string}): Promise<Auth> {
  const agent = await findInstance(identity.instanceId);
  if (!agent) throw new AgentError(409, "Instância não registrada.");
  const row = await sessionFor(agent.id);
  if (row.run_id !== identity.runId || !connected(row)) {
    throw new AgentError(409, "Execução não possui lease V2 válida.");
  }
  return {agentId: agent.id, runId: identity.runId};
}

export async function syncV3(raw: unknown) {
  const identity = parseIdentity(raw);
  const {agentId, runId} = await authorizeV3(identity);
  const rows = await query<{
    next_sequence: number | string;
    recovery_event_id: string | null;
  }>(
    `WITH eligible AS (
      SELECT agent_id FROM public.alexios_sessions
      WHERE agent_id = $1::uuid AND run_id = $2::uuid
        AND last_poll_at > now() - interval '45 seconds'
    ), synced AS (
      INSERT INTO public.alexios_v3_streams (agent_id, active_run_id)
      SELECT agent_id, $2::uuid FROM eligible
      ON CONFLICT (agent_id) DO UPDATE SET
        activity_epoch = CASE
          WHEN alexios_v3_streams.active_run_id = EXCLUDED.active_run_id
          THEN alexios_v3_streams.activity_epoch ELSE 0 END,
        active_run_id = EXCLUDED.active_run_id, updated_at = now()
      RETURNING agent_id, last_accepted_sequence, last_processed_sequence
    ), versioned AS (
      UPDATE public.alexios_sessions SET
        protocol_version = 3,
        epoch = CASE WHEN protocol_version = 2 THEN epoch + 1 ELSE epoch END,
        pending_words = '[]'::jsonb, inference_words = '[]'::jsonb,
        inference_token = NULL, inference_started_at = NULL,
        capture = NULL, last_error = NULL,
        version = version + 1, updated_at = now(),
        character_frame = 'waiting_1', character_speaking_until = NULL
      WHERE agent_id = $1::uuid AND EXISTS (SELECT 1 FROM synced)
      RETURNING agent_id
    )
    SELECT last_accepted_sequence + 1 AS next_sequence,
      (SELECT event_id FROM public.alexios_v3_events e
       WHERE e.agent_id = synced.agent_id
         AND e.sequence = synced.last_processed_sequence + 1
         AND e.status IN ('pending', 'running')
       LIMIT 1) AS recovery_event_id
    FROM synced WHERE EXISTS (SELECT 1 FROM versioned)`,
    [agentId, runId],
  );
  if (!rows[0]) throw new AgentError(409, "Handshake V3 não autorizado.");
  return {
    nextSequence: numeric(rows[0].next_sequence),
    recoveryEventId: rows[0].recovery_event_id,
  };
}

export async function activityV3(raw: unknown) {
  const activity = parseActivity(raw);
  const {agentId, runId} = await authorizeV3(activity);
  const rows = await query<{activity_epoch: number | string}>(
    `WITH changed AS (
      UPDATE public.alexios_v3_streams st SET
        activity_epoch = GREATEST(st.activity_epoch, $3::bigint),
        updated_at = now()
      WHERE st.agent_id = $1::uuid AND st.active_run_id = $2::uuid
        AND EXISTS (
          SELECT 1 FROM public.alexios_sessions s
          WHERE s.agent_id = st.agent_id AND s.run_id = $2::uuid
            AND s.last_poll_at > now() - interval '45 seconds'
            AND s.protocol_version = 3
        )
      RETURNING agent_id, activity_epoch
    ), visual AS (
      UPDATE public.alexios_sessions s SET
        character_frame = 'listening', expression_id = 'listening',
        character_speaking_until = NULL, version = version + 1, updated_at = now()
      WHERE s.agent_id = $1::uuid AND EXISTS (SELECT 1 FROM changed)
      RETURNING agent_id
    )
    SELECT activity_epoch FROM changed WHERE EXISTS (SELECT 1 FROM visual)`,
    [agentId, runId, activity.activityEpoch],
  );
  if (!rows[0]) throw new AgentError(409, "Atividade rejeitada (V3 inativa).");
  return {accepted: true};
}

function eventPayload(event: IncomingEvent): Record<string, unknown> {
  if (event.type === "floor_open") {
    return {afterSequence: event.afterSequence, silenceMs: event.silenceMs};
  }
  return {
    turnId: event.turnId, speakerId: event.speakerId,
    transcript: event.transcript, startedAtMs: event.startedAtMs,
    endedAtMs: event.endedAtMs,
  };
}
function canon(obj: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

export async function acceptV3Event(raw: unknown, type: V3EventKind) {
  const event = parseV3Event(raw, type);
  const {agentId, runId} = await authorizeV3(event);
  const payload = eventPayload(event);
  type Existing = {agent_id: string; run_id: string; sequence: string | number;
                   event_type: string; activity_epoch: string | number;
                   payload: Record<string, unknown>};
  const old = await query<Existing>(
    "SELECT agent_id, run_id, sequence, event_type, activity_epoch, payload FROM public.alexios_v3_events WHERE event_id = $1::uuid",
    [event.eventId],
  );
  if (old[0]) {
    const previous = old[0];
    if (previous.agent_id !== agentId || previous.run_id !== runId ||
        numeric(previous.sequence) !== event.sequence ||
        previous.event_type !== type ||
        numeric(previous.activity_epoch) !== event.activityEpoch ||
        canon(previous.payload) !== canon(payload)) {
      throw new AgentError(409, "eventId reutilizado com conteúdo diferente.");
    }
    return {accepted: true, duplicate: true, eventId: event.eventId};
  }

  const rows = await query<{event_id: string}>(
    `WITH accepted AS (
      UPDATE public.alexios_v3_streams st SET
        last_accepted_sequence = $3::bigint, updated_at = now()
      WHERE st.agent_id = $1::uuid AND st.active_run_id = $2::uuid
        AND st.last_accepted_sequence = $3::bigint - 1
        AND EXISTS (
          SELECT 1 FROM public.alexios_sessions s
          WHERE s.agent_id = st.agent_id AND s.run_id = $2::uuid
            AND s.last_poll_at > now() - interval '45 seconds'
            AND s.protocol_version = 3
            AND ($4::text <> 'floor_open'
                 OR (s.power = 'running' AND s.desired_power = 'running'))
        )
        AND ($4::text <> 'floor_open'
          OR (st.activity_epoch = $5::bigint AND st.activity_epoch > 0
              AND NOT EXISTS (
                SELECT 1 FROM public.alexios_v3_events e
                WHERE e.agent_id = st.agent_id AND e.run_id = $2::uuid
                  AND e.activity_epoch = $5::bigint
                  AND e.event_type = 'floor_open'
              )))
      RETURNING agent_id
    ), inserted AS (
      INSERT INTO public.alexios_v3_events
        (event_id, agent_id, run_id, sequence, event_type, activity_epoch,
         turn_id, speaker_id, transcript, payload)
      SELECT $6::uuid, agent_id, $2::uuid, $3::bigint, $4, $5::bigint,
        $7::text, $8::text, $9::text, $10::jsonb
      FROM accepted
      RETURNING event_id
    )
    SELECT event_id FROM inserted`,
    [agentId, runId, event.sequence, type, event.activityEpoch,
     event.eventId, event.turnId ?? null, event.speakerId ?? null,
     event.transcript ?? null, JSON.stringify(payload)],
  );
  if (!rows[0]) {
    throw new AgentError(409, "Sequência inválida, run substituído ou abertura obsoleta.");
  }
  return {accepted: true, duplicate: false, eventId: rows[0].event_id};
}
