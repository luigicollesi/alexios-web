import "server-only";
import { randomUUID } from "node:crypto";
import { AgentError, assertInstance, assertLease, leaseIsFresh, numeric, query, session,
  type AgentSession, type AgentPower, type Word } from "@/lib/agent-db";
import { parseTranscription, mergeWindow } from "@/lib/merge-window";
import { askModel } from "@/lib/ambient-model";

const SESSION_ID = "primary";
const WAIT_MS = 20_000;
const AGENT_HEARTBEAT_MS = 45_000;

function iso(value: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(String(value));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export async function readStatus() {
  const row = await session();
  const connected = leaseIsFresh(row.last_poll_at);
  return {
    agent: {
      connected,
      pollingActive: connected,
      lastPollAt: iso(row.last_poll_at),
      instanceId: row.instance_id,
    },
    core: {
      power: row.power,
      expressionId: row.expression_id,
      speech: { seq: numeric(row.speech_seq), text: row.speech_text, at: iso(row.speech_at) },
      lastAiAt: iso(row.last_ai_at),
      lastError: row.last_error,
    },
  };
}

export async function pollAgent(instanceId: unknown, after: number, speechAfter: number,
                                signal: AbortSignal) {
  assertInstance(instanceId);
  if (!Number.isSafeInteger(after) || !Number.isSafeInteger(speechAfter) ||
      after < -1 || speechAfter < -1) {
    throw new AgentError(400, "Cursores de polling inválidos.");
  }
  const rows = await query<AgentSession>(
    `UPDATE public.alexios_sessions
      SET instance_id = $1, last_poll_at = now(), updated_at = now()
      WHERE session_id = $2
        AND (instance_id = $1 OR last_poll_at IS NULL
             OR last_poll_at < now() - interval '45 seconds')
      RETURNING *`,
    [instanceId, SESSION_ID],
  );
  if (!rows[0]) throw new AgentError(409, "Outro Agent mantém a conexão ativa.");

  const started = Date.now();
  let row = rows[0];
  while (numeric(row.command_seq) === after && numeric(row.speech_seq) === speechAfter &&
         Date.now() - started < WAIT_MS && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    row = await session();
    if (row.instance_id !== instanceId) throw new AgentError(409, "A conexão mudou de Agent.");
  }
  return {
    commandSeq: numeric(row.command_seq),
    desiredPower: row.desired_power,
    speechSeq: numeric(row.speech_seq),
    speech: speechAfter >= 0 && numeric(row.speech_seq) > speechAfter
      ? { seq: numeric(row.speech_seq), text: row.speech_text, at: iso(row.speech_at) }
      : null,
  };
}

export async function reportState(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new AgentError(400, "Estado inválido.");
  }
  const { instanceId, power } = payload as Record<string, unknown>;
  assertInstance(instanceId);
  if (!["running", "stopped", "starting", "stopping"].includes(String(power))) {
    throw new AgentError(400, "Estado de energia inválido.");
  }
  const rows = await query<{ power: AgentPower }>(
    `UPDATE public.alexios_sessions
      SET power = $2,
          expression_id = CASE WHEN $2 = 'stopped' THEN 'idle' ELSE expression_id END,
          last_poll_at = now(), version = version + 1, updated_at = now()
      WHERE session_id = $3 AND instance_id = $1
        AND last_poll_at >= now() - interval '45 seconds'
        AND ($2 = 'stopped' OR
             ($2 IN ('running','starting') AND desired_power = 'running') OR
             ($2 = 'stopping' AND desired_power = 'stopped'))
      RETURNING power`,
    [instanceId, power, SESSION_ID],
  );
  if (!rows.length) throw new AgentError(409, "Estado desatualizado ou Agent desconectado.");
  return { ok: true, power: rows[0].power };
}

export async function changePower(action: "start" | "stop", requestId: string) {
  const desired = action === "start" ? "running" : "stopped";
  const expected = action === "start" ? "stopped" : "running";
  const results = await query<{ changed: boolean }>(
    `WITH changed AS (
      UPDATE public.alexios_sessions SET
        desired_power = $1,
        command_seq = command_seq + 1,
        epoch = epoch + 1,
        pending_words = '[]'::jsonb,
        inference_words = '[]'::jsonb,
        capture = NULL,
        blocked_capture_id = CASE WHEN $1 = 'stopped' THEN capture->>'id' ELSE blocked_capture_id END,
        inference_token = NULL,
        inference_started_at = NULL,
        expression_id = CASE WHEN $1 = 'stopped' THEN 'idle' ELSE expression_id END,
        last_error = NULL,
        version = version + 1,
        updated_at = now()
      WHERE session_id = $3 AND power = $2 AND desired_power <> $1
        AND last_poll_at >= now() - interval '45 seconds'
        AND NOT EXISTS (SELECT 1 FROM public.alexios_power_requests WHERE request_id = $4::uuid)
      RETURNING session_id
    ), receipt AS (
      INSERT INTO public.alexios_power_requests(request_id, session_id, action)
      SELECT $4::uuid, session_id, $5 FROM changed
      ON CONFLICT (request_id) DO NOTHING RETURNING request_id
    )
    SELECT EXISTS (SELECT 1 FROM receipt) AS changed`,
    [desired, expected, SESSION_ID, requestId, action],
  );
  if (results[0]?.changed) return { accepted: true, requestId };
  const duplicate = await query<{ action: string }>(
    "SELECT action FROM public.alexios_power_requests WHERE request_id = $1::uuid",
    [requestId],
  );
  if (duplicate[0]?.action === action) return { accepted: true, requestId };
  throw new AgentError(409, "O estado do Core mudou. Atualize o painel.");
}

export async function saveTranscription(payload: unknown) {
  const input = parseTranscription(payload);
  assertInstance(input.instanceId);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const row = await session();
    assertLease(row, input.instanceId);
    if (row.power !== "running" || row.desired_power !== "running") {
      throw new AgentError(409, "A escuta está desligada.");
    }
    if (row.blocked_capture_id === input.captureId) {
      throw new AgentError(409, "Geração de captura encerrada.");
    }
    if ((!row.capture || row.capture.id !== input.captureId) && input.windowIndex !== 0) {
      throw new AgentError(409, "Primeira janela da nova captura ausente.");
    }
    const { capture, accepted } = mergeWindow(row.capture, input.captureId, input.windowIndex, input.words);
    if (row.capture?.id === input.captureId && input.windowIndex <= row.capture.index) {
      return { acceptedWords: 0, windowIndex: input.windowIndex };
    }
    const pending = [...row.pending_words, ...accepted].slice(-420);
    const updated = await query<{ version: string | number }>(
      `UPDATE public.alexios_sessions SET
         capture = $1::jsonb, pending_words = $2::jsonb,
         version = version + 1, updated_at = now()
       WHERE session_id = $3 AND version = $4
         AND power = 'running' AND desired_power = 'running'
         AND instance_id = $5 AND last_poll_at >= now() - interval '45 seconds'
       RETURNING version`,
      [JSON.stringify(capture), JSON.stringify(pending), SESSION_ID, row.version, input.instanceId],
    );
    if (updated.length) return { acceptedWords: accepted.length, windowIndex: input.windowIndex };
  }
  throw new AgentError(409, "Conflito de transcrição. Reinicie esta captura.");
}

export async function analyzeContext(instanceId: unknown) {
  assertInstance(instanceId);
  const state = await session();
  assertLease(state, instanceId);
  if (state.power !== "running" || state.desired_power !== "running") {
    throw new AgentError(409, "A escuta está desligada.");
  }
  const token = randomUUID();
  // Atomic claim: retain already-claimed words on timeout; allow only one inference.
  const claimed = await query<{
    inference_words: Word[];
    context_text: string;
    expression_id: AgentSession["expression_id"];
    epoch: number | string;
  }>(
    `UPDATE public.alexios_sessions SET
       inference_words = CASE WHEN inference_token IS NULL
                              THEN pending_words ELSE inference_words || pending_words END,
       pending_words = '[]'::jsonb,
       inference_token = $1::uuid,
       inference_started_at = now(),
       version = version + 1, updated_at = now()
     WHERE session_id = $2 AND instance_id = $3
       AND power = 'running' AND desired_power = 'running'
       AND last_poll_at >= now() - interval '45 seconds'
       AND (inference_token IS NULL OR inference_started_at < now() - interval '120 seconds')
       AND (jsonb_array_length(pending_words) > 0 OR jsonb_array_length(inference_words) > 0)
     RETURNING inference_words, context_text, expression_id, epoch`,
    [token, SESSION_ID, instanceId],
  );
  if (!claimed.length) return { accepted: false, reason: "silent-or-processing" };
  const { inference_words: words, context_text: oldContext, expression_id: pose, epoch } = claimed[0];

  try {
    const decision = await askModel(oldContext, pose, words);
    const rows = await query<{ session_id: string }>(
      `WITH committed AS (
         UPDATE public.alexios_sessions SET
           context_text = $1,
           expression_id = $2,
           speech_text = CASE WHEN $3 = '' THEN speech_text ELSE $3 END,
           speech_seq = speech_seq + CASE WHEN $3 = '' THEN 0 ELSE 1 END,
           speech_at = CASE WHEN $3 = '' THEN speech_at ELSE now() END,
           last_ai_at = now(), last_error = NULL,
           inference_token = NULL, inference_started_at = NULL,
           inference_words = '[]'::jsonb,
           version = version + 1, updated_at = now()
         WHERE session_id = $4 AND inference_token = $5::uuid AND epoch = $6
           AND desired_power = 'running' AND power = 'running'
         RETURNING session_id, context_text, expression_id
       ), logged AS (
         INSERT INTO public.alexios_inference_history(session_id, speech, pose, context_text)
         SELECT session_id, $3, expression_id, context_text FROM committed RETURNING id
       )
       SELECT session_id FROM committed`,
      [decision.context || oldContext, decision.pose, decision.speech, SESSION_ID, token, epoch],
    );
    if (!rows.length) return { accepted: false, reason: "superseded" };
    return { accepted: true, spoke: !!decision.speech, pose: decision.pose };
  } catch (error) {
    const issue = error instanceof Error ? error.message : "Falha de inferência";
    await query(
      `UPDATE public.alexios_sessions SET
         pending_words = inference_words || pending_words,
         inference_words = '[]'::jsonb,
         inference_token = NULL, inference_started_at = NULL,
         last_error = $1, version = version + 1, updated_at = now()
       WHERE session_id = $2 AND inference_token = $3::uuid AND epoch = $4
         AND desired_power = 'running'`,
      [issue.slice(0, 160), SESSION_ID, token, epoch],
    );
    // Do not discard the context. Reattempt words on the next 8s cycle.
    throw new AgentError(502, "Não foi possível atualizar o contexto da IA.");
  }
}

export function networkError(error: unknown) {
  const status = error instanceof AgentError ? error.status : 503;
  const message = error instanceof AgentError ? error.message : "Falha no backend de contexto.";
  return Response.json({ error: message }, {
    status, headers: { "Cache-Control": "no-store" },
  });
}

export const AGENT_LEASE_MS = AGENT_HEARTBEAT_MS;
