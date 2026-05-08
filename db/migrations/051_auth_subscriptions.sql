CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id TEXT PRIMARY KEY,
  name_ar TEXT NOT NULL,
  billing_provider TEXT,
  price_minor INTEGER NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'SAR',
  interval_key TEXT NOT NULL DEFAULT 'month',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.subscription_plans (id, name_ar, billing_provider, price_minor, currency, interval_key)
VALUES
  ('free', 'مجاني', NULL, 0, 'SAR', 'month')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES public.subscription_plans(id),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  provider_subscription_id TEXT,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_status
  ON public.user_subscriptions (user_id, status);
