INSERT INTO app_settings (key, value)
VALUES ('game_question_ms', '15000')
ON CONFLICT (key) DO NOTHING;
