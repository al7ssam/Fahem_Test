ALTER TABLE public.user_sessions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.auth_events
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES public.user_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'auth_events'
      AND column_name = 'details_json'
  ) THEN
    EXECUTE $m$
      UPDATE public.auth_events
      SET metadata_json = COALESCE(metadata_json, details_json, '{}'::jsonb)
      WHERE metadata_json IS NULL OR metadata_json = '{}'::jsonb
    $m$;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_auth_events_session_created
  ON public.auth_events (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;
