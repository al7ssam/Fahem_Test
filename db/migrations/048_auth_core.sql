CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  display_name TEXT,
  avatar_url TEXT,
  primary_email TEXT,
  is_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.user_emails (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  email_original TEXT NOT NULL,
  email_canonical TEXT NOT NULL,
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, email_canonical)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_emails_canonical_unique
  ON public.user_emails (email_canonical)
  WHERE is_verified = TRUE;

CREATE TABLE IF NOT EXISTS public.user_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT,
  provider_email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  profile_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
  ON public.user_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_user_identities_provider_email
  ON public.user_identities (provider, provider_email);
