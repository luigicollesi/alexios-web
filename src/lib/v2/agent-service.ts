import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { AgentError, leaseIsFresh, numeric, query, type AgentSession, type Word } from "@/lib/agent-db";
import { mergeWindow, parseTranscription } from "@/lib/merge-window";

const POLL_MS = 20_000;
const LEASE_SECONDS = 45;
export const MAX_INSTANCE_LENGTH = 80;

export type V2Session = AgentSession & { agent_id: string; run_id: string | null };
type Identity = { id: string };

export function validateInstance(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(value)) {
    throw new AgentError(400, "Identificador da instancia invalido.");
  }
  return value;
}

export function validateRun(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AgentError(400, "Identificador de execucao invalido.");
  }
  return value;
}

export function keyedDigest(value: string): string {
  const key = process.env.ALEXIOS_INSTANCE_HASH_KEY;
  if (!key || key.length < 32) throw new AgentError(503, "Chave de identificadores nao configurada.");
  return createHmac("sha256", key).update(value).digest("hex");
}

export async function findInstance(instanceId: string): Promise<Identity | null> {
  const rows = await query<Identity>(
    "SELECT id FROM public.alexios_instances WHERE instance_hash = $1",
    [keyedDigest(validateInstance(instanceId))],
  );
  return rows[0] ?? null;
}

export async function registerInstance(instanceId: string): Promise<Identity> {
  const hash = keyedDigest(validateInstance(instanceId));
  const rows = await query<Identity>(
    `INSERT INTO public.alexios_instances (instance_hash)
     VALUES ($1) ON CONFLICT (instance_hash)
     DO UPDATE SET updated_at = now() RETURNING id`,
    [hash],
  );
  const agent = rows[0];
  if (!agent) throw new AgentError(503, "Nao foi possivel registrar a instancia.");
  await query(
    `INSERT INTO public.alexios_sessions (session_id, agent_id)
     VALUES ($1, $2::uuid) ON CONFLICT (session_id) DO NOTHING`,
    [agent.id, agent.id],
  );
  return agent;
}

export async function sessionFor(agentId: string): Promise<V2Session> {
  const rows = await query<V2Session>(
    "SELECT * FROM public.alexios_sessions WHERE agent_id = $1::uuid",
    [agentId],
  );
  if (!rows[0]) throw new AgentError(503, "Sessao da instancia ausente.");
  return rows[0];
}

export function connected(row: AgentSession): boolean {
  return leaseIsFresh(row.last_poll_at);
}

function checkLease(row: V2Session, runId: string): void {
  if (row.run_id !== runId || !connected(row)) {
    throw new AgentError(409, "Instancia desconectada ou controlada por outra execucao.");
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentError(400, "Corpo JSON invalido.");
  }
  return value as Record<string, unknown>;
}

export async function pollV2(payload: unknown, signal: AbortSignal) {
  const body = parseObject(payload);
  const instanceId = validateInstance(body.instanceId);
  const runId = validateRun(body.runId);
  const after = body.after;
  if (typeof after !== "number" || !Number.isSafeInteger(after) || after < -1) {
    throw new AgentError(400, "Cursor de comandos invalido.");
  }

  const agent = await registerInstance(instanceId);
  const updated = await query<V2Session>(
    `UPDATE public.alexios_sessions SET
       run_id = $2::uuid, last_poll_at = now(), updated_at = now()
     WHERE agent_id = $1::uuid
       AND (run_id = $2::uuid OR last_poll_at IS NULL
            OR last_poll_at < now() - interval '${LEASE_SECONDS} seconds')
     RETURNING *`,
    [agent.id, runId],
  );
  if (!updated[0]) throw new AgentError(409, "Esta instancia ja possui outro processo conectado.");

  let row = updated[0];
  const started = Date.now();
  while (numeric(row.command_seq) === after && Date.now() - started < POLL_MS && !signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    row = await sessionFor(agent.id);
    if (row.run_id !== runId) throw new AgentError(409, "A execucao ativa foi substituida.");
  }
  return {
    commandSeq: numeric(row.command_seq),
    captureEnabled: row.desired_power === "running",
  };
}

export async function reportStateV2(payload: unknown) {
  const body = parseObject(payload);
  const instanceId = validateInstance(body.instanceId);
  const runId = validateRun(body.runId);
  const state = body.power;
  if (state !== "running" && state !== "stopped" && state !== "starting" && state !== "stopping") {
    throw new AgentError(400, "Estado de captura invalido.");
  }
  const agent = await findInstance(instanceId);
  if (!agent) throw new AgentError(409, "Instancia nao registrada.");
  const row = await sessionFor(agent.id);
  checkLease(row, runId);
  const rows = await query<{power:string}>(
    `UPDATE public.alexios_sessions SET
      power = $3, version = version + 1, updated_at = now()
     WHERE agent_id = $1::uuid AND run_id = $2::uuid
       AND last_poll_at >= now() - interval '${LEASE_SECONDS} seconds'
       AND ($3 = 'stopped'
         OR ($3 IN ('running','starting') AND desired_power = 'running')
         OR ($3 = 'stopping' AND desired_power = 'stopped'))
     RETURNING power`,
    [agent.id, runId, state],
  );
  if (!rows[0]) throw new AgentError(409, "Comando mudou durante a confirmacao.");
  return { ok: true, power: rows[0].power };
}

export async function uploadV2(payload: unknown) {
  const body = parseObject(payload);
  const input = parseTranscription(body);
  const instanceId = validateInstance(input.instanceId);
  const runId = validateRun(body.runId);
  const agent = await findInstance(instanceId);
  if (!agent) throw new AgentError(409, "Instancia nao registrada.");

  for (let attempt = 0; attempt < 7; attempt++) {
    const row = await sessionFor(agent.id);
    checkLease(row, runId);
    if (row.power !== "running" || row.desired_power !== "running") {
      throw new AgentError(409, "Captura desligada.");
    }
    if (row.blocked_capture_id === input.captureId) {
      throw new AgentError(409, "Captura anterior encerrada.");
    }
    if ((!row.capture || row.capture.id !== input.captureId) && input.windowIndex !== 0) {
      throw new AgentError(409, "Primeira janela da captura ausente.");
    }
    if (row.capture?.id === input.captureId && input.windowIndex <= row.capture.index) {
      return { acceptedWords: 0, windowIndex: input.windowIndex };
    }
    const { capture, accepted } = mergeWindow(row.capture, input.captureId, input.windowIndex, input.words);
    const pending: Word[] = [...row.pending_words, ...accepted].slice(-420);
    const result = await query<{version:string|number}>(
      `UPDATE public.alexios_sessions SET
       capture = $3::jsonb, pending_words = $4::jsonb,
       version = version + 1, updated_at = now()
       WHERE agent_id = $1::uuid AND run_id = $2::uuid AND version = $5
         AND power = 'running' AND desired_power = 'running'
         AND last_poll_at >= now() - interval '${LEASE_SECONDS} seconds'
       RETURNING version`,
      [agent.id, runId, JSON.stringify(capture), JSON.stringify(pending), row.version],
    );
    if (result[0]) return { acceptedWords: accepted.length, windowIndex: input.windowIndex };
  }
  throw new AgentError(409, "Concorrencia na transcricao; tente outra janela.");
}

export async function powerV2(agentId: string, action: "start" | "stop", requestId: string) {
  const row = await sessionFor(agentId);
  if (!connected(row)) throw new AgentError(409, "Instancia desconectada.");
  const desired = action === "start" ? "running" : "stopped";
  const expected = action === "start" ? "stopped" : "running";
  const changed = await query<{session_id:string}>(
    `UPDATE public.alexios_sessions SET
       desired_power = $2, command_seq = command_seq + 1,
       epoch = epoch + 1,
       pending_words = '[]'::jsonb, inference_words = '[]'::jsonb,
       capture = NULL,
       blocked_capture_id = CASE WHEN $2 = 'stopped' THEN capture->>'id' ELSE blocked_capture_id END,
       inference_token = NULL, inference_started_at = NULL,
       expression_id = CASE WHEN $2 = 'stopped' THEN 'idle' ELSE expression_id END,
       version = version + 1, updated_at = now()
     WHERE agent_id = $1::uuid AND power = $3 AND desired_power <> $2
       AND last_poll_at >= now() - interval '${LEASE_SECONDS} seconds'
     RETURNING session_id`,
    [agentId, desired, expected],
  );
  if (!changed.length) throw new AgentError(409, "Estado mudou ou comando indisponivel.");
  await query(
    `INSERT INTO public.alexios_power_requests(request_id, session_id, action)
     VALUES ($1::uuid, $2, $3) ON CONFLICT DO NOTHING`,
    [requestId, changed[0].session_id, action],
  );
  return { accepted: true, requestId };
}

export async function statusV2(agentId: string) {
  const row = await sessionFor(agentId);
  const isConnected = connected(row);
  return {
    agent: {
      connected: isConnected,
      pollingActive: isConnected,
      lastPollAt: row.last_poll_at,
      instanceId: null, // Nunca expor o segredo no navegador.
    },
    core: {
      power: row.power,
      expressionId: row.expression_id,
      speech: {
        seq: numeric(row.speech_seq),
        text: row.speech_text,
        at: row.speech_at,
      },
      lastAiAt: row.last_ai_at,
      lastError: row.last_error,
    },
  };
}
