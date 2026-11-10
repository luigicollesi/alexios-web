import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const source = path => readFileSync(path, "utf8");

test("V4 inference lease is installed and shared by both model paths", () => {
  const schema = source("db/migrations/009_v4_inference_coordinator.sql");
  const coordinator = source("src/lib/v3/inference-coordinator.ts");
  const sequential = source("src/lib/v3/event-processor.ts");
  const fast = source("src/lib/v3/fast-response.ts");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.alexios_v4_inference_state/);
  assert.match(schema, /agent_id uuid PRIMARY KEY/);
  assert.match(coordinator, /ON CONFLICT \(agent_id\) DO UPDATE/);
  assert.match(coordinator, /WHERE state\.mode = 'idle'/);
  assert.match(coordinator, /generation = state\.generation \+ 1/);
  assert.match(sequential, /await acquireInference\(/);
  assert.match(sequential, /await releaseInference\(lease\)/);
  assert.match(fast, /await waitForInference\(/);
  assert.match(fast, /releaseInference\(inferenceLease\)/);
});

test("V4 folds pending observation before floor and protects stale writes", () => {
  const sequential = source("src/lib/v3/event-processor.ts");
  const fast = source("src/lib/v3/fast-response.ts");
  const coordinator = source("src/lib/v3/inference-coordinator.ts");
  assert.match(sequential, /await floorCoveringTurn\(/);
  assert.match(sequential, /async function finishCoveredObservation\(/);
  assert.match(sequential, /last_error = 'covered_by_respond'/);
  assert.match(sequential, /guard\.lease_token = \$19::uuid/);
  assert.match(fast, /guard\.lease_token = \$12::uuid/);
  assert.match(coordinator, /floor\.sequence > \$3::bigint/);
  assert.match(coordinator, /state\.deadline_at < now\(\) - interval '35 seconds'/);
});
