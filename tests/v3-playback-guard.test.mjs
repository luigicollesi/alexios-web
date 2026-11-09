import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";

function source(path) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

test("database migration creates per-playback expiring leases", () => {
  const sql = source("db/migrations/007_v3_playback_guard.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.alexios_v3_playbacks/);
  assert.match(sql, /PRIMARY KEY \(agent_id, playback_id\)/);
  assert.match(sql, /expires_at timestamptz NOT NULL/);
  assert.match(sql, /REFERENCES public\.alexios_instances\(id\) ON DELETE CASCADE/);
});

test("playback API requires authorized dashboard, origin and bounded IDs", () => {
  const route = source("src/app/api/v2/alexios/playback/route.ts");
  assert.match(route, /await dashboardAgent\(request\)/);
  assert.match(route, /origin !== new URL\(request.url\).origin/);
  assert.match(route, /validUuid\(data.playbackId\)/);
  assert.match(route, /Number\.isSafeInteger\(data.speechSeq\)/);
  const service = source("src/lib/v3/playback-service.ts");
  assert.match(service, /s\.speech_seq = \$3::bigint/);
  assert.match(service, /s\.speech_at > now\(\) - interval '20 seconds'/);
  assert.match(service, /p\.expires_at > now\(\)/);
});

test("speaking events are ignored without retaining raw words or changing AI memory", () => {
  const intake = source("src/lib/v3/agent-service.ts");
  assert.match(intake, /public\.alexios_v3_playbacks/);
  assert.match(intake, /CASE WHEN playback\.ignored THEN NULL ELSE \$9::text END/);
  assert.match(intake, /CASE WHEN playback\.ignored THEN NULL ELSE \$8::text END/);
  assert.match(intake, /jsonb_build_object\('ignoredDuringPlayback', true, 'payloadHash'/);
  assert.match(intake, /last_accepted_sequence = \$3::bigint/);

  const processor = source("src/lib/v3/event-processor.ts");
  assert.match(processor, /if \(job\.ignored_during_playback\) \{/);
  assert.match(processor, /finishIgnoredPlaybackEvent\(job, token\)/);
  assert.match(processor, /last_processed_sequence = \$3::bigint/);
  assert.match(processor, /status = 'obsolete', processed_at = now\(\)/);
  assert.ok(
    processor.indexOf("if (job.ignored_during_playback)") <
    processor.indexOf('if (job.event_type === "floor_open" && job.fast_status !== "legacy")'),
  );

  const route = source("src/app/v3/[...path]/route.ts");
  assert.match(route, /fastLaneEnabled\(\) && !ack\.ignored/);
});

test("VAD does not replace speaking avatar while any lease is active", () => {
  const intake = source("src/lib/v3/agent-service.ts");
  assert.match(intake, /AND NOT EXISTS \(\s*SELECT 1 FROM public\.alexios_v3_playbacks/);
  assert.match(intake, /activity_epoch = \$3::bigint/);
});

test("browser sends real playback start, pulse and finish", () => {
  const hook = source("src/hooks/use-alexios-voice.ts");
  assert.match(hook, /playbackUpdate\("start", active\)/);
  assert.match(hook, /playbackUpdate\("pulse", active\)/);
  assert.match(hook, /playbackUpdate\("finish", active\)/);
  assert.match(hook, /closePlaybackLease\(active\)/);
  assert.match(hook, /playbackId: crypto\.randomUUID\(\)/);
});
