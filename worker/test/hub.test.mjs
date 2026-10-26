import test from "node:test";
import assert from "node:assert/strict";
import { AlexiosHub } from "../src/index.mjs";

test("agent poll, 4s transcriptions, contextual JSON, stop and resume", async () => {
  const data = new Map();
  let scheduledAlarm = null;
  const storage = {
    get: async (key) => data.get(key),
    put: async (key, value) => { data.set(key, structuredClone(value)); },
    getAlarm: async () => scheduledAlarm,
    setAlarm: async (when) => { scheduledAlarm = when; },
  };
  const hub = new AlexiosHub({ storage }, {
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    return Response.json({ choices: [{ message: {
      content: JSON.stringify({
        speech: "A janela está aberta?",
        pose: "speaking",
        context: "Foi feita uma pergunta sobre a janela.",
      }),
    } }] });
  };
  const url = (path) => new Request("https://hub.example" + path);
  const send = (path, body) => new Request("https://hub.example" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const first = await hub.fetch(url("/v1/agent/poll?instanceId=agent-test01&after=-1&speechAfter=-1"));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).desiredPower, "running");

    assert.equal((await hub.fetch(send("/v1/agent/state", {
      instanceId: "agent-test01", power: "running",
    }))).status, 200);

    const firstAudio = await hub.fetch(send("/v1/transcript", {
      instanceId: "agent-test01", captureId: "capture-01", windowIndex: 0,
      words: [{ text: "A", startMs: 100, endMs: 400 }, { text: "janela", startMs: 3500, endMs: 3900 }],
    }));
    assert.equal(firstAudio.status, 202);
    assert.equal((await firstAudio.json()).acceptedWords, 2);

    const secondAudio = await hub.fetch(send("/v1/transcript", {
      instanceId: "agent-test01", captureId: "capture-01", windowIndex: 1,
      words: [{ text: "janela", startMs: 3500, endMs: 3900 },
        { text: "aberta?", startMs: 4000, endMs: 4500 }],
    }));
    assert.equal((await secondAudio.json()).acceptedWords, 1);

    await hub.alarm();
    const status = await (await hub.fetch(url("/v1/status"))).json();
    assert.equal(status.core.expressionId, "speaking");
    assert.equal(status.core.speech.text, "A janela está aberta?");
    assert.equal(status.core.speech.seq, 1);

    const pollWithSpeech = await (await hub.fetch(url("/v1/agent/poll?instanceId=agent-test01&after=-1&speechAfter=0"))).json();
    assert.equal(pollWithSpeech.speech.text, "A janela está aberta?");

    const stop = await hub.fetch(send("/v1/power", {
      action: "stop", requestId: "550e8400-e29b-41d4-a716-446655440000",
    }));
    assert.equal(stop.status, 202);
    const command = await (await hub.fetch(url("/v1/agent/poll?instanceId=agent-test01&after=0&speechAfter=1"))).json();
    assert.equal(command.desiredPower, "stopped");

    await hub.fetch(send("/v1/agent/state", { instanceId: "agent-test01", power: "stopped" }));
    const blocked = await hub.fetch(send("/v1/transcript", {
      instanceId: "agent-test01", captureId: "capture-01", windowIndex: 2, words: [],
    }));
    assert.equal(blocked.status, 409);

    const resume = await hub.fetch(send("/v1/power", {
      action: "start", requestId: "550e8400-e29b-41d4-a716-446655440001",
    }));
    assert.equal(resume.status, 202);
    assert.equal((await (await hub.fetch(url("/v1/agent/poll?instanceId=agent-test01&after=1&speechAfter=1"))).json()).desiredPower, "running");
  } finally {
    globalThis.fetch = origFetch;
  }
});
