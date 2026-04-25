INSERT INTO app_settings (key, value)
VALUES ('release_version', '1')
ON CONFLICT (key) DO NOTHING;
