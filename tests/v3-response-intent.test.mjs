import {test} from "node:test";
import assert from "node:assert/strict";
import {directRequestKind, repairDirectSilence}
  from "../src/lib/v3/response-intent.ts";

const utterance = (text, run = "6c2dc782") =>
  "[" + run + "/speaker_01]: " + text;

test("connection check in the real failed production transcript requires speech", () => {
  const fresh = utterance("Alô, tá conseguindo ver");
  assert.equal(directRequestKind(fresh), "connection");
  const original = {
    context: "Memória anterior não é pergunta.",
    stance: "hand-in-pocket", waitingVariant: 1,
    shouldSpeak: false, speech: "",
  };
  const repaired = repairDirectSilence(original, fresh);
  assert.equal(repaired.shouldSpeak, true);
  assert.match(repaired.speech, /recebendo sua fala/);
  assert.match(repaired.speech, /não tenho acesso à câmera/);
  assert.equal(repaired.context, original.context);
  assert.equal(repaired.directSilenceRepaired, true);
});

test("direct conversational questions without a wake word cannot be discarded", () => {
  for (const prompt of [
    "Qual é o resultado de dois mais dois?",
    "Como funciona esse aplicativo",
    "Você sabe que horas são?",
    "Oi, Alexios",
    "Tá me ouvindo?",
    "Alô?",
  ]) {
    assert.notEqual(directRequestKind(utterance(prompt)), null, prompt);
    assert.equal(repairDirectSilence({shouldSpeak:false, speech:""}, utterance(prompt))
      .shouldSpeak, true, prompt);
  }
});

test("ambient background remarks and stale memory do not trigger new speech", () => {
  for (const prompt of [
    "A mesa é de madeira, achei bonita",
    "Hoje o jogo ficou bem interessante",
    "Eu já tinha dito isso antes",
    "(nenhuma fala nova)",
    "",
  ]) {
    assert.equal(directRequestKind(utterance(prompt)), null, prompt);
  }
  const silent = {shouldSpeak:false, speech:""};
  assert.deepEqual(repairDirectSilence(silent,utterance("Discussão entre outras pessoas")),
    silent);
  assert.deepEqual(repairDirectSilence(silent,""),silent);
});

test("already valid model speech is never replaced and only latest utterance matters", () => {
  const prior = utterance("Qual é a temperatura?");
  const ambient = utterance("Acho isso ótimo.");
  assert.equal(directRequestKind(prior + "\n" + ambient), null);
  const decision={shouldSpeak:true,speech:"Resposta correta do modelo."};
  assert.deepEqual(repairDirectSilence(decision,utterance("Alô?")),decision);
});
