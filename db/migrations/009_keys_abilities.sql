INSERT INTO app_settings (key, value) VALUES
  ('keys_streak_per_key', '5'),
  ('keys_mega_streak', '8'),
  ('keys_mega_reward', '5'),
  ('keys_max_per_player', '20'),
  ('keys_skill_boost_percent', '30'),
  ('keys_skill_boost_max_multiplier', '3'),
  ('keys_heart_attack_cost', '2'),
  ('keys_shield_cost', '2'),
  ('keys_reveal_cost', '2'),
  ('keys_attacks_enabled', '1'),
  ('keys_drop_rate', '1'),
  ('keys_reveal_direct_question_span', '0')
ON CONFLICT (key) DO NOTHING;
