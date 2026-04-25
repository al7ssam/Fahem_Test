INSERT INTO app_settings (key, value) VALUES
  ('keys_small_streak_reward', '1')
ON CONFLICT (key) DO NOTHING;
