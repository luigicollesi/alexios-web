/** Pure V3 fast-lane rules. No database or provider dependency. */

export type FastResponseStatus =
  | "legacy" | "pending" | "running" | "published"
  | "silent" | "revoked" | "timed_out";

export type FastDecision = {shouldSpeak: boolean; speech: string};

export const FAST_FLOOR_TTL_MS = 6_000;
export const FAST_WORKER_TIMEOUT_MS = 8_000;

export function fastLaneEnabled(): boolean {
  // Explicit opt-in: deployment can roll back instantly to the queued V3.
  return process.env.ALEXIOS_V3_FAST_ENABLED === "true";
}

export function parseFastDecision(raw: unknown): FastDecision {
  if (typeof raw !== "string") throw new Error("Fast model did not return text.");
  const data: unknown = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Fast model returned a non-object JSON.");
  }
  const value = data as Record<string, unknown>;
  if (typeof value.shouldSpeak !== "boolean" || typeof value.speech !== "string") {
    throw new Error("Fast response JSON fields missing.");
  }
  const speech = value.shouldSpeak ? value.speech.trim().slice(0, 350) : "";
  return {shouldSpeak: value.shouldSpeak && speech.length > 0, speech};
}

export function fastFloorEligible(params: {
  runId: string;
  activeRunId: string;
  activityEpoch: number;
  latestActivityEpoch: number;
  power: string;
  desiredPower: string;
  pollFresh: boolean;
  receivedAtMs: number;
  nowMs: number;
}): boolean {
  return params.runId === params.activeRunId &&
    params.activityEpoch === params.latestActivityEpoch &&
    params.power === "running" &&
    params.desiredPower === "running" &&
    params.pollFresh &&
    Number.isFinite(params.receivedAtMs) &&
    params.nowMs >= params.receivedAtMs &&
    params.nowMs - params.receivedAtMs < FAST_FLOOR_TTL_MS;
}

export function fastFloorTerminal(status: FastResponseStatus): boolean {
  return status === "published" || status === "silent" ||
    status === "revoked" || status === "timed_out";
}
