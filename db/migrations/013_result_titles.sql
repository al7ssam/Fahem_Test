ALTER TABLE game_result_copy
  ADD COLUMN IF NOT EXISTS winner_title TEXT NOT NULL DEFAULT 'فزت!',
  ADD COLUMN IF NOT EXISTS loser_title TEXT NOT NULL DEFAULT 'لقد خسرت يا فاشل',
  ADD COLUMN IF NOT EXISTS tie_title TEXT NOT NULL DEFAULT 'تعادل كامل';

UPDATE game_result_copy
SET
  winner_title = COALESCE(NULLIF(btrim(winner_title), ''), 'فزت!'),
  loser_title = COALESCE(NULLIF(btrim(loser_title), ''), 'لقد خسرت يا فاشل'),
  tie_title = COALESCE(NULLIF(btrim(tie_title), ''), 'تعادل كامل')
WHERE id = 1;
