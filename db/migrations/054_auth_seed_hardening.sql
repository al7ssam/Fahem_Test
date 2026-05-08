-- Harden admin seed invariants across environments.
-- If this migration fails, clean duplicate active emails first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_primary_email_active_unique
  ON public.users (LOWER(primary_email))
  WHERE primary_email IS NOT NULL AND deleted_at IS NULL;
