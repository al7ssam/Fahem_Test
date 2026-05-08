WITH seeded_admin AS (
  INSERT INTO public.users (display_name, primary_email, is_email_verified, status)
  VALUES ('System Admin', 'admin@local.fahem', TRUE, 'active')
  ON CONFLICT DO NOTHING
  RETURNING id
),
admin_user AS (
  SELECT id FROM seeded_admin
  UNION ALL
  SELECT u.id
  FROM public.users u
  WHERE u.primary_email = 'admin@local.fahem'
  LIMIT 1
),
player_role AS (
  SELECT id FROM public.roles WHERE role_key = 'player' LIMIT 1
),
admin_role AS (
  SELECT id FROM public.roles WHERE role_key = 'admin' LIMIT 1
)
INSERT INTO public.user_roles (user_id, role_id)
SELECT au.id, ar.id
FROM admin_user au
JOIN admin_role ar ON TRUE
ON CONFLICT (user_id, role_id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role_id)
SELECT u.id, pr.id
FROM public.users u
JOIN public.roles pr ON pr.role_key = 'player'
ON CONFLICT (user_id, role_id) DO NOTHING;
