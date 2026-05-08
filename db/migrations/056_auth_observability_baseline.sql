CREATE TABLE IF NOT EXISTS public.auth_observability_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  events_retention_days INTEGER NOT NULL DEFAULT 90 CHECK (events_retention_days BETWEEN 7 AND 3650),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.auth_observability_settings (id, events_retention_days)
VALUES (1, 90)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE VIEW public.auth_event_daily_metrics AS
SELECT
  DATE_TRUNC('day', created_at) AS day_bucket,
  event_type,
  COUNT(*)::bigint AS total
FROM public.auth_events
GROUP BY 1, 2;
