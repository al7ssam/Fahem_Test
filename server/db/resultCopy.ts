import type { Pool } from "pg";

export type ResultMessages = {
  winnerTitle: string;
  loserTitle: string;
  tieTitle: string;
  winner: string;
  loser: string;
  tie: string;
};

const DEFAULTS: ResultMessages = {
  winnerTitle: "فزت!",
  loserTitle: "لقد خسرت يا فاشل",
  tieTitle: "تعادل كامل",
  winner: "لقد فزت يا مطنوخ",
  loser: "لقد خسرت يا فاشل",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
};

export async function getResultMessages(pool: Pool): Promise<ResultMessages> {
  try {
    const r = await pool.query<{
      winner_title: string;
      loser_title: string;
      tie_title: string;
      winner_text: string;
      loser_text: string;
      tie_text: string;
    }>(
      `SELECT winner_title, loser_title, tie_title, winner_text, loser_text, tie_text
       FROM game_result_copy
       WHERE id = 1`,
    );
    const row = r.rows[0];
    if (!row) return DEFAULTS;
    return {
      winnerTitle: row.winner_title || DEFAULTS.winnerTitle,
      loserTitle: row.loser_title || DEFAULTS.loserTitle,
      tieTitle: row.tie_title || DEFAULTS.tieTitle,
      winner: row.winner_text || DEFAULTS.winner,
      loser: row.loser_text || DEFAULTS.loser,
      tie: row.tie_text || DEFAULTS.tie,
    };
  } catch {
    return DEFAULTS;
  }
}
