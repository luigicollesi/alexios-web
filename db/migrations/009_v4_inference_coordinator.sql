-- V4 serialized inference: one model lease per instance.
-- Additive only. All prior V3 tables, data and queues remain intact.
CREATE TABLE IF NOT EXISTS public.alexios_v4_inference_state (
  agent_id uuid PRIMARY KEY REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'idle'
    CHECK (mode IN ('idle', 'observe', 'respond', 'recovering')),
  lease_token uuid,
  event_id uuid,
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  started_at timestamptz,
  deadline_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT alexios_v4_inference_lease_check CHECK (
    (mode = 'idle' AND lease_token IS NULL)
    OR (mode <> 'idle' AND lease_token IS NOT NULL)
  )
);
