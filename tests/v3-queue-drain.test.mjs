import {test} from "node:test";
import assert from "node:assert/strict";
import {wakeNextPendingV3} from "../src/lib/v3/drain-logic.ts";

test("wakes the next pending event using predecessor-specific idempotency", async () => {
  const calls = [];
  const next = await wakeNextPendingV3("event-22", async (from) => {
    assert.equal(from, "event-22");
    return "event-23";
  }, async (eventId, key) => {
    calls.push({eventId, key});
  });
  assert.equal(next, "event-23");
  assert.deepEqual(calls, [{
    eventId: "event-23",
    key: "v3-drain-event-22",
  }]);
});

test("does not publish when the Neon stream has no next pending event", async () => {
  let calls = 0;
  const result = await wakeNextPendingV3("event-26", async () => null,
    async () => { calls += 1; });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("propagates publishing errors so the queue callback retries after commit", async () => {
  await assert.rejects(
    wakeNextPendingV3("event-22", async () => "event-23", async () => {
      throw new Error("Vercel Queues indisponível");
    }),
    /Vercel Queues indisponível/,
  );
});

test("iterates sequentially over pending turns and floor without skipping events", async () => {
  const chain = new Map([
    ["event-22", "event-23"],
    ["event-23", "event-24"],
    ["event-24", "event-25"],
    ["event-25", "event-26"],
  ]);
  const published = [];
  let last = "event-22";
  while (true) {
    const next = await wakeNextPendingV3(last, async (from) => chain.get(from) ?? null,
      async (id) => { published.push(id); });
    if (!next) break;
    last = next;
  }
  assert.deepEqual(published, ["event-23", "event-24", "event-25", "event-26"]);
});

test("idempotency key is stable for redelivery of same predecessor", async () => {
  const keys = [];
  for (let i = 0; i < 2; i++) {
    await wakeNextPendingV3("event-22", async () => "event-23",
      async (_id, key) => { keys.push(key); });
  }
  assert.deepEqual(keys, ["v3-drain-event-22", "v3-drain-event-22"]);
});
