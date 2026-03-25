ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS timezone varchar(100);

ALTER TABLE emergencies
  ADD COLUMN IF NOT EXISTS expires_at timestamp,
  ADD COLUMN IF NOT EXISTS audit_note text,
  ADD COLUMN IF NOT EXISTS clear_reason text;
