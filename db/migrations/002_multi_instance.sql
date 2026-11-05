-- Alexios Web V2: esquema aditivo para multiplas instancias.
-- Aplicar primeiro em branch de desenvolvimento do Neon.
CREATE TABLE IF NOT EXISTS public.alexios_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_hash text NOT NULL UNIQUE CHECK (instance_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.alexios_sessions
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.alexios_instances(id) ON DELETE CASCADE;
ALTER TABLE public.alexios_sessions
  ADD COLUMN IF NOT EXISTS run_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS alexios_sessions_agent_id_uidx
  ON public.alexios_sessions(agent_id) WHERE agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.alexios_dashboard_sessions (
  session_hash text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  agent_id uuid NOT NULL REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alexios_dashboard_sessions_agent_idx
  ON public.alexios_dashboard_sessions(agent_id, expires_at DESC);
CREATE TABLE IF NOT EXISTS public.alexios_authorization_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alexios_authorization_attempts_source_idx
  ON public.alexios_authorization_attempts(source_hash, created_at DESC);
CREATE TABLE IF NOT EXISTS public.alexios_inference_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  epoch bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS alexios_inference_jobs_pending_idx
  ON public.alexios_inference_jobs(status, created_at)
  WHERE status IN ('pending', 'running');
