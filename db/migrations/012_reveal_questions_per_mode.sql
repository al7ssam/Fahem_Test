INSERT INTO app_settings (key, value) VALUES
  ('keys_reveal_questions_direct', '4'),
  ('keys_reveal_questions_study', '4')
ON CONFLICT (key) DO NOTHING;
