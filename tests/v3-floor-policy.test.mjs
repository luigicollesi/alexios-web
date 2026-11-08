import {test} from "node:test";
import assert from "node:assert/strict";
import {floorRejectReason} from "../src/lib/v3/floor-policy.ts";

const valid = {
  runId: "run-active",
  activeRunId: "run-active",
  eventEpoch: 2,
  latestEpoch: 2,
  power: "running",
  desiredPower: "running",
  receivedAt: "2026-11-08T21:34:23.000Z",
};
const now = Date.parse("2026-11-08T21:34:36.000Z");

test("floor from user test is not obsolete by time or epoch alone", () => {
  assert.equal(floorRejectReason(valid, now), null);
});
test("floor rejects stopped microphone even with 13 seconds latency", () => {
  assert.equal(floorRejectReason({...valid, power: "stopped"}, now), "microphone_stopped");
});
test("floor rejects new speech independently of the client run", () => {
  assert.equal(floorRejectReason({...valid, latestEpoch: 3}, now), "new_speech");
});
test("floor rejects FIM without synthesizing an answer", () => {
  assert.equal(floorRejectReason({...valid, desiredPower: "stopped"}, now), "capture_disabled");
});
test("floor rejects superseded Python run", () => {
  assert.equal(floorRejectReason({...valid, activeRunId: "run-replaced"}, now), "run_replaced");
});
test("floor rejects old events and malformed timestamps", () => {
  assert.equal(floorRejectReason(valid, now + 40_000), "expired");
  assert.equal(floorRejectReason({...valid, receivedAt: "bad"}, now), "invalid_timestamp");
});
test("floor does not expire at 13 seconds when power is still running", () => {
  const later = Date.parse(valid.receivedAt) + 13_708;
  assert.equal(floorRejectReason(valid, later), null);
});
