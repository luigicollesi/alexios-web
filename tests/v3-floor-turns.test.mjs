import {test} from "node:test";
import assert from "node:assert/strict";
import {FRESH_FLOOR_TURNS_SQL, formatFreshFloorTurns}
  from "../src/lib/v3/floor-turns.ts";

test("fresh floor input is bounded by previous floor, run, and event sequence", () => {
  assert.match(FRESH_FLOOR_TURNS_SQL, /e\.run_id = \$2::uuid/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /e\.sequence < \$3::bigint/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /e\.sequence > COALESCE/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /prior\.event_type = 'floor_open'/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /prior\.run_id = \$2::uuid/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /'turn_end', 'turn_chunk'/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /e\.status NOT IN \('obsolete', 'failed'\)/);
  assert.match(FRESH_FLOOR_TURNS_SQL, /ORDER BY e\.sequence DESC/);
});

test("speaker turns are ordered chronologically without modifying SQL rows", () => {
  const rows = [
    {run_id:"run-alpha",speaker_id:"speaker_02",transcript:"Pergunta nova?"},
    {run_id:"run-alpha",speaker_id:"speaker_01",transcript:"Alexios,"},
  ];
  assert.equal(formatFreshFloorTurns(rows),
    "[run-alph/speaker_01]: Alexios,\n[run-alph/speaker_02]: Pergunta nova?");
  assert.equal(rows[0].transcript, "Pergunta nova?");
});

test("silence and empty transcripts do not inject past conversation text", () => {
  assert.equal(formatFreshFloorTurns([]), "");
  assert.equal(formatFreshFloorTurns([
    {run_id:"r",speaker_id:null,transcript:"   "},
  ]), "");
});
