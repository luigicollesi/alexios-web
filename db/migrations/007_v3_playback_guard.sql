-- A short-lived, authenticated playback lease makes the V3 server deaf only
-- while the browser is actually rendering Alexios' synthesized voice.
-- Each browser playback owns a lease. Expiry handles crashes and closed tabs.
CREATE TABLE IF NOT EXISTS public.alexios_v3_playbacks (
  agent_id uuid NOT NULL REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  playback_id uuid NOT NULL,
  run_id uuid NOT NULL,
  speech_seq bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, playback_id)
);

CREATE INDEX IF NOT EXISTS alexios_v3_playbacks_active_idx
  ON public.alexios_v3_playbacks(agent_id, run_id, expires_at);
