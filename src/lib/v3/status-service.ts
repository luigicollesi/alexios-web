import "server-only";
import {query, numeric} from "@/lib/agent-db";
import {latestUtteranceFromCumulative} from "@/lib/v3/transcript-delta";

type ConversationRow = {
  last_accepted_sequence: number | string;
  last_processed_sequence: number | string;
  activity_epoch: number | string;
  memory_revision: number | string;
  turn_sequence: number | string | null;
  turn_status: string | null;
  turn_speaker: string | null;
  turn_transcript: string | null;
  turn_previous_transcript: string | null;
  turn_received_at: string | null;
  floor_sequence: number | string | null;
  floor_status: string | null;
  floor_reason: string | null;
  floor_fast_status: string | null;
  floor_fast_model_ms: number | null;
  floor_fast_error: string | null;
  floor_fast_context_applied: boolean | null;
  floor_received_at: string | null;
};

/** Authenticated console only; no raw microphone samples or credentials. */
export async function statusConversationV3(agentId: string) {
  const rows = await query<ConversationRow>(
    `SELECT st.last_accepted_sequence, st.last_processed_sequence, st.activity_epoch,
        s.context_revision AS memory_revision,
        last_turn.sequence AS turn_sequence, last_turn.status AS turn_status,
        last_turn.speaker_id AS turn_speaker,
        last_turn.transcript AS turn_transcript,
        last_turn.received_at AS turn_received_at,
        prev_turn.transcript AS turn_previous_transcript,
        last_floor.sequence AS floor_sequence, last_floor.status AS floor_status,
        last_floor.last_error AS floor_reason,
        last_floor.fast_status AS floor_fast_status,
        last_floor.fast_model_ms AS floor_fast_model_ms,
        last_floor.fast_error AS floor_fast_error,
        last_floor.fast_context_applied AS floor_fast_context_applied,
        last_floor.received_at AS floor_received_at
     FROM public.alexios_v3_streams st
     JOIN public.alexios_sessions s ON s.agent_id = st.agent_id
     LEFT JOIN LATERAL (
       SELECT sequence, run_id, status, speaker_id, transcript, received_at
       FROM public.alexios_v3_events
       WHERE agent_id = st.agent_id
         AND event_type IN ('turn_end', 'turn_chunk')
       ORDER BY sequence DESC LIMIT 1
     ) last_turn ON TRUE
     LEFT JOIN LATERAL (
       SELECT e.transcript
       FROM public.alexios_v3_events e
       WHERE e.agent_id = st.agent_id
         AND e.run_id = last_turn.run_id
         AND e.sequence < last_turn.sequence
         AND e.event_type IN ('turn_end','turn_chunk')
         AND e.received_at >= last_turn.received_at - interval '45 seconds'
       ORDER BY e.sequence DESC LIMIT 1
     ) prev_turn ON TRUE
     LEFT JOIN LATERAL (
       SELECT sequence, status, last_error, fast_status, fast_model_ms,
         fast_error, fast_context_applied, received_at
       FROM public.alexios_v3_events
       WHERE agent_id = st.agent_id AND event_type = 'floor_open'
       ORDER BY sequence DESC LIMIT 1
     ) last_floor ON TRUE
     WHERE st.agent_id = $1::uuid`,
    [agentId],
  );
  const row = rows[0];
  if (!row) return null;
  const accepted = numeric(row.last_accepted_sequence);
  const processed = numeric(row.last_processed_sequence);
  return {
    acceptedSequence: accepted,
    processedSequence: processed,
    pendingCount: Math.max(0, accepted - processed),
    activityEpoch: numeric(row.activity_epoch),
    memoryRevision: numeric(row.memory_revision),
    lastTurn: row.turn_sequence === null ? null : {
      sequence: numeric(row.turn_sequence),
      speakerId: row.turn_speaker || "speaker_unknown",
      text: latestUtteranceFromCumulative(
        row.turn_transcript || "", row.turn_previous_transcript,
      ).slice(0, 300),
      status: row.turn_status || "pending",
      receivedAt: row.turn_received_at,
    },
    lastFloor: row.floor_sequence === null ? null : {
      sequence: numeric(row.floor_sequence),
      status: row.floor_status || "pending",
      reason: row.floor_reason,
      fastStatus: row.floor_fast_status ?? "legacy",
      fastModelMs: row.floor_fast_model_ms,
      fastError: row.floor_fast_error,
      fastMemoryApplied: row.floor_fast_context_applied,
      receivedAt: row.floor_received_at,
    },
  };
}
