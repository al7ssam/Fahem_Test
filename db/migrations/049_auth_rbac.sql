CREATE TABLE IF NOT EXISTS public.roles (
  id SMALLSERIAL PRIMARY KEY,
  role_key TEXT NOT NULL UNIQUE,
  name_ar TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.permissions (
  id SMALLSERIAL PRIMARY KEY,
  permission_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_id SMALLINT NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  permission_id SMALLINT NOT NULL REFERENCES public.permissions(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id SMALLINT NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);

INSERT INTO public.roles (role_key, name_ar)
VALUES
  ('admin', 'مدير النظام'),
  ('player', 'مستخدم')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO public.permissions (permission_key)
VALUES
  ('admin.full_access'),
  ('content.read'),
  ('content.write'),
  ('game.play')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM public.roles r
JOIN public.permissions p ON p.permission_key = 'admin.full_access'
WHERE r.role_key = 'admin'
ON CONFLICT (role_id, permission_id) DO NOTHING;
