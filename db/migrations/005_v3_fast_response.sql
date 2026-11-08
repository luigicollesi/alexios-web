-- V3 fast-response path: additive and backward-compatible with queued floor inference.
-- "legacy" preserves behavior for previously stored events and rollback.
ALTER TABLE public.alexios_v3_events
  ADD COLUMN IF NOT EXISTS fast_status text NOT NULL DEFAULT 'legacy'
    CHECK (fast_status IN (
      'legacy','pending','running','published','silent','revoked','timed_out'
    )),
  ADD COLUMN IF NOT EXISTS fast_token uuid,
  ADD COLUMN IF NOT EXISTS fast_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS fast_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS fast_model_ms integer,
  ADD COLUMN IF NOT EXISTS fast_error text;
