import {test} from "node:test";
import assert from "node:assert/strict";
import {contextForRun, explicitNameIntroduction, mergeSpeakerContext,
  stripSpeakerMappings} from "../src/lib/v3/speaker-context.ts";
import {v3Messages} from "../src/lib/v3/persona-core.ts";

const runA = "6c2dc782-f1c2-4b9d-9728-a6097e7bd17f";
const runB = "b0ae5825-0d40-4049-804a-16584bd73938";

test("a self introduction binds speaker_03 = Luigi in variable memory", () => {
  const context = mergeSpeakerContext({
    previous:"O tema é programação.",
    generated:"O tema é desenvolvimento de software.",
    runId:runA,
    speakerId:runA.slice(0,8) + "/speaker_03",
    freshSpeech:"Meu nome é Luigi.",continuousSpeechMs:2400,
  });
  assert.match(context,/speaker_03 = Luigi/);
  assert.match(context,/Vozes da execucao 6c2dc782/);
  assert.match(context,/desenvolvimento de software/);
  assert.ok(context.length <= 1200);
});

test("a second inference keeps the mapping even if the LLM forgets it", () => {
  const previous = mergeSpeakerContext({
    previous:"Resumo",generated:"Resumo",runId:runA,
    speakerId:"speaker_03",freshSpeech:"Me chamo Luigi",continuousSpeechMs:2500,
  });
  const current = mergeSpeakerContext({
    previous,generated:"Novo resumo do dia.",runId:runA,
    speakerId:"speaker_07",freshSpeech:"Isso ficou legal.",
  });
  assert.match(current,/speaker_03 = Luigi/);
  assert.doesNotMatch(current,/speaker_07 =/);
  assert.match(current,/Novo resumo do dia/);
});

test("a new run drops the old diarizer mapping", () => {
  const a = mergeSpeakerContext({
    previous:"Tema anterior",generated:"Tema anterior",runId:runA,
    speakerId:"speaker_03",freshSpeech:"Eu me chamo Luigi",continuousSpeechMs:2200,
  });
  const b = contextForRun(a,runB);
  assert.doesNotMatch(b,/speaker_03 = Luigi/);
  assert.match(b,/Tema anterior/);
  const c = mergeSpeakerContext({
    previous:a,generated:"Nova execução",runId:runB,
    speakerId:"speaker_03",freshSpeech:"me chamo Ana",continuousSpeechMs:2300,
  });
  assert.match(c,/speaker_03 = Ana/);
  assert.doesNotMatch(c,/speaker_03 = Luigi/);
});

test("name-only questions and third-party mentions do not assign a name", () => {
  for(const phrase of [
    "Seu nome é Alexios mesmo?",
    "Quem é Luigi?",
    "O Luigi está aqui.",
    "Como se chama a Ana?",
    "Meu nome é isso",
  ]) {
    assert.equal(explicitNameIntroduction(phrase),null,phrase);
  }
  assert.equal(explicitNameIntroduction("pode me chamar de Luigi"),"Luigi");
  assert.equal(explicitNameIntroduction("me chamo Ana"),"Ana");
});

test("Fast and unknown voices do not register a name without a >=2s verified turn", () => {
  const fromFloor=mergeSpeakerContext({
    previous:"Trabalho em equipe.",generated:"Trabalho em equipe.",
    runId:runA,
    freshSpeech:"[6c2dc782/speaker_03]: Meu nome é Luigi",
  });
  assert.doesNotMatch(fromFloor,/speaker_03 = Luigi/);
  const core=v3Messages({
    context:fromFloor,runId:runA,stance:"hand-in-pocket",
    waitingVariant:1,frame:"waiting_1",
    freshSpeech:"[6c2dc782/speaker_unknown]: Qual o próximo passo?",
    responseWindow:true,
  });
  assert.match(core[0].content,/speaker_unknown não identifica nem registra/);
  assert.doesNotMatch(core[1].content,/speaker_03 = Luigi/);
  const unknown=mergeSpeakerContext({
    previous:fromFloor,generated:"Trabalho em equipe.",runId:runA,
    freshSpeech:"Meu nome é Luigi e estou falando há mais de dois segundos.",
    speakerId:"speaker_unknown",continuousSpeechMs:3000,
  });
  assert.doesNotMatch(unknown,/speaker_unknown =|speaker_03 = Luigi/);
});

test("a brief introduction does not create a speaker identity", () => {
  const short = mergeSpeakerContext({
    previous:"Tema programação.",generated:"Tema programação.",runId:runA,
    speakerId:"speaker_03",freshSpeech:"Meu nome é Luigi",
    continuousSpeechMs:1999,
  });
  assert.doesNotMatch(short,/speaker_03 = Luigi/);
  const long = mergeSpeakerContext({
    previous:short,generated:"Tema programação.",runId:runA,
    speakerId:"speaker_03",freshSpeech:"Meu nome é Luigi",
    continuousSpeechMs:2000,
  });
  assert.match(long,/speaker_03 = Luigi/);
});

test("model-generated unconfirmed speaker assignments are not trusted", () => {
  const result=mergeSpeakerContext({
    previous:"Relatório",
    generated:"Relatório\nspeaker_03 = OutroNome",runId:runA,
    freshSpeech:"O tempo parece bom",speakerId:"speaker_03",
  });
  assert.doesNotMatch(result,/OutroNome/);
  assert.equal(stripSpeakerMappings(result),"Relatório");
});

test("speaker mapping remains bounded and does not repeat", () => {
  const previous = mergeSpeakerContext({
    previous:"X".repeat(1800),generated:"X".repeat(1800),runId:runA,
    speakerId:"speaker_03",freshSpeech:"Meu nome é Luigi",continuousSpeechMs:2300,
  });
  const again=mergeSpeakerContext({
    previous,generated:previous,runId:runA,
    speakerId:"speaker_03",freshSpeech:"Meu nome é Luigi",continuousSpeechMs:2300,
  });
  assert.equal((again.match(/speaker_03 = Luigi/g)||[]).length,1);
  assert.ok(again.length <= 1200);
});
