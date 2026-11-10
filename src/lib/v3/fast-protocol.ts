/** Pure V3 fast-lane rules. No database or provider dependency. */

export type FastResponseStatus =
  | "legacy" | "pending" | "running" | "published"
  | "silent" | "revoked" | "timed_out";

import type {Form} from "./protocol";
import {parseRespond, type RespondDecision} from "./model-protocol.ts";

export type FastDecision = RespondDecision;

export const FAST_FLOOR_TTL_MS = 9_000;
export const FAST_WORKER_TIMEOUT_MS = 11_000;

export function fastLaneEnabled(): boolean {
  return process.env.ALEXIOS_V3_FAST_ENABLED === "true";
}

export function parseFastDecision(raw: unknown, currentForm: Form = "men"): FastDecision {
  if (typeof raw !== "string") throw new Error("Fast model did not return text.");
  const decision = parseRespond(raw, currentForm);
  const speech = decision.shouldSpeak ? decision.speech.slice(0, 350) : "";
  return {...decision, shouldSpeak: decision.shouldSpeak && Boolean(speech), speech};
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
