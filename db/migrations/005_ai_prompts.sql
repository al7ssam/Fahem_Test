CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_settings (key, value)
VALUES
  (
    'prompt_direct',
    'Generate multiple-choice quiz questions in JSON array format for direct mode. Each item must contain: prompt (string), options (array of 4 strings), correctIndex (0-3), difficulty (optional string). Return JSON only.'
  ),
  (
    'prompt_study',
    'Generate multiple-choice quiz questions in JSON array format for study mode. Each item must contain: prompt (string), options (array of 4 strings), correctIndex (0-3), and studyBody (clear study note text for the same question). Return JSON only.'
  )
ON CONFLICT (key) DO NOTHING;
