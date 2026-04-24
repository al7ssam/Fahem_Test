import type { Pool } from "pg";

export type ResultMessages = {
  winner: string;
  loser: string;
  tie: string;
};

const DEFAULTS: ResultMessages = {
  winner: "لقد فزت يا مطنوخ",
  loser: "لقد خسرت يا فاشل",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
};

export async function getResultMessages(pool: Pool): Promise<ResultMessages> {
  try {
    const r = await pool.query<{
      winner_text: string;
      loser_text: string;
      tie_text: string;
    }>(
      `SELECT winner_text, loser_text, tie_text
       FROM game_result_copy
       WHERE id = 1`,
    );
    const row = r.rows[0];
    if (!row) return DEFAULTS;
    return {
      winner: row.winner_text || DEFAULTS.winner,
      loser: row.loser_text || DEFAULTS.loser,
      tie: row.tie_text || DEFAULTS.tie,
    };
  } catch {
    return DEFAULTS;
  }
}
