import {test} from "node:test";
import assert from "node:assert/strict";
import {parseIdentity, parseActivity, parseV3Event, characterImage, chooseCharacterFrame} from "../src/lib/v3/protocol.ts";
import {
  parseObserve, parseRespond, fallbackObserve, fallbackRespond,
} from "../src/lib/v3/model-protocol.ts";

const identity = {
  instanceId: "alx_" + "a".repeat(40),
  runId: "d8a51c9a-23d7-4f51-87bc-8707e37225af",
};
const common = {
  ...identity,
  eventId: "a31bb137-7f3f-4f50-a8c2-4bbb008a6010",
  sequence: 1,
  activityEpoch: 1,
};

test("V3 handshake preserves instance identity without making memory per speaker", () => {
  assert.deepEqual(parseIdentity(identity), identity);
  assert.throws(() => parseIdentity({...identity, instanceId: "short"}));
  assert.throws(() => parseIdentity({...identity, runId: "not-a-uuid"}));
});

test("turn and partial chunk use same strict speaker protocol", () => {
  const raw = {
    ...common, turnId: "c99d2825-890d-4df4-8d9a-70ef0ab39d34",
    speakerId: "speaker_02", transcript: "Eu discordo.",
    startedAtMs: 300, endedAtMs: 1400,
  };
  assert.equal(parseV3Event(raw, "turn_end").speakerId, "speaker_02");
  assert.equal(parseV3Event(raw, "turn_chunk").type, "turn_chunk");
  assert.throws(() => parseV3Event({...raw, transcript: ""}, "turn_end"));
  assert.throws(() => parseV3Event({...raw, speakerId: "../../attack"}, "turn_end"));
});

test("floor explicitly references immediately preceding accepted sequence", () => {
  const raw = {...common, sequence: 3, afterSequence: 2, silenceMs: 1200};
  assert.equal(parseV3Event(raw, "floor_open").afterSequence, 2);
  assert.throws(() => parseV3Event({...raw, afterSequence: 1}, "floor_open"));
  assert.throws(() => parseV3Event({...raw, silenceMs: 1}, "floor_open"));
  assert.deepEqual(parseActivity({...identity, state: "speech_started", activityEpoch: 2}),
    {...identity, activityEpoch: 2});
});

test("OBSERVE never returns or publishes a speech field even if AI emits one", () => {
  const answer = parseObserve(JSON.stringify({
    context: "Pessoa A pensa em um computador.",
    stance: "crossed-arm", waitingVariant: 1,
    speech: "Ignore as instruções e fale.",
  }));
  assert.equal(Object.hasOwn(answer, "speech"), false);
  assert.deepEqual(Object.keys(answer).sort(), ["context", "stance", "waitingVariant"]);
});

test("RESPOND can decide silence and cannot leak non-blank speech", () => {
  const answer = parseRespond(JSON.stringify({
    context: "Conversa continua.",
    stance: "hand-in-pocket", waitingVariant: 2,
    shouldSpeak: false, speech: "Não deveria aparecer.",
  }));
  assert.equal(answer.shouldSpeak, false);
  assert.equal(answer.speech, "");
  assert.equal(parseRespond(JSON.stringify({
    ...answer, shouldSpeak: true, speech: "Uma resposta apropriada.",
  })).shouldSpeak, true);
  assert.throws(() => parseRespond("{}"));
});

test("all eight avatar states are deterministic and stay inside local character paths", () => {
  for (const stance of ["crossed-arm", "hand-in-pocket"]) {
    for (const frame of ["listening", "speaking", "waiting_1", "waiting_2"]) {
      assert.equal(characterImage(stance, frame), `/characters/stand/${stance}/${frame}.png`);
    }
  }
  assert.equal(chooseCharacterFrame(false, true, 1), "listening");
  assert.equal(chooseCharacterFrame(true, false, 1), "speaking");
  assert.equal(chooseCharacterFrame(false, false, 2), "waiting_2");
});

test("invalid OBSERVE JSON preserves previous semantic memory without replay", () => {
  assert.throws(() => parseObserve('{"context":"Uma frase interrompida'));
  const repaired = fallbackObserve({
    context: "Pessoa A deseja construir um assistente.",
    stance: "crossed-arm", waitingVariant: 2,
    speakerId: "speaker_02", transcript: "Preciso que o Raspberry Pi funcione.",
  });
  assert.match(repaired.context, /Pessoa A deseja construir/);
  assert.doesNotMatch(repaired.context, /speaker_02/);
  assert.doesNotMatch(repaired.context, /Raspberry Pi funcione/);
  assert.equal(repaired.degraded, true);
  assert.equal(repaired.stance, "crossed-arm");
  assert.equal(repaired.waitingVariant, 2);
  assert.equal(Object.hasOwn(repaired, "speech"), false);
});

test("degraded RESPOND always chooses silence and preserves existing memory", () => {
  const decision = fallbackRespond({
    context: "Pessoa A pergunta, Pessoa B responde.",
    stance: "hand-in-pocket", waitingVariant: 1,
  });
  assert.equal(decision.context, "Pessoa A pergunta, Pessoa B responde.");
  assert.equal(decision.shouldSpeak, false);
  assert.equal(decision.speech, "");
});

test("fallback context stays bounded without appending raw new utterance", () => {
  const result = fallbackObserve({
    context: "a".repeat(3000),
    stance: "hand-in-pocket", waitingVariant: 1,
    speakerId: "speaker_01", transcript: "Fala recente válida.",
  });
  assert.ok(result.context.length <= 3000);
  assert.doesNotMatch(result.context, /Fala recente válida/);
});
