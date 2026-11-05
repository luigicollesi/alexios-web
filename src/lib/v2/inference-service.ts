import "server-only";
import { randomUUID } from "node:crypto";
import { askModel } from "@/lib/ambient-model";
import { query, type AgentPose, type Word } from "@/lib/agent-db";

type Claim = {
  agent_id: string;
  session_id: string;
  inference_words: Word[];
  context_text: string;
  expression_id: AgentPose;
  epoch: number | string;
};
type JobState = {
  id: string;
  agent_id: string;
  status: "pending" | "running" | "succeeded" | "failed" | "superseded";
  job_epoch: number | string;
  session_epoch: number | string;
  waiting: number | string;
  processing: boolean;
  protocol_version: number;
};

/** Temporary backpressure, not a failed inference. Keep message pending. */
export class InferenceBusyError extends Error {
  constructor() {
    super("An inference for this instance is already running.");
    this.name = "InferenceBusyError";
  }
}

// The database, not the queue delivery, is the source of truth.
// Duplicate messages and simultaneous workers may claim at most one inference.
export async function analyzeJobV2(jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new Error("Invalid inference job id.");

  const token = randomUUID();
  const claim = await query<Claim>(
    `WITH requested AS (
      SELECT id, agent_id, epoch FROM public.alexios_inference_jobs
      WHERE id = $1::uuid AND status IN ('pending', 'running')
    ), reserved AS (
      UPDATE public.alexios_sessions s SET
        inference_words = CASE WHEN s.inference_token IS NULL
          THEN s.pending_words ELSE s.inference_words || s.pending_words END,
        pending_words = '[]'::jsonb,
        inference_token = $2::uuid, inference_started_at = now(),
        version = version + 1, updated_at = now()
      WHERE s.agent_id = (SELECT agent_id FROM requested)
        AND s.epoch = (SELECT epoch FROM requested)
        AND s.protocol_version = 2
        AND (s.inference_token IS NULL
          OR s.inference_started_at < now() - interval '120 seconds')
        AND (jsonb_array_length(s.pending_words) > 0
          OR jsonb_array_length(s.inference_words) > 0)
      RETURNING s.agent_id, s.session_id, s.inference_words,
        s.context_text, s.expression_id, s.epoch
    ), marked AS (
      UPDATE public.alexios_inference_jobs SET
        status = 'running', attempts = attempts + 1,
        started_at = now(), last_error = NULL
      WHERE id = $1::uuid AND EXISTS(SELECT 1 FROM reserved)
      RETURNING id
    )
    SELECT * FROM reserved WHERE EXISTS(SELECT 1 FROM marked)`,
    [jobId, token],
  );

  if (!claim[0]) {
    const statuses = await query<JobState>(
      `SELECT j.id, j.agent_id, j.status,
        j.epoch AS job_epoch, s.epoch AS session_epoch,
        jsonb_array_length(s.pending_words) + jsonb_array_length(s.inference_words) AS waiting,
        s.inference_token IS NOT NULL AS processing,
        s.protocol_version
       FROM public.alexios_inference_jobs j
       JOIN public.alexios_sessions s ON s.agent_id = j.agent_id
       WHERE j.id = $1::uuid`, [jobId],
    );
    const job = statuses[0];
    if (!job || ["succeeded", "failed", "superseded"].includes(job.status)) {
      return { accepted: false, reason: "finished-or-missing" };
    }
    if (job.protocol_version !== 2 || String(job.job_epoch) !== String(job.session_epoch)) {
      await query(`UPDATE public.alexios_inference_jobs
        SET status = 'superseded', finished_at = now() WHERE id = $1::uuid`, [jobId]);
      return { accepted: false, reason: "superseded" };
    }
    if (!job.processing && Number(job.waiting) === 0) {
      await query(`UPDATE public.alexios_inference_jobs
        SET status = 'succeeded', finished_at = now() WHERE id = $1::uuid`, [jobId]);
      return { accepted: false, reason: "already-drained" };
    }
    // Another worker owns the words. Retry rather than silently dropping this delivery.
    throw new InferenceBusyError();
  }

  const data = claim[0];
  try {
    const result = await askModel(data.context_text, data.expression_id, data.inference_words);
    const completed = await query<{ id: string }>(
      `WITH committed AS (
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
          AND protocol_version = 2
        RETURNING session_id, context_text, expression_id
      ), logged AS (
        INSERT INTO public.alexios_inference_history(session_id, speech, pose, context_text)
        SELECT session_id, $5, expression_id, context_text FROM committed
        RETURNING id
      ), done AS (
        UPDATE public.alexios_inference_jobs SET
          status = 'succeeded', finished_at = now(), last_error = NULL
        WHERE id = $7::uuid AND EXISTS(SELECT 1 FROM committed)
        RETURNING id
      )
      SELECT id FROM done`,
      [data.agent_id, token, result.context || data.context_text,
        result.pose, result.speech, data.epoch, jobId],
    );
    if (!completed[0]) return { accepted: false, reason: "superseded" };
    return { accepted: true, spoke: Boolean(result.speech), pose: result.pose };
  } catch (error) {
    const issue = error instanceof Error ? error.message : "Inference failed";
    const recovery = await query<{ status: string }>(
      `WITH restored AS (
        UPDATE public.alexios_sessions SET
          pending_words = inference_words || pending_words,
          inference_words = '[]'::jsonb,
          inference_token = NULL, inference_started_at = NULL,
          last_error = $3, version = version + 1, updated_at = now()
        WHERE agent_id = $1::uuid AND inference_token = $2::uuid
        RETURNING session_id
      )
      UPDATE public.alexios_inference_jobs SET
        status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        started_at = NULL,
        finished_at = CASE WHEN attempts >= 5 THEN now() ELSE NULL END,
        last_error = $3
      WHERE id = $4::uuid AND EXISTS(SELECT 1 FROM restored)
      RETURNING status`,
      [data.agent_id, token, issue.slice(0, 160), jobId],
    );
    if (recovery[0]?.status === "failed") return { accepted: false, reason: "retry-limit" };
    throw error;
  }
}
