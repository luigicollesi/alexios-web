-- Alexios runtime state (single active device today; session IDs permit future isolation).
CREATE TABLE IF NOT EXISTS public.alexios_sessions (
  session_id text PRIMARY KEY,
  instance_id text,
  last_poll_at timestamptz,
  power text NOT NULL DEFAULT 'stopped'
    CHECK (power IN ('running','stopped','starting','stopping')),
  desired_power text NOT NULL DEFAULT 'running'
    CHECK (desired_power IN ('running','stopped')),
  command_seq bigint NOT NULL DEFAULT 0,
  speech_seq bigint NOT NULL DEFAULT 0,
  speech_text text NOT NULL DEFAULT '',
  speech_at timestamptz,
  expression_id text NOT NULL DEFAULT 'idle'
    CHECK (expression_id IN ('idle','listening','thinking','speaking')),
  context_text text NOT NULL DEFAULT 'Nenhuma informação confirmada sobre o ambiente.',
  pending_words jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(pending_words) = 'array'),
  inference_words jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(inference_words) = 'array'),
  capture jsonb,
  blocked_capture_id text,
  epoch bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 0,
  inference_token uuid,
  inference_started_at timestamptz,
  last_ai_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alexios_power_requests (
  request_id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.alexios_sessions(session_id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('start','stop')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.alexios_inference_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.alexios_sessions(session_id) ON DELETE CASCADE,
  speech text NOT NULL DEFAULT '',
  pose text NOT NULL CHECK (pose IN ('idle','listening','thinking','speaking')),
  context_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alexios_inference_session_time_idx
  ON public.alexios_inference_history(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS alexios_power_requests_time_idx
  ON public.alexios_power_requests(created_at DESC);
INSERT INTO public.alexios_sessions(session_id) VALUES ('primary') ON CONFLICT DO NOTHING;
