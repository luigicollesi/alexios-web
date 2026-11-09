import {test} from "node:test";
import assert from "node:assert/strict";
import {latestUtteranceFromCumulative}
  from "../src/lib/v3/transcript-delta.ts";

test("production example displays only latest utterance", () => {
  assert.equal(
    latestUtteranceFromCumulative("Alô? Qual é seu nome?", "Alô?"),
    "Qual é seu nome?",
  );
  assert.equal(
    latestUtteranceFromCumulative("Alô? Seu nome é Alexios mesmo?", "Alô?"),
    "Seu nome é Alexios mesmo?",
  );
});

test("speaker renumbering does not change the transcript-delta algorithm", () => {
  assert.equal(
    latestUtteranceFromCumulative("ALO, qual é seu nome?", "Alô?"),
    "qual é seu nome?",
  );
  assert.equal(latestUtteranceFromCumulative("Oi! Tudo certo?", "Oi!"),
    "Tudo certo?");
});

test("do not discard a complete repeated or unrelated utterance", () => {
  assert.equal(latestUtteranceFromCumulative("Alô?", "Alô?"), "Alô?");
  assert.equal(latestUtteranceFromCumulative("Seu nome é Alexios?", "Alô?"),
    "Seu nome é Alexios?");
  assert.equal(latestUtteranceFromCumulative("Posso ver?", "Você consegue me ver?"),
    "Posso ver?");
  assert.equal(latestUtteranceFromCumulative("Estou com sono", "Estou"),
    "Estou com sono");
  assert.equal(latestUtteranceFromCumulative("Alô?",""),"Alô?");
});

test("handle noisy spacing and punctuation without losing the new sentence", () => {
  assert.equal(latestUtteranceFromCumulative(
    "Alô   ?     Você  está ouvindo?", "Alô!"), "Você está ouvindo?");
  assert.equal(latestUtteranceFromCumulative(
    "Será que é isso? Agora sim.", "Será que é isso!"), "Agora sim.");
});
