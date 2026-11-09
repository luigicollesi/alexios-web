import "server-only";
import {query} from "@/lib/agent-db";

const LEASE_SECONDS = 6;
export type PlaybackAction = "start" | "pulse" | "finish";

/**
 * Playback is reported by an authorized dashboard, not inferred from the
 * 3–12-second avatar animation estimate. One browser owns one short lease.
 * No transcript or device identity is retained.
 */
export async function updatePlaybackV3(
  agentId: string, playbackId: string, speechSeq: number, action: PlaybackAction,
): Promise<boolean> {
  if (action === "finish") {
    await query(
      `DELETE FROM public.alexios_v3_playbacks
       WHERE agent_id = $1::uuid AND playback_id = $2::uuid
         AND speech_seq = $3::bigint`,
      [agentId, playbackId, speechSeq],
    );
    return true; // idempotent, even if the lease already expired
  }

  if (action === "pulse") {
    const rows = await query<{playback_id: string}>(
      `UPDATE public.alexios_v3_playbacks p SET
         expires_at = now() + $4::integer * interval '1 second',
         updated_at = now()
       WHERE p.agent_id = $1::uuid AND p.playback_id = $2::uuid
         AND p.speech_seq = $3::bigint AND p.expires_at > now()
         AND EXISTS (
           SELECT 1 FROM public.alexios_sessions s
           WHERE s.agent_id = p.agent_id AND s.run_id = p.run_id
             AND s.speech_seq = $3::bigint
             AND s.protocol_version = 3
             AND s.power = 'running' AND s.desired_power = 'running'
             AND s.last_poll_at > now() - interval '45 seconds'
         )
       RETURNING p.playback_id`,
      [agentId, playbackId, speechSeq, LEASE_SECONDS],
    );
    return Boolean(rows[0]);
  }

  // Limit start requests to the current freshly published response, not any
  // text or arbitrary "speaking" signal supplied by the browser.
  const rows = await query<{playback_id: string}>(
    `WITH eligible AS (
       SELECT s.agent_id, s.run_id
       FROM public.alexios_sessions s
       WHERE s.agent_id = $1::uuid AND s.speech_seq = $3::bigint
         AND s.protocol_version = 3
         AND s.power = 'running' AND s.desired_power = 'running'
         AND s.last_poll_at > now() - interval '45 seconds'
         AND s.speech_at > now() - interval '20 seconds'
     )
     INSERT INTO public.alexios_v3_playbacks
       (agent_id, playback_id, run_id, speech_seq, expires_at)
     SELECT agent_id, $2::uuid, run_id, $3::bigint,
       now() + $4::integer * interval '1 second'
     FROM eligible
     ON CONFLICT (agent_id, playback_id) DO UPDATE SET
       expires_at = EXCLUDED.expires_at,
       updated_at = now()
     WHERE alexios_v3_playbacks.run_id = EXCLUDED.run_id
       AND alexios_v3_playbacks.speech_seq = EXCLUDED.speech_seq
     RETURNING playback_id`,
    [agentId, playbackId, speechSeq, LEASE_SECONDS],
  );
  return Boolean(rows[0]);
}
