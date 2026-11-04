import "server-only";
import { randomUUID } from "node:crypto";
import { askModel } from "@/lib/ambient-model";
import { query, type Word } from "@/lib/agent-db";
import { sessionFor, connected, type V2Session } from "@/lib/v2/agent-service";

const SESSION_SQL = "public.alexios_sessions";

type Claim = {
  inference_words: Word[];
  context_text: string;
  expression_id: V2Session["expression_id"];
  epoch: number | string;
  session_id: string;
};

export async function analyzePendingV2(agentId: string) {
  const state = await sessionFor(agentId);
  if (!connected(state) || state.power !== "running" || state.desired_power !== "running") {
    return { accepted: false, reason: "offline-or-stopped" };
  }
  const token = randomUUID();
  const rows = await query<Claim>(
    `UPDATE ${SESSION_SQL} SET
       inference_words = CASE WHEN inference_token IS NULL THEN pending_words ELSE inference_words || pending_words END,
       pending_words = '[]'::jsonb,
       inference_token = $2::uuid,
       inference_started_at = now(),
       version = version + 1, updated_at = now()
     WHERE agent_id = $1::uuid
       AND power = 'running' AND desired_power = 'running'
       AND last_poll_at >= now() - interval '45 seconds'
       AND (inference_token IS NULL OR inference_started_at < now() - interval '120 seconds')
       AND (jsonb_array_length(pending_words) > 0 OR jsonb_array_length(inference_words) > 0)
     RETURNING inference_words, context_text, expression_id, epoch, session_id`,
    [agentId, token],
  );
  if (!rows[0]) return { accepted: false, reason: "silent-or-processing" };
  const data = rows[0];

  try {
    const decision = await askModel(data.context_text, data.expression_id, data.inference_words);
    const committed = await query<{ session_id: string }>(
      `WITH changed AS (
        UPDATE public.alexios_sessions SET
          context_text = $3,
          expression_id = $4,
          speech_text = CASE WHEN $5 = '' THEN speech_text ELSE $5 END,
          speech_seq = speech_seq + CASE WHEN $5 = '' THEN 0 ELSE 1 END,
          speech_at = CASE WHEN $5 = '' THEN speech_at ELSE now() END,
          last_ai_at = now(), last_error = NULL,
          inference_token = NULL, inference_started_at = NULL,
          inference_words = '[]'::jsonb,
          version = version + 1, updated_at = now()
        WHERE agent_id = $1::uuid AND inference_token = $2::uuid AND epoch = $6
          AND power = 'running' AND desired_power = 'running'
        RETURNING session_id, context_text, expression_id
      ), logged AS (
        INSERT INTO public.alexios_inference_history(session_id, speech, pose, context_text)
        SELECT session_id, $5, expression_id, context_text FROM changed RETURNING id
      )
      SELECT session_id FROM changed`,
      [agentId, token, decision.context || data.context_text,
        decision.pose, decision.speech, data.epoch],
    );
    if (!committed[0]) return { accepted: false, reason: "superseded" };
    return { accepted: true, spoke: !!decision.speech, pose: decision.pose };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha de inferencia";
    await query(
      `UPDATE public.alexios_sessions SET
        pending_words = inference_words || pending_words,
        inference_words = '[]'::jsonb,
        inference_token = NULL, inference_started_at = NULL,
        last_error = $3, version = version + 1, updated_at = now()
       WHERE agent_id = $1::uuid AND inference_token = $2::uuid`,
      [agentId, token, message.slice(0,160)],
    );
    throw error;
  }
}
