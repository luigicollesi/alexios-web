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

const complete = (fields) => JSON.stringify({
  context:"O usuário utiliza PostgreSQL no projeto.",
  stance:"hand-in-pocket",
  waitingVariant:1,
  ...fields,
});

test("fast model always returns memory and pose, including silence", () => {
  assert.deepEqual(parseFastDecision(complete({shouldSpeak:true,speech:"  Dois.  "})), {
    context:"O usuário utiliza PostgreSQL no projeto.",
    stance:"hand-in-pocket",
    waitingVariant:1,
    shouldSpeak:true,
    speech:"Dois.",
  });
  const silent = parseFastDecision(complete({shouldSpeak:false,speech:"ignorar"}));
  assert.equal(silent.shouldSpeak,false);
  assert.equal(silent.speech,"");
  assert.equal(silent.context,"O usuário utiliza PostgreSQL no projeto.");
  assert.equal(silent.stance,"hand-in-pocket");
  assert.equal(silent.waitingVariant,1);
  assert.equal(parseFastDecision(complete({shouldSpeak:true,speech:"x".repeat(700)}))
    .speech.length,350);
});

test("malformed, missing, and cut-off model JSON cannot authorize speech", () => {
  assert.throws(() => parseFastDecision('{"shouldSpeak":true,"speech":"truncado'));
  assert.throws(() => parseFastDecision('{"speech":"oi"}'));
  assert.throws(() => parseFastDecision('fala sem JSON'));
  assert.throws(() => parseFastDecision('{"shouldSpeak":true,"speech":"oi"}'));
  assert.throws(() => parseFastDecision(complete({context:""})));
  assert.throws(() => parseFastDecision(complete({stance:"invalid"})));
  const noSpeech = parseFastDecision(complete({shouldSpeak:true,speech:"  "}));
  assert.equal(noSpeech.shouldSpeak,false);
  assert.equal(noSpeech.speech,"");

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
  assert.equal(fastFloorEligible({...base,receivedAtMs:now-FAST_FLOOR_TTL_MS-100}),false);
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
