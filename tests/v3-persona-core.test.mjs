import {test} from "node:test";
import assert from "node:assert/strict";
import {v3Messages} from "../src/lib/v3/persona-core.ts";

const input = {
  context:"O usuário usa PostgreSQL no projeto; já perguntou quanto é 2+2.",
  stance:"crossed-arm",
  waitingVariant:2,
  freshSpeech:"[speaker_01] Qual banco estamos usando?",
  responseWindow:true,
};

test("every request gets fixed persona, selected pose, rolling memory and only fresh speech", () => {
  const messages = v3Messages(input);
  assert.equal(messages.length,3);
  assert.equal(messages[0].role,"system");
  for (const stance of ["crossed-arm","hand-in-pocket"]){
    assert.ok(messages[0].content.includes(stance));
  }
  for (const frame of ["listening","speaking","waiting_1","waiting_2"]){
    assert.ok(messages[0].content.includes(frame));
  }
  assert.match(messages[0].content,/Pose atual: crossed-arm\/waiting_2/);
  assert.ok(messages[1].content.includes("PostgreSQL"));
  assert.ok(!messages[2].content.includes("2+2"));
  assert.match(messages[2].content,/Qual banco estamos usando/);
  assert.match(messages[0].content,/shouldSpeak/);
});

test("observation uses same core and memory without opening a response window", () => {
  const messages = v3Messages({...input,responseWindow:false});
  assert.match(messages[0].content,/JANELA DE RESPOSTA FECHADA/);
  assert.match(messages[0].content,/NOVO context/);
  assert.ok(messages[2].content.includes("Qual banco"));
});
