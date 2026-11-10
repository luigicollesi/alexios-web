import "server-only";
import {randomUUID} from "node:crypto";
import {query} from "@/lib/agent-db";

/** One authorized OpenRouter request per Alexios instance. The DB owns this
 * lease: serverless processes must never coordinate using process memory. */
export type InferenceMode = "observe" | "respond";
export type InferenceLease = {
  token: string;
  generation: number;
  agentId: string;
  runId: string;
  mode: InferenceMode;
};
type LeaseRow = {generation: string | number};

export async function acquireInference(
  agentId: string, runId: string, eventId: string, mode: InferenceMode,
): Promise<InferenceLease | null> {
  const token = randomUUID();
  const rows = await query<LeaseRow>(
    `INSERT INTO public.alexios_v4_inference_state AS state
       (agent_id, run_id, mode, lease_token, event_id, generation,
        started_at, deadline_at, updated_at)
     SELECT $1::uuid, $2::uuid, $4::text, $3::uuid, $5::uuid, 1,
       now(), now() + interval '115 seconds', now()
     WHERE EXISTS (
       SELECT 1 FROM public.alexios_sessions s
       WHERE s.agent_id = $1::uuid AND s.run_id = $2::uuid
         AND s.protocol_version = 3 AND s.power = 'running'
         AND s.desired_power = 'running')
     ON CONFLICT (agent_id) DO UPDATE SET
       run_id = EXCLUDED.run_id,
       mode = EXCLUDED.mode,
       lease_token = EXCLUDED.lease_token,
       event_id = EXCLUDED.event_id,
       generation = state.generation + 1,
       started_at = now(),
       deadline_at = EXCLUDED.deadline_at,
       updated_at = now()
     -- Vercel's longest event handler is 120s; never steal a live lease.
     -- An abandoned execution can be reclaimed only after 150s.
     WHERE state.mode = 'idle'
       OR state.deadline_at < now() - interval '35 seconds'
     RETURNING generation`,
    [agentId, runId, token, mode, eventId],
  );
  if (!rows[0]) return null;
  return {token, generation: Number(rows[0].generation), agentId, runId, mode};
}

export async function releaseInference(lease: InferenceLease): Promise<void> {
  await query(
    `UPDATE public.alexios_v4_inference_state
     SET mode = 'idle', lease_token = NULL, event_id = NULL,
         started_at = NULL, deadline_at = NULL, updated_at = now()
     WHERE agent_id = $1::uuid AND run_id = $2::uuid
       AND lease_token = $3::uuid AND generation = $4::bigint`,
    [lease.agentId, lease.runId, lease.token, lease.generation],
  );
}

/** A floor already accepted into Neon supersedes unstarted OBSERVE work.
 * Its RESPOND will see the transcript through FRESH_FLOOR_TURNS_SQL.
 * Do not mark skipped turns obsolete: the floor needs to read them.
 */
export async function floorCoveringTurn(
  agentId: string, runId: string, sequence: number,
): Promise<boolean> {
  const rows = await query<{covered: boolean}>(
    `SELECT EXISTS (
       SELECT 1 FROM public.alexios_v3_events floor
       WHERE floor.agent_id = $1::uuid AND floor.run_id = $2::uuid
         AND floor.event_type = 'floor_open'
         AND floor.sequence > $3::bigint
         AND floor.status IN ('pending', 'running', 'processed')
         AND NOT EXISTS (
           SELECT 1 FROM public.alexios_v3_events boundary
           WHERE boundary.agent_id = floor.agent_id
             AND boundary.run_id = floor.run_id
             AND boundary.event_type = 'floor_open'
             AND boundary.sequence > $3::bigint
             AND boundary.sequence < floor.sequence
         )
     ) AS covered`,
    [agentId, runId, sequence],
  );
  return rows[0]?.covered === true;
}

/** Don't start a new concurrent request just because the first model timed
 * out: the caller may retry this lock for a bounded interval and then use
 * the queued recovery path, which also requires a lease.
 */
export async function waitForInference(
  agentId: string, runId: string, eventId: string, mode: InferenceMode,
  maxWaitMs: number,
): Promise<InferenceLease | null> {
  const end = Date.now() + maxWaitMs;
  do {
    const lease = await acquireInference(agentId, runId, eventId, mode);
    if (lease) return lease;
    if (Date.now() >= end) break;
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(150, Math.max(0, end - Date.now()))));
  } while (Date.now() < end);
  return null;
}
