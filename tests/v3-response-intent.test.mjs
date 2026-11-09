import {test} from "node:test";
import assert from "node:assert/strict";
import {directRequestKind, repairDirectSilence}
  from "../src/lib/v3/response-intent.ts";

const utterance = (text, run = "6c2dc782") =>
  "[" + run + "/speaker_01]: " + text;

const silent = {
  context:"Discussão anterior não gera pergunta nova.",
  stance:"hand-in-pocket", waitingVariant:1,
  shouldSpeak:false, speech:"",
};
const aloneObserved = {silenceMs:1216, observedSpeakers:1};

test("ambiguous production connection check can be clarified after pause", () => {
  const fresh = utterance("Alô, tá conseguindo ver");
  assert.equal(directRequestKind(fresh), "connection");
  const recovered = repairDirectSilence(silent, fresh, aloneObserved);
  assert.equal(recovered.shouldSpeak, true);
  assert.equal(recovered.speech,
    "Está falando comigo? Recebo sua fala, mas não vejo imagens.");
  assert.equal(recovered.context, silent.context);
  assert.equal(recovered.directSilenceRepaired, true);
});

test("noise in transcription or punctuation does not block a gentle clarification", () => {
  const fresh = utterance("Alo ta conseguindo ve");
  assert.equal(directRequestKind(fresh), "connection");
  assert.equal(repairDirectSilence(silent, fresh, aloneObserved).shouldSpeak,true);
});

test("one observed voice is not proof of an empty room; short pauses do not force speech", () => {
  const question = utterance("Alô, tá conseguindo ver");
  for (const cues of [
    {}, {silenceMs:1216}, {observedSpeakers:1},
    {silenceMs:950,observedSpeakers:1},
    {silenceMs:1216,observedSpeakers:2},
    {silenceMs:1216,observedSpeakers:0},
  ]) {
    assert.deepEqual(repairDirectSilence(silent,question,cues),silent);
  }
});

test("a question mark or generic greeting does not guarantee Alexios is addressed", () => {
  for (const text of [
    "Qual é o resultado de dois mais dois?",
    "Você sabe que horas são?",
    "Como vamos fazer isso",
    "Oi",
    "Consegue me ouvir?",
  ]) {
    const fresh = utterance(text);
    assert.notEqual(directRequestKind(fresh),null,text);
    assert.deepEqual(repairDirectSilence(silent,fresh,{silenceMs:1216,observedSpeakers:2}),
      silent,text);
  }
});

test("an explicit address is acknowledged without requiring a model interpretation", () => {
  for (const fresh of [
    utterance("Alexios, você sabe que horas são?"),
    utterance("Assistente, consegue me responder?"),
  ]) {
    assert.equal(repairDirectSilence(silent,fresh,{}).shouldSpeak,true);
  }
  assert.equal(repairDirectSilence(silent,utterance("Alexios, consegue me ver?"),{})
    .speech,"Recebo sua fala, mas não tenho acesso à câmera ou a imagens.");
});

test("background comments, old questions and already valid responses stay untouched", () => {
  const prior = utterance("Alexios, qual o tempo?");
  const ambient = utterance("A mesa é de madeira, achei bonita");
  assert.equal(directRequestKind(prior + "\n" + ambient), null);
  assert.deepEqual(repairDirectSilence(silent,prior + "\n" + ambient,aloneObserved),silent);
  assert.deepEqual(repairDirectSilence(silent,"",aloneObserved),silent);
  const existing={...silent,shouldSpeak:true,speech:"Complemento útil e oportuno."};
  assert.deepEqual(repairDirectSilence(existing,utterance("Alô?"),aloneObserved),existing);
});
