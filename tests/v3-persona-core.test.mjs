import {test} from "node:test";
import assert from "node:assert/strict";
import {v3Messages, V3_POSE_ASSETS, MAX_CONTEXT_CHARS}
  from "../src/lib/v3/persona-core.ts";
import {parseObserve} from "../src/lib/v3/model-protocol.ts";
import {characterImage} from "../src/lib/v3/protocol.ts";
import {readFileSync, statSync} from "node:fs";
import {join} from "node:path";

const input = {
  context:"O usuário usa PostgreSQL no projeto; já perguntou quanto é 2+2.",
  form:"men",
  stance:"crossed-arm",
  waitingVariant:2,
  frame:"listening",
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
  assert.ok(messages[0].content.includes("postura atual: crossed-arm"));
  assert.doesNotMatch(messages[0].content, /O servidor controla listening/);
  assert.doesNotMatch(messages[0].content, /Imagem atual:/);
  assert.ok(messages[1].content.includes("PostgreSQL"));
  assert.ok(!messages[2].content.includes("2+2"));
  assert.match(messages[2].content,/Qual banco estamos usando/);
  assert.match(messages[0].content,/shouldSpeak/);
});

test("observation uses same core and memory without opening a response window", () => {
  const messages = v3Messages({...input,responseWindow:false});
  assert.match(messages[0].content,/JANELA DE RESPOSTA FECHADA/);
  assert.match(messages[0].content,/OBSERVE — MEMÓRIA/);
  assert.match(messages[0].content,/OBSERVE — EXECUÇÃO/);
  assert.ok(messages[2].content.includes("Qual banco"));
});

test("core enumerates every PNG available in the repository", () => {
  assert.equal(V3_POSE_ASSETS.length, 52);
  const names = V3_POSE_ASSETS.map(x => x.path);
  assert.equal(new Set(names).size, 52);
  const core = v3Messages(input)[0].content;
  for (const asset of V3_POSE_ASSETS) {
    assert.match(asset.path, /^\/characters\/(men|woman)\/[a-z-]+\/(listening|speaking|waiting_1|waiting_2)\.png$/);
    assert.equal(characterImage(asset.stance, asset.frame, asset.form), asset.path);
    const physical = join(process.cwd(), "public", asset.path.slice(1));
    assert.ok(statSync(physical).size > 8, asset.path);
    const header = readFileSync(physical).subarray(0,8);
    assert.deepEqual([...header], [137,80,78,71,13,10,26,10]);
  }
});

test("rolling memory is read as context, never replayed as new speech", () => {
  const first = parseObserve(JSON.stringify({
    context:"O projeto usa PostgreSQL.",
    stance:"hand-in-pocket", waitingVariant:1,
  }));
  const next = v3Messages({
    context:first.context,
    stance:first.stance,
    waitingVariant:first.waitingVariant,
    frame:"waiting_1",
    freshSpeech:"Qual banco estamos usando?",
    responseWindow:true,
  });
  assert.match(next[1].content,/PostgreSQL/);
  assert.doesNotMatch(next[2].content,/O projeto usa PostgreSQL/);
  assert.match(next[2].content,/Qual banco estamos usando/);
  assert.ok(first.context.length <= MAX_CONTEXT_CHARS);
});

test("response core considers real pause, observed voices and noisy transcription", () => {
  const messages = v3Messages({...input,
    responseCues:{silenceMs:1216,observedSpeakers:1},
    freshSpeech:"[speaker_01]: Alô, tá conseguindo ver",
  });
  assert.equal(messages.length,3);
  assert.match(messages[0].content,/1216 ms/);
  assert.match(messages[0].content,/IDs de vozes distintas nos últimos 3 minutos desta execução: 1/);
  assert.match(messages[0].content,/não é contagem de pessoas presentes/);
  assert.match(messages[0].content,/Transcrição automática pode trocar palavras/);
  assert.match(messages[0].content,/complementar a discussão/);
  assert.match(messages[0].content,/Está falando comigo/);
  assert.match(messages[2].content,/Alô, tá conseguindo ver/);
  assert.doesNotMatch(messages[2].content,/PostgreSQL/);
});

test("speaker IDs are provisional and introductions belong to variable run context", () => {
  const core = v3Messages(input)[0].content;
  assert.match(core, /speakerId é um identificador provisório de voz/);
  assert.match(core, /speaker_XX = nome/);
  assert.match(core, /speaker_unknown não identifica pessoa/);
  assert.match(core, /não solicite nomes/);
  assert.match(core, /mude quando houver/);
  assert.doesNotMatch(core, /O servidor controla listening/);
  assert.doesNotMatch(core, /enquanto speaking você NÃO escuta/);
});

test("OBSERVE and RESPOND have distinct memory and execution instructions", () => {
  const observe = v3Messages({...input, responseWindow:false})[0].content;
  const respond = v3Messages({...input, responseWindow:true})[0].content;
  for (const prompt of [observe,respond]) {
    assert.match(prompt, /fatos NOVOS possivelmente úteis em interações futuras/);
    assert.match(prompt, /Se nada relevante mudou, mantenha context anterior/);
    assert.match(prompt, /Nunca trate perguntas antigas do contexto como pedidos atuais/);
    assert.doesNotMatch(prompt, /Em TODA decisão gere NOVO context/);
  }
  assert.match(observe, /OBSERVE — EXECUÇÃO/);
  assert.doesNotMatch(observe, /RESPOND — EXECUÇÃO/);
  assert.match(observe, /nunca produza fala/);
  assert.match(respond, /RESPOND — EXECUÇÃO/);
  assert.doesNotMatch(respond, /OBSERVE — EXECUÇÃO/);
  assert.match(respond, /Emoções válidas/);
  assert.doesNotMatch(observe, /Emoções válidas/);
});

test("compact V4 persona explains each stance and keeps expressive listening", () => {
  const observe = v3Messages({...input, responseWindow:false})[0].content;
  for (const stance of [
    "hand-in-pocket", "elegant", "crossed-arm", "thumbs-up",
    "thumbs-down", "anger", "fury", "double-biceps",
  ]) assert.match(observe, new RegExp(stance));
  assert.ok(observe.includes("versão feminina/trans"));
  assert.match(observe, /amigo na conversa/);
  assert.match(observe, /elegant \(woman\): pose elegante; repouso/);
  assert.match(observe, /double-biceps: braços flexionados exibindo bíceps/);
  assert.match(observe, /Atenda gestos representáveis, mesmo sem emoção/);
  assert.match(observe, /Use posturas livremente, inclusive em OBSERVE e em silêncio/);
  assert.match(observe, /Você ainda não é digno de ver essa pose/);
  assert.match(observe, /Não mencione arquivos ou configuração/);
  assert.ok(observe.length < 4400, "core should remain compact");
});

test("valid JSON field specifications do not bias stance to thumbs-up", () => {
  for (const responseWindow of [false, true]) {
    const core = v3Messages({...input, responseWindow})[0].content;
    const schema = core.split("JSON obrigatório: ")[1];
    assert.ok(schema, "mode must declare output fields");
    assert.doesNotMatch(schema, /stance":"thumbs-up"/);
    assert.match(schema, /stance\(postura válida da forma\)/);
    assert.match(core, /thumbs-up: polegar erguido; aprovação explícita/);
    assert.match(core, /elegant \(woman\): pose elegante; repouso/);
  }
});
