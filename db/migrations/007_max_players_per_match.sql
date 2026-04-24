INSERT INTO app_settings (key, value)
VALUES ('max_players_per_match', '10')
ON CONFLICT (key) DO NOTHING;
