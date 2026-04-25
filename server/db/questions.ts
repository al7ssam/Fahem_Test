import type { Pool } from "pg";

export type QuestionRow = {
  id: number;
  prompt: string;
  options: string[];
  correct_index: number;
  study_body?: string | null;
  subcategory_key?: string;
};

export type QuestionFilter = {
  subcategoryKey?: string | null;
};

export async function getRandomQuestion(
  pool: Pool,
  excludeIds: number[],
  requireStudyBody = false,
  filter?: QuestionFilter,
): Promise<QuestionRow | null> {
  const params: unknown[] = [];
  const whereParts: string[] = [];
  if (excludeIds.length > 0) {
    params.push(excludeIds);
    whereParts.push(`id != ALL($${params.length}::int[])`);
  }
  if (requireStudyBody) {
    whereParts.push(`study_body IS NOT NULL AND btrim(study_body) <> ''`);
  }
  if (filter?.subcategoryKey) {
    params.push(filter.subcategoryKey);
    whereParts.push(`subcategory_key = $${params.length}`);
  }
  const where =
    whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  const sql = `
    SELECT id, prompt, options, correct_index, study_body, subcategory_key
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
    subcategory_key: string;
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
    subcategory_key: row.subcategory_key,
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
  filter?: QuestionFilter,
): Promise<QuestionRow[]> {
  const out: QuestionRow[] = [];
  const exclude = [...excludeIds];
  for (let i = 0; i < count; i++) {
    const q = await getRandomQuestion(pool, exclude, false, filter);
    if (!q) break;
    exclude.push(q.id);
    out.push(q);
  }
  return out;
}

export async function countQuestionsBySubcategory(
  pool: Pool,
  subcategoryKey: string,
  requireStudyBody = false,
): Promise<number> {
  const where = requireStudyBody
    ? `WHERE subcategory_key = $1 AND study_body IS NOT NULL AND btrim(study_body) <> ''`
    : `WHERE subcategory_key = $1`;
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM questions ${where}`,
    [subcategoryKey],
  );
  return Number(r.rows[0]?.c ?? 0);
}
