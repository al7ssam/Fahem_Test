INSERT INTO app_settings (key, value)
VALUES
  (
    'prompt_direct',
    'Generate multiple-choice quiz questions in JSON array format for direct mode. Each item must contain: prompt (string), options (array of 2 or 4 strings), correctIndex (0-based and within options length), difficulty (optional string). Return JSON only.'
  ),
  (
    'prompt_study',
    'Generate multiple-choice quiz questions in JSON array format for study mode. Each item must contain: prompt (string), options (array of 2 or 4 strings), correctIndex (0-based and within options length), studyBody (clear study note text), and difficulty. Return JSON only.'
  )
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value;
