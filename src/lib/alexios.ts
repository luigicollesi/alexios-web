export type CorePower = "running" | "stopped" | "starting" | "stopping" | "unknown";
export type ExpressionId = "idle" | "listening" | "thinking" | "speaking";
export type PowerAction = "start" | "stop";

export interface AlexiosStatus {
  agent: {
    connected: boolean;
    pollingActive: boolean;
    lastPollAt: string | null;
    instanceId: string | null;
  };
  core: {
    power: CorePower;
    expressionId: ExpressionId;
    speech: { seq: number; text: string; at: string | null };
    lastAiAt: string | null;
    lastError: string | null;
  };
  receivedAt: string;
}

export type PowerView = "offline" | "running" | "stopped" | "transitioning";

const VALID_POWER: CorePower[] = ["running", "stopped", "starting", "stopping", "unknown"];
const VALID_EXPRESSIONS: ExpressionId[] = ["idle", "listening", "thinking", "speaking"];
export const POLLING_FRESHNESS_MS = 45_000;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeStatus(payload: unknown, now = Date.now()): AlexiosStatus {
  const root = object(payload);
  const agent = object(root.agent);
  const core = object(root.core);
  const rawPoll = typeof agent.lastPollAt === "string" ? agent.lastPollAt : null;
  const pollTime = rawPoll === null ? NaN : Date.parse(rawPoll);
  // Offline is fail-safe: a stale heartbeat or an incomplete lease never enables controls.
  const fresh = Number.isFinite(pollTime) && pollTime <= now + 5_000 &&
    now - pollTime <= POLLING_FRESHNESS_MS;

  const connected = agent.connected === true && agent.pollingActive === true && fresh;
  const rawPower = core.power;
  const power: CorePower =
    typeof rawPower === "string" && VALID_POWER.includes(rawPower as CorePower)
      ? (rawPower as CorePower)
      : "unknown";
  const rawExpression = core.expressionId;
  const expressionId: ExpressionId =
    typeof rawExpression === "string" && VALID_EXPRESSIONS.includes(rawExpression as ExpressionId)
      ? (rawExpression as ExpressionId)
      : "idle";

  const speech = object(core.speech);
  const seq = typeof speech.seq === "number" && Number.isSafeInteger(speech.seq) && speech.seq >= 0 ? speech.seq : 0;

  return {
    agent: {
      connected,
      pollingActive: connected,
      lastPollAt: rawPoll,
      instanceId: typeof agent.instanceId === "string" ? agent.instanceId.slice(0, 80) : null,
    },
    core: {
      power, expressionId,
      speech: {
        seq,
        text: typeof speech.text === "string" ? speech.text.slice(0, 600) : "",
        at: typeof speech.at === "string" ? speech.at : null,
      },
      lastAiAt: typeof core.lastAiAt === "string" ? core.lastAiAt : null,
      lastError: typeof core.lastError === "string" ? core.lastError.slice(0, 180) : null,
    },
    receivedAt: new Date(now).toISOString(),
  };
}

export function derivePowerView(status: AlexiosStatus | null): PowerView {
  if (!status?.agent.connected) return "offline";
  if (status.core.power === "running") return "running";
  if (status.core.power === "stopped") return "stopped";
  return "transitioning";
}

export const EXPRESSION_LABELS: Record<ExpressionId, string> = {
  idle: "AGUARDANDO",
  listening: "ESCUTANDO",
  thinking: "PROCESSANDO",
  speaking: "RESPONDENDO",
};
