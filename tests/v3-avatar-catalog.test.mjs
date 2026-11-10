import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {AVATAR_ASSETS, AVATAR_POSES, DEFAULT_STANCE, avatarPath, avatarStance,
  avatarForm, avatarEmotion} from "../src/lib/v3/avatar-catalog.ts";

test("every form/pose/frame resolves to exactly one valid PNG", () => {
  assert.equal(AVATAR_ASSETS.length,52);
  assert.equal(new Set(AVATAR_ASSETS.map(a=>a.path)).size,52);
  for(const a of AVATAR_ASSETS){
    const full=join(process.cwd(),"public",a.path.slice(1));
    assert.ok(statSync(full).size>8,a.path);
    assert.deepEqual([...readFileSync(full).subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(avatarPath(a.form,a.stance,a.frame),a.path);
  }
  assert.ok(AVATAR_POSES.men.includes("double-biceps"));
  assert.ok(AVATAR_POSES.woman.includes("double-biceps"));
  assert.ok(!AVATAR_POSES.men.includes("doble-biceps"));
  assert.equal(DEFAULT_STANCE.men,"hand-in-pocket");
  assert.equal(DEFAULT_STANCE.woman,"elegant");
});
test("form, pose and emotions are bounded to valid server-side choices",()=>{
  assert.equal(avatarForm("woman"),"woman");
  assert.equal(avatarForm("untrusted","woman"),"woman");
  assert.equal(avatarStance("woman","hand-in-pocket"),"elegant");
  assert.equal(avatarStance("men","elegant"),"hand-in-pocket");
  assert.equal(avatarStance("woman","anger"),"anger");
  assert.equal(avatarEmotion("angry"),"angry");
  assert.equal(avatarEmotion("surprise_and_vanish"),"neutral");
});
test("both V3 publishing paths snapshot the voice and emotion",()=>{
  for(const f of ["src/lib/v3/event-processor.ts","src/lib/v3/fast-response.ts"]){
    const text=readFileSync(join(process.cwd(),f),"utf8");
    assert.match(text,/character_form = CASE/);
    assert.match(text,/speech_form = CASE/);
    assert.match(text,/speech_emotion = CASE/);
  }
  const route=readFileSync(join(process.cwd(),"src/app/api/v2/alexios/tts/route.ts"),"utf8");
  assert.match(route,/form: status.core.speech.form/);
  assert.match(route,/emotion: status.core.speech.emotion/);
});
