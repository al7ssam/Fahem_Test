CREATE INDEX IF NOT EXISTS idx_auth_events_event_created
  ON public.auth_events (event_type, created_at DESC);
