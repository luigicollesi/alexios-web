import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CARTESIA_VOICE_ID, parseCartesiaKeys, CartesiaKeyRing, cartesiaOutOfCredit,
} from "../src/lib/tts/key-manager.ts";
import { PcmF32Chunker } from "../src/lib/tts/pcm.ts";
import { currentSpeechForTts } from "../src/lib/tts/speech-gate.ts";
import { playbackAvatar } from "../src/lib/tts/voice-avatar.ts";
import { shouldInterruptForConfirmedTurn } from "../src/lib/tts/interruption-policy.ts";

test("voice is pinned to Rafael and comma-separated keys are ordered and unique", () => {
  assert.equal(CARTESIA_VOICE_ID, "07b6f895-78b9-4921-8e10-8a21c99c2e8a");
  assert.deepEqual(parseCartesiaKeys(" sk_car_1, ,sk_car_2,sk_car_1 , sk_car_3 "), [
    "sk_car_1", "sk_car_2", "sk_car_3",
  ]);
  assert.deepEqual(parseCartesiaKeys(undefined), []);
});

test("out-of-credit key is skipped until cooldown expires, preserving order", () => {
  const ring = new CartesiaKeyRing(["one", "two", "three"], 1000);
  assert.deepEqual(ring.candidates(100), ["one", "two", "three"]);
  ring.markExhausted("one", 100);
  assert.deepEqual(ring.candidates(101), ["two", "three"]);
  ring.markExhausted("two", 110);
  assert.deepEqual(ring.candidates(111), ["three"]);
  ring.markExhausted("three", 120);
  assert.deepEqual(ring.candidates(121), []);
  assert.deepEqual(ring.candidates(1200), ["one", "two", "three"]);
  ring.markExhausted("unknown", 1234);
  assert.deepEqual(ring.candidates(1300), ["one", "two", "three"]);
});

test("failover only on credit/quota errors; not invalid keys, concurrency, or 5xx", () => {
  assert.equal(cartesiaOutOfCredit(402, { error_code: "quota_exceeded", message: "Out of credits" }), true);
  assert.equal(cartesiaOutOfCredit(429, { error_code: "quota_exceeded" }), true);
  assert.equal(cartesiaOutOfCredit(402, { message: "Insufficient credits" }), true);
  for (const [status, body] of [
    [429, { error_code: "concurrency_limited" }],
    [401, { error_code: "invalid_api_key" }],
    [403, { error_code: "voice_not_found" }],
    [500, { error_code: "internal_error" }],
    [429, { message: "Rate limit" }],
    [402, { message: "Upgrade plan" }],
  ]) {
    assert.equal(cartesiaOutOfCredit(status, body), false);
  }
});

function rawFloatBytes(samples) {
  const bytes = new Uint8Array(samples.length * 4);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true));
  return bytes;
}

test("raw PCM f32le can be split on arbitrary byte boundaries without corruption", () => {
  const pcm = new PcmF32Chunker(2);
  const bytes = rawFloatBytes([0.5, -0.25, 1, -1, 0.125]);
  assert.deepEqual(pcm.push(bytes.slice(0, 3)), []);
  assert.deepEqual(pcm.push(bytes.slice(3, 7)), []);
  const first = pcm.push(bytes.slice(7, 11));
  assert.equal(first.length, 1);
  assert.deepEqual([...first[0]], [0.5, -0.25]);
  const second = pcm.push(bytes.slice(11));
  assert.equal(second.length, 1);
  assert.deepEqual([...second[0]], [1, -1]);
  assert.deepEqual([...pcm.flush()], [0.125]);
  assert.equal(pcm.flush(), null);
});

test("truncated PCM samples are rejected; invalid floats are rendered as silence", () => {
  const pcm = new PcmF32Chunker(2);
  assert.deepEqual(pcm.push(new Uint8Array([0, 0, 0])), []);
  assert.throws(() => pcm.flush(), /Incomplete PCM/);
  assert.throws(() => new PcmF32Chunker(0), /Invalid PCM/);
  const silence = new PcmF32Chunker(1);
  assert.deepEqual([...silence.push(rawFloatBytes([Number.NaN]))[0]], [0]);
});

function status(now) {
  return {
    agent: { connected: true },
    core: {
      power: "running",
      protocolVersion: 3,
      speech: {
        seq: 12, text: "Olá, Luigi.",
        at: new Date(now - 800).toISOString(),
      },
    },
    conversation: {
      activityEpoch: 17,
      lastTurn: { receivedAt: new Date(now - 4_000).toISOString() },
    },
  };
}

test("TTS can only synthesize the current fresh response for the current epoch", () => {
  const now = Date.now();
  const valid = status(now);
  assert.equal(currentSpeechForTts(valid, 12, 17, now), "Olá, Luigi.");
  assert.equal(currentSpeechForTts(valid, 11, 17, now), null);
  assert.equal(currentSpeechForTts(valid, 12, 18, now), null);
  assert.equal(currentSpeechForTts({...valid, agent: { connected: false }}, 12, 17, now), null);
  assert.equal(currentSpeechForTts({...valid, core: {...valid.core, power: "stopped"}}, 12, 17, now), null);
  assert.equal(currentSpeechForTts({...valid, core: {...valid.core, protocolVersion: 2}}, 12, 17, now), null);
});

test("newer input turn invalidates old audio; very old or empty replies are refused", () => {
  const now = Date.now();
  const valid = status(now);
  const laterInput = {
    ...valid, conversation: {
      activityEpoch: 17, lastTurn: { receivedAt: new Date(now - 300).toISOString() },
    },
  };
  assert.equal(currentSpeechForTts(laterInput, 12, 17, now), null);
  const expired = {
    ...valid, core: {
      ...valid.core,
      speech: {...valid.core.speech, at: new Date(now - 20_000).toISOString()},
    },
  };
  assert.equal(currentSpeechForTts(expired, 12, 17, now), null);
  const empty = {
    ...valid, core: {
      ...valid.core, speech: {...valid.core.speech, text: "  "},
    },
  };
  assert.equal(currentSpeechForTts(empty, 12, 17, now), null);
});

test("speaking pose tracks actual playback, not the server's estimated timer", () => {
  const original = {
    stance: "hand-in-pocket",
    frame: "speaking",
    src: "/characters/stand/hand-in-pocket/speaking.png",
  };
  const before = playbackAvatar("speaking", original, true, false);
  assert.equal(before.expression, "idle");
  assert.equal(before.visual.frame, "waiting_1");
  const playing = playbackAvatar("idle", original, true, true);
  assert.equal(playing.expression, "speaking");
  assert.equal(playing.visual.frame, "speaking");
  const after = playbackAvatar("speaking", original, true, false);
  assert.equal(after.expression, "idle");
  assert.equal(after.visual.frame, "waiting_1");
  const disabled = playbackAvatar("speaking", original, false, false);
  assert.equal(disabled.expression, "speaking");
  assert.equal(disabled.visual, original);
});

test("VAD speech_started alone is not confirmed interruption of Cartesia playback", () => {
  const context = {
    speechText: "Olá, Luigi. Eu posso explicar como configurar o Alexios.",
    speechAtMs: Date.parse("2026-11-09T16:03:21.040-03:00"),
    lastTurnSequenceAtStart: 121,
  };

  // The user's production logs show a published response followed immediately
  // by multiple speech_started events. None is a confirmed transcribed turn.
  for (const epoch of [21, 22, 23, 24, 25, 26, 27]) {
    assert.ok(epoch > 0);
    assert.equal(shouldInterruptForConfirmedTurn(context, null), false);
  }

  assert.equal(shouldInterruptForConfirmedTurn(context, {
    sequence: 121, text: "Olá, Luigi", receivedAt: "2026-11-09T16:03:22.310-03:00",
  }), false);
});

test("microphone echo snippets from own TTS do not abort playback", () => {
  const context = {
    speechText: "Olá, Luigi. Eu posso explicar como configurar o Alexios corretamente.",
    speechAtMs: Date.parse("2026-11-09T16:03:21.040-03:00"),
    lastTurnSequenceAtStart: 121,
  };
  for (const text of [
    "Olá, Luigi",
    "eu posso explicar",
    "como configurar o Alexios",
    "Eu posso explicar como configurar o Alexios corretamente",
    "Eu posso explicar como configurar o Alexios corretamente!",
  ]) {
    assert.equal(shouldInterruptForConfirmedTurn(context, {
      sequence: 123, text, receivedAt: "2026-11-09T16:03:36.570-03:00",
    }), false, text);
  }
});

test("new confirmed user command can still interrupt audio", () => {
  const context = {
    speechText: "A configuração terá três etapas. Primeiro, abra o painel de controle.",
    speechAtMs: Date.parse("2026-11-09T16:03:21.040-03:00"),
    lastTurnSequenceAtStart: 121,
  };
  for (const text of ["Pare agora", "Alexios, interrompa", "Tenho outra pergunta", "Não é isso"]) {
    assert.equal(shouldInterruptForConfirmedTurn(context, {
      sequence: 123, text, receivedAt: "2026-11-09T16:03:25.020-03:00",
    }), true, text);
  }
  // Pre-publication/stale events and empty/noisy transcripts aren't barge-in.
  assert.equal(shouldInterruptForConfirmedTurn(context, {
    sequence: 124, text: "Pare agora", receivedAt: "2026-11-09T16:03:19.360-03:00",
  }), false);
  assert.equal(shouldInterruptForConfirmedTurn(context, {
    sequence: 123, text: "", receivedAt: "2026-11-09T16:03:25.020-03:00",
  }), false);
});
