import type { Pool } from "pg";

export type QuestionRow = {
  id: number;
  prompt: string;
  options: string[];
  correct_index: number;
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
    SELECT id, prompt, options, correct_index
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
  };
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
