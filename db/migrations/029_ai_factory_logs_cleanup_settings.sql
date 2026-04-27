INSERT INTO app_settings (key, value)
VALUES
  ('ai_factory_logs_cleanup_enabled', '0'),
  ('ai_factory_logs_cleanup_threshold_days', '30'),
  ('ai_factory_logs_cleanup_last_run_date', '')
ON CONFLICT (key) DO NOTHING;
