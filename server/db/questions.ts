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
  difficulty?: "easy" | "medium" | "hard" | null;
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
  if (filter?.difficulty) {
    params.push(filter.difficulty);
    whereParts.push(`difficulty = $${params.length}`);
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
  difficulty: "easy" | "medium" | "hard" | null = null,
): Promise<number> {
  const params: unknown[] = [subcategoryKey];
  const whereParts: string[] = [`subcategory_key = $1`];
  if (requireStudyBody) {
    whereParts.push(`study_body IS NOT NULL AND btrim(study_body) <> ''`);
  }
  if (difficulty) {
    params.push(difficulty);
    whereParts.push(`difficulty = $${params.length}`);
  }
  const where = `WHERE ${whereParts.join(" AND ")}`;
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM questions ${where}`,
    params,
  );
  return Number(r.rows[0]?.c ?? 0);
}

/** أوقات اختيارية من تصنيف فرعي لنمط study_then_quiz (نفس حدود Match.loadRuntimeSettings) */
export async function getStudyModeTimingOverridesBySubcategoryKey(
  pool: Pool,
  subcategoryKey: string,
): Promise<{ questionMsOverride?: number; studyPhaseMsOverride?: number } | undefined> {
  const key = String(subcategoryKey || "").trim();
  if (!key) return undefined;
  const r = await pool.query<{
    study_mode_question_ms: number | null;
    study_mode_study_phase_ms: number | null;
  }>(
    `SELECT study_mode_question_ms, study_mode_study_phase_ms
     FROM question_subcategories WHERE subcategory_key = $1 LIMIT 1`,
    [key],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  const out: { questionMsOverride?: number; studyPhaseMsOverride?: number } = {};
  if (row.study_mode_question_ms != null) {
    const q = Math.floor(Number(row.study_mode_question_ms));
    if (Number.isFinite(q)) {
      out.questionMsOverride = Math.min(120_000, Math.max(5_000, q));
    }
  }
  if (row.study_mode_study_phase_ms != null) {
    const s = Math.floor(Number(row.study_mode_study_phase_ms));
    if (Number.isFinite(s)) {
      out.studyPhaseMsOverride = Math.min(300_000, Math.max(10_000, s));
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
