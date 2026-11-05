-- V2 reliability: window-level inference jobs and atomic per-source login limits.
ALTER TABLE public.alexios_inference_jobs ADD COLUMN IF NOT EXISTS source_capture_id text;
ALTER TABLE public.alexios_inference_jobs ADD COLUMN IF NOT EXISTS source_window_index integer;
CREATE UNIQUE INDEX IF NOT EXISTS alexios_inference_jobs_window_uq
  ON public.alexios_inference_jobs(agent_id, source_capture_id, source_window_index)
  WHERE source_capture_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.alexios_auth_rate_limits (
  source_hash text PRIMARY KEY CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
