INSERT INTO app_settings (key, value) VALUES
  ('ability_skill_boost_direct_enabled', '1'),
  ('ability_skill_boost_study_enabled', '1'),
  ('ability_skip_direct_enabled', '1'),
  ('ability_skip_study_enabled', '1'),
  ('ability_attack_direct_enabled', '1'),
  ('ability_attack_study_enabled', '1'),
  ('ability_reveal_direct_enabled', '1'),
  ('ability_reveal_study_enabled', '1')
ON CONFLICT (key) DO NOTHING;
