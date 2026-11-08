-- V3 only; additive migration. Apply before deploying code that reads context_revision.
-- Existing context_text and character pose remain unchanged.
ALTER TABLE public.alexios_sessions
  ADD COLUMN IF NOT EXISTS context_revision bigint NOT NULL DEFAULT 0
    CHECK (context_revision >= 0);

-- NULL indicates a legacy/OBSERVE event or a Fast floor not yet finalized.
ALTER TABLE public.alexios_v3_events
  ADD COLUMN IF NOT EXISTS fast_context_applied boolean;

-- Efficient lookup of the last consumed response window, even after
-- thousands of turns and prior runs for the same instance.
CREATE INDEX IF NOT EXISTS alexios_v3_events_floor_boundary_idx
  ON public.alexios_v3_events(agent_id, run_id, sequence DESC)
  WHERE event_type = 'floor_open';

CREATE INDEX IF NOT EXISTS alexios_v3_events_turn_window_idx
  ON public.alexios_v3_events(agent_id, run_id, sequence DESC)
  WHERE event_type IN ('turn_end', 'turn_chunk');
