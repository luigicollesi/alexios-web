import test from "node:test";
import assert from "node:assert/strict";
import { mergeWindow, renderWords, validateDecision } from "../src/merge.mjs";

test("remove a palavra repetida no segundo sobreposto sem perder a fala nova", () => {
  let state = { pendingWords: [] };
  state = mergeWindow(state, { captureId: "recording-01", windowIndex: 0, words: [
    { text: "Olá", startMs: 100, endMs: 500 },
    { text: "mundo", startMs: 3200, endMs: 3850 },
  ] }).session;
  const result = mergeWindow(state, { captureId: "recording-01", windowIndex: 1, words: [
    { text: "mundo", startMs: 3230, endMs: 3890 },
    { text: "Alexios", startMs: 3950, endMs: 4400 },
  ] });
  assert.equal(renderWords(result.session.pendingWords), "Olá mundo Alexios");
  assert.equal(result.accepted, 1);
});

test("retransmissão não insere palavras duplicadas", () => {
  const first = mergeWindow({ pendingWords: [] }, {
    captureId: "recording-01", windowIndex: 0,
    words: [{ text: "Oi", startMs: 0, endMs: 200 }],
  }).session;
  const retry = mergeWindow(first, {
    captureId: "recording-01", windowIndex: 0,
    words: [{ text: "Oi", startMs: 0, endMs: 200 }],
  });
  assert.equal(retry.accepted, 0);
  assert.deepEqual(retry.session, first);
});

test("trocar geração reinicia os relógios da captura", () => {
  const first = mergeWindow({ pendingWords: [] }, {
    captureId: "recording-01", windowIndex: 8,
    words: [{ text: "Antes", startMs: 24000, endMs: 24100 }],
  }).session;
  const next = mergeWindow({ ...first, pendingWords: [] }, {
    captureId: "recording-02", windowIndex: 0,
    words: [{ text: "Depois", startMs: 50, endMs: 400 }],
  });
  assert.equal(renderWords(next.session.pendingWords), "Depois");
});

test("valida saída estruturada da IA", () => {
  assert.deepEqual(validateDecision({ speech: "", pose: "listening", context: "Sala silenciosa" }),
    { speech: "", pose: "listening", context: "Sala silenciosa" });
  assert.throws(() => validateDecision({ speech: "Oi", pose: "unknown", context: "" }));
});
