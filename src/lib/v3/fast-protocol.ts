/** Pure V3 fast-lane rules. No database or provider dependency. */

export type FastResponseStatus =
  | "legacy" | "pending" | "running" | "published"
  | "silent" | "revoked" | "timed_out";

import type {Stance} from "./protocol";
import {MAX_CONTEXT_CHARS} from "./persona-core";

export type FastDecision = {
  context: string;
  stance: Stance;
  waitingVariant: 1 | 2;
  shouldSpeak: boolean;
  speech: string;
};

export const FAST_FLOOR_TTL_MS = 9_000;
export const FAST_WORKER_TIMEOUT_MS = 11_000;

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
  // The model must always return a refreshed rolling context and visual pose,
  // including when it decides silence.
  if (typeof value.context !== "string" || !value.context.trim() ||
      value.context.length > 6000 ||
      (value.stance !== "crossed-arm" && value.stance !== "hand-in-pocket") ||
      (value.waitingVariant !== 1 && value.waitingVariant !== 2)) {
    throw new Error("Fast response context/pose fields missing.");
  }
  const speech = value.shouldSpeak ? value.speech.trim().slice(0, 350) : "";
  return {
    context: value.context.trim().slice(0, MAX_CONTEXT_CHARS),
    stance: value.stance,
    waitingVariant: value.waitingVariant,
    shouldSpeak: value.shouldSpeak && speech.length > 0,
    speech,
  };
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
