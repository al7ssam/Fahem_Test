import type { Pool } from "pg";

export type QuestionRow = {
  id: number;
  prompt: string;
  options: string[];
  correct_index: number;
  study_body?: string | null;
};

export async function getRandomQuestion(
  pool: Pool,
  excludeIds: number[],
): Promise<QuestionRow | null> {
  const params: unknown[] = [];
  let where = "";
  if (excludeIds.length > 0) {
    params.push(excludeIds);
    where = `WHERE id != ALL($1::int[])`;
  }
  const sql = `
    SELECT id, prompt, options, correct_index, study_body
    FROM questions
    ${where}
    ORDER BY RANDOM()
    LIMIT 1
  `;
  const res = await pool.query<{
    id: number;
    prompt: string;
    options: unknown;
    correct_index: number;
    study_body: string | null;
  }>(sql, params);
  const row = res.rows[0];
  if (!row) return null;
  const options = Array.isArray(row.options)
    ? (row.options as string[])
    : JSON.parse(String(row.options)) as string[];
  return {
    id: row.id,
    prompt: row.prompt,
    options,
    correct_index: row.correct_index,
    study_body: row.study_body,
  };
}

/** بطاقة مراجعة واحدة لكل سؤال من عمود study_body (لحدث study_phase) */
export type StudyPhaseCardPayload = {
  id: number;
  questionId: number;
  body: string;
  order: number;
};

export async function getStudyPhaseCardsFromQuestionIds(
  pool: Pool,
  questionIdsOrdered: number[],
  maxCards: number,
): Promise<StudyPhaseCardPayload[]> {
  if (questionIdsOrdered.length === 0 || maxCards <= 0) return [];
  const out: StudyPhaseCardPayload[] = [];
  let order = 0;
  for (const qid of questionIdsOrdered) {
    if (out.length >= maxCards) break;
    const res = await pool.query<{ study_body: string | null }>(
      `SELECT study_body FROM questions WHERE id = $1`,
      [qid],
    );
    const body = res.rows[0]?.study_body?.trim();
    if (!body) continue;
    out.push({
      id: qid,
      questionId: qid,
      body,
      order: order++,
    });
  }
  return out;
}

export async function getRandomQuestionBlock(
  pool: Pool,
  excludeIds: number[],
  count: number,
): Promise<QuestionRow[]> {
  const out: QuestionRow[] = [];
  const exclude = [...excludeIds];
  for (let i = 0; i < count; i++) {
    const q = await getRandomQuestion(pool, exclude);
    if (!q) break;
    exclude.push(q.id);
    out.push(q);
  }
  return out;
}
