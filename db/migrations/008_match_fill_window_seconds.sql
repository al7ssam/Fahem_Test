INSERT INTO app_settings (key, value)
VALUES ('match_fill_window_seconds', '5')
ON CONFLICT (key) DO NOTHING;
