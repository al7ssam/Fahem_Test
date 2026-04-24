import type { Pool } from "pg";

export type StudyCardPayload = {
  id: number;
  body: string;
  order: number;
};

export async function getStudyCardsForQuestions(
  pool: Pool,
  questionIdsOrdered: number[],
  maxCards: number,
): Promise<StudyCardPayload[]> {
  if (questionIdsOrdered.length === 0 || maxCards <= 0) return [];
  const out: StudyCardPayload[] = [];
  let order = 0;
  for (const qid of questionIdsOrdered) {
    if (out.length >= maxCards) break;
    const res = await pool.query<{
      id: number;
      body: string;
      sort_order: number;
    }>(
      `SELECT id, body, sort_order
       FROM question_study_cards
       WHERE question_id = $1
       ORDER BY sort_order ASC, id ASC`,
      [qid],
    );
    for (const row of res.rows) {
      if (out.length >= maxCards) break;
      out.push({ id: row.id, body: row.body, order: order++ });
    }
  }
  return out;
}
