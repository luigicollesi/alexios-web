-- V3 is strictly additive: the V2 ingestion and dashboard remain operational.
ALTER TABLE public.alexios_sessions
  ADD COLUMN IF NOT EXISTS protocol_version smallint NOT NULL DEFAULT 2
    CHECK (protocol_version IN (2, 3)),
  ADD COLUMN IF NOT EXISTS character_stance text NOT NULL DEFAULT 'hand-in-pocket'
    CHECK (character_stance IN ('crossed-arm', 'hand-in-pocket')),
  ADD COLUMN IF NOT EXISTS character_waiting_variant smallint NOT NULL DEFAULT 1
    CHECK (character_waiting_variant IN (1, 2)),
  ADD COLUMN IF NOT EXISTS character_frame text NOT NULL DEFAULT 'waiting_1'
    CHECK (character_frame IN ('listening', 'speaking', 'waiting_1', 'waiting_2')),
  ADD COLUMN IF NOT EXISTS character_speaking_until timestamptz;

CREATE TABLE IF NOT EXISTS public.alexios_v3_streams (
  agent_id uuid PRIMARY KEY REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  active_run_id uuid,
  last_accepted_sequence bigint NOT NULL DEFAULT 0 CHECK (last_accepted_sequence >= 0),
  last_processed_sequence bigint NOT NULL DEFAULT 0 CHECK (last_processed_sequence >= 0),
  activity_epoch bigint NOT NULL DEFAULT 0 CHECK (activity_epoch >= 0),
  processing_token uuid,
  processing_started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (last_processed_sequence <= last_accepted_sequence)
);

CREATE TABLE IF NOT EXISTS public.alexios_v3_events (
  event_id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES public.alexios_instances(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL
    CHECK (event_type IN ('turn_end', 'turn_chunk', 'floor_open')),
  turn_id text,
  speaker_id text,
  transcript text,
  activity_epoch bigint NOT NULL CHECK (activity_epoch >= 0),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'processed', 'obsolete', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  processed_at timestamptz,
  UNIQUE (agent_id, sequence)
);

CREATE INDEX IF NOT EXISTS alexios_v3_events_agent_pending_idx
  ON public.alexios_v3_events(agent_id, sequence)
  WHERE status IN ('pending', 'running', 'failed');

CREATE INDEX IF NOT EXISTS alexios_v3_events_run_idx
  ON public.alexios_v3_events(agent_id, run_id, received_at DESC);
