CREATE TABLE IF NOT EXISTS game_result_copy (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  winner_text TEXT NOT NULL,
  loser_text TEXT NOT NULL,
  tie_text TEXT NOT NULL
);

INSERT INTO game_result_copy (id, winner_text, loser_text, tie_text)
VALUES (
  1,
  'لقد فزت يا مطنوخ',
  'لقد خسرت يا فاشل',
  'تعادل أو لا فائز — حاول مرة أخرى!'
)
ON CONFLICT (id) DO NOTHING;
