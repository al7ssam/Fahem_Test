-- ملف شخصي 1:1 مع المستخدم؛ افتراض الدولة SA؛ لا تخزين أسماء دول أو أعلام.

CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  birth_date DATE,
  country_code CHAR(2) NOT NULL DEFAULT 'SA',
  profile_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.trg_user_profiles_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_profiles_updated_at ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON public.user_profiles
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_user_profiles_set_updated_at();

CREATE OR REPLACE FUNCTION public.trg_users_insert_default_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, country_code)
  VALUES (NEW.id, 'SA');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_insert_default_profile ON public.users;
CREATE TRIGGER trg_users_insert_default_profile
  AFTER INSERT ON public.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.trg_users_insert_default_profile();

INSERT INTO public.user_profiles (user_id, country_code)
SELECT u.id, 'SA'
FROM public.users u
WHERE NOT EXISTS (
  SELECT 1 FROM public.user_profiles p WHERE p.user_id = u.id
);
