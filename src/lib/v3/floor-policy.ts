/** Pure, testable conditions for authorizing a speaking opportunity. */
export type FloorRejectReason =
  | "run_replaced"
  | "new_speech"
  | "microphone_stopped"
  | "capture_disabled"
  | "expired"
  | "invalid_timestamp";

export type FloorState = {
  runId: string;
  activeRunId: string;
  eventEpoch: number;
  latestEpoch: number;
  power: string;
  desiredPower: string;
  receivedAt: string;
};

/** Preserve hard gating: FIM and new activity always cancel an old floor. */
export function floorRejectReason(
  state: FloorState, now = Date.now(), lifetimeMs = 40_000,
): FloorRejectReason | null {
  if (state.activeRunId !== state.runId) return "run_replaced";
  if (state.latestEpoch !== state.eventEpoch) return "new_speech";
  if (state.power !== "running") return "microphone_stopped";
  if (state.desiredPower !== "running") return "capture_disabled";
  const received = Date.parse(state.receivedAt);
  if (!Number.isFinite(received) || received > now + 5_000) return "invalid_timestamp";
  if (now - received >= lifetimeMs) return "expired";
  return null;
}
