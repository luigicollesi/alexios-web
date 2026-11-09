/**
 * A response floor consumes only the transcriptions since the previous floor
 * in the same Python run. A floor is a boundary even when Alexios stays silent,
 * is revoked, or the provider fails: older questions must not be asked again.
 *
 * This is intentionally independent from the persistent context_text, which
 * OBSERVE maintains as a semantic summary rather than as replayable user input.
 */
import type {ResponseCues} from "./response-intent";

export type FloorTurn = {
  observed_speaker_count?: number | string | null;
  run_id: string;
  speaker_id: string | null;
  transcript: string | null;
};

export const FRESH_FLOOR_TURNS_SQL = `
  SELECT e.run_id, e.speaker_id, e.transcript,
    (
      SELECT COUNT(DISTINCT nearby.speaker_id)
      FROM public.alexios_v3_events nearby
      WHERE nearby.agent_id = $1::uuid
        AND nearby.run_id = $2::uuid
        AND nearby.sequence < $3::bigint
        AND nearby.received_at >= now() - interval '3 minutes'
        AND nearby.event_type IN ('turn_end', 'turn_chunk')
        AND nearby.status NOT IN ('obsolete', 'failed')
        AND nearby.speaker_id IS NOT NULL
        AND nearby.speaker_id <> 'speaker_unknown'
    ) AS observed_speaker_count
  FROM public.alexios_v3_events e
  WHERE e.agent_id = $1::uuid
    AND e.run_id = $2::uuid
    AND e.sequence < $3::bigint
    AND e.sequence > COALESCE((
      SELECT MAX(prior.sequence)
      FROM public.alexios_v3_events prior
      WHERE prior.agent_id = $1::uuid
        AND prior.run_id = $2::uuid
        AND prior.event_type = 'floor_open'
        AND prior.sequence < $3::bigint
    ), 0)
    AND e.event_type IN ('turn_end', 'turn_chunk')
    AND e.status NOT IN ('obsolete', 'failed')
  ORDER BY e.sequence DESC
  LIMIT 24
`;

/** SQL returns newest first; prompt must read chronological speech. */
export function formatFreshFloorTurns(
  rows: FloorTurn[], perTurnLimit = 350, totalLimit = 2400,
): string {
  return [...rows].reverse().map(row => {
    const speaker = (row.speaker_id || "speaker_unknown").slice(0, 24);
    const text = (row.transcript || "").replace(/\s+/g, " ").trim().slice(0, perTurnLimit);
    return text ? "[" + row.run_id.slice(0, 8) + "/" + speaker + "]: " + text : "";
  }).filter(Boolean).join("\n").slice(-totalLimit);
}

/** Signals are scoped to this run/response window. No claim about room occupancy. */
export function responseCuesForFloor(
  rows: FloorTurn[], silenceMs: string | number | null | undefined,
): ResponseCues {
  const pause = Number(silenceMs);
  const count = rows.length ? Number(rows[0]?.observed_speaker_count) : NaN;
  return {
    silenceMs: silenceMs !== null && silenceMs !== undefined &&
      Number.isFinite(pause) && pause >= 250 && pause <= 300_000
      ? pause : undefined,
    observedSpeakers: Number.isInteger(count) && count >= 0 && count <= 100
      ? count : null,
  };
}
