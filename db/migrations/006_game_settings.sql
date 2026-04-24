INSERT INTO app_settings (key, value)
VALUES
  ('game_max_study_rounds', '3'),
  ('game_study_round_size', '8'),
  ('game_study_phase_ms', '60000')
ON CONFLICT (key) DO NOTHING;
