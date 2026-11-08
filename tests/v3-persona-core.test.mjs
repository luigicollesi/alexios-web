import {test} from "node:test";
import assert from "node:assert/strict";
import {v3Messages, V3_POSE_ASSETS, MAX_CONTEXT_CHARS}
  from "../src/lib/v3/persona-core.ts";
import {parseObserve} from "../src/lib/v3/model-protocol.ts";
import {readFileSync, statSync} from "node:fs";
import {join} from "node:path";

const input = {
  context:"O usuário usa PostgreSQL no projeto; já perguntou quanto é 2+2.",
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
  for (const frame of ["listening","speaking","waiting_1","waiting_2"]){
    assert.ok(messages[0].content.includes(frame));
  }
  assert.ok(messages[0].content.includes("Imagem atualmente exibida: /characters/stand/crossed-arm/listening.png"));
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

test("core enumerates every PNG available in the repository", () => {
  assert.equal(V3_POSE_ASSETS.length, 8);
  const names = V3_POSE_ASSETS.map(x => x.path);
  assert.equal(new Set(names).size, 8);
  const core = v3Messages(input)[0].content;
  for (const asset of V3_POSE_ASSETS) {
    assert.match(asset.path, /^\/characters\/stand\/(crossed-arm|hand-in-pocket)\/(listening|speaking|waiting_1|waiting_2)\.png$/);
    assert.ok(core.includes(asset.path));
    assert.ok(core.includes(asset.meaning));
    const physical = join(process.cwd(), "public", asset.path.slice(1).replace(/^characters\//, "characters/"));
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
