import {test} from "node:test";
import assert from "node:assert/strict";
import {
  fastFloorEligible, parseFastDecision, fastFloorTerminal,
  FAST_FLOOR_TTL_MS, FAST_WORKER_TIMEOUT_MS,
} from "../src/lib/v3/fast-protocol.ts";

const now = Date.parse("2026-11-08T21:53:00Z");
const base = {
  runId: "run-A", activeRunId: "run-A",
  activityEpoch: 9, latestActivityEpoch: 9,
  power: "running", desiredPower: "running",
  pollFresh: true, receivedAtMs: now - 500, nowMs: now,
};

test("fast model accepts minimal JSON and trims excess text", () => {
  assert.deepEqual(parseFastDecision('{"shouldSpeak":true,"speech":"  Dois.  "}'),
    {shouldSpeak:true,speech:"Dois."});
  assert.deepEqual(parseFastDecision('{"shouldSpeak":false,"speech":"não pode aparecer"}'),
    {shouldSpeak:false,speech:""});
  assert.equal(parseFastDecision(JSON.stringify({
    shouldSpeak:true,speech:"x".repeat(700),
  })).speech.length,350);
});

test("malformed, missing, and cut-off model JSON cannot authorize speech", () => {
  assert.throws(() => parseFastDecision('{"shouldSpeak":true,"speech":"truncado'));
  assert.throws(() => parseFastDecision('{"speech":"oi"}'));
  assert.throws(() => parseFastDecision('fala sem JSON'));
  assert.deepEqual(parseFastDecision('{"shouldSpeak":true,"speech":"  "}'),
    {shouldSpeak:false,speech:""});
});

test("fast floor allows valid run and current speech epoch", () => {
  assert.equal(fastFloorEligible(base), true);
  assert.ok(FAST_FLOOR_TTL_MS >= 5000);
  assert.ok(FAST_WORKER_TIMEOUT_MS > FAST_FLOOR_TTL_MS);
});

test("new speech or FIM invalidates a fast response", () => {
  assert.equal(fastFloorEligible({...base,latestActivityEpoch:10}),false);
  assert.equal(fastFloorEligible({...base,desiredPower:"stopped"}),false);
  assert.equal(fastFloorEligible({...base,power:"stopped"}),false);
});

test("replaced run or disconnected agent invalidates response", () => {
  assert.equal(fastFloorEligible({...base,activeRunId:"run-B"}),false);
  assert.equal(fastFloorEligible({...base,pollFresh:false}),false);
});

test("stale floor expires, including model returning too late", () => {
  assert.equal(fastFloorEligible({...base,receivedAtMs:now-6_100}),false);
  assert.equal(fastFloorEligible({...base,receivedAtMs:now+10_000}),false);
  assert.equal(fastFloorEligible({...base,receivedAtMs:NaN}),false);
});

test("legacy floors are not mistaken for fast-lane completion", () => {
  assert.equal(fastFloorTerminal("legacy"),false);
  assert.equal(fastFloorTerminal("pending"),false);
  assert.equal(fastFloorTerminal("running"),false);
  for(const value of ["published","silent","revoked","timed_out"]) {
    assert.equal(fastFloorTerminal(value),true);
  }
});
