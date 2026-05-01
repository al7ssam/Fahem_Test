import type { Pool } from "pg";
import type { QuestionRow, StudyPhaseCardPayload } from "./questions";
import { getPool } from "./pool";

export type LessonCategoryAdmin = {
  id: number;
  parentId: number | null;
  nameAr: string;
  icon: string;
  sortOrder: number;
  isActive: boolean;
};

export type LessonAdminSummary = {
  id: number;
  lessonCategoryId: number | null;
  categoryNameAr: string | null;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  defaultStudyCardMs: number;
  isPublished: boolean;
  sortOrder: number;
  itemCount: number;
};

export type LessonItemAdmin = {
  sortOrder: number;
  questionId: number;
  answerMs: number | null;
  studyCardMs: number | null;
  promptPreview: string;
  hasStudyBody: boolean;
};

export type LessonSectionAdmin = {
  id: number;
  sortOrder: number;
  titleAr: string | null;
  items: LessonItemAdmin[];
};

export type LessonAdminDetail = {
  lesson: Omit<LessonAdminSummary, "itemCount"> & { itemCount: number };
  sections: LessonSectionAdmin[];
};

export type LessonPlaybackStep = {
  sortOrder: number;
  questionId: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  studyBody: string | null;
  effectiveAnswerMs: number;
  effectiveStudyCardMs: number;
};

export type LessonPlaybackSection = {
  id: number;
  sortOrder: number;
  titleAr: string | null;
  steps: LessonPlaybackStep[];
};

export type LessonPlaybackPayload = {
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  defaultStudyCardMs: number;
  category: { id: number; nameAr: string; icon: string } | null;
  /** أقسام الدرس بالترتيب؛ كل قسم يضم خطواته (بطاقات + أسئلة لنفس المجموعة). */
  sections: LessonPlaybackSection[];
  /** كل الخطوات بالترتيب الكامل (للتوافق مع منطق قديم يعتمد على قائمة مسطحة). */
  steps: LessonPlaybackStep[];
};

function parseOptions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  return JSON.parse(String(raw)) as string[];
}

export async function listLessonCategories(pool: Pool): Promise<LessonCategoryAdmin[]> {
  const r = await pool.query<{
    id: number;
    parent_id: number | null;
    name_ar: string;
    icon: string;
    sort_order: number;
    is_active: boolean;
  }>(
    `SELECT id, parent_id, name_ar, icon, sort_order, is_active
     FROM lesson_categories
     ORDER BY parent_id NULLS FIRST, sort_order ASC, id ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    nameAr: row.name_ar,
    icon: row.icon,
    sortOrder: row.sort_order,
    isActive: row.is_active,
  }));
}

export async function insertLessonCategory(params: {
  parentId: number | null;
  nameAr: string;
  icon: string;
  sortOrder: number;
  isActive: boolean;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO lesson_categories (parent_id, name_ar, icon, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [params.parentId, params.nameAr.trim(), params.icon.trim() || "📖", params.sortOrder, params.isActive],
  );
  const id = r.rows[0]?.id;
  if (id == null) throw new Error("insert_lesson_category_failed");
  return id;
}

export async function updateLessonCategory(params: {
  id: number;
  parentId?: number | null;
  nameAr?: string;
  icon?: string;
  sortOrder?: number;
  isActive?: boolean;
}): Promise<boolean> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (params.parentId !== undefined) {
    sets.push(`parent_id = $${i++}`);
    vals.push(params.parentId);
  }
  if (params.nameAr !== undefined) {
    sets.push(`name_ar = $${i++}`);
    vals.push(params.nameAr.trim());
  }
  if (params.icon !== undefined) {
    sets.push(`icon = $${i++}`);
    vals.push(params.icon.trim());
  }
  if (params.sortOrder !== undefined) {
    sets.push(`sort_order = $${i++}`);
    vals.push(params.sortOrder);
  }
  if (params.isActive !== undefined) {
    sets.push(`is_active = $${i++}`);
    vals.push(params.isActive);
  }
  if (sets.length === 0) return true;
  vals.push(params.id);
  const r = await pool.query(`UPDATE lesson_categories SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  return (r.rowCount ?? 0) > 0;
}

export async function deleteLessonCategory(id: number): Promise<{ ok: boolean; reason?: string }> {
  const pool = getPool();
  const child = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM lesson_categories WHERE parent_id = $1`,
    [id],
  );
  if (Number(child.rows[0]?.c ?? 0) > 0) {
    return { ok: false, reason: "has_child_categories" };
  }
  const lessons = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM lessons WHERE lesson_category_id = $1`,
    [id],
  );
  if (Number(lessons.rows[0]?.c ?? 0) > 0) {
    return { ok: false, reason: "has_lessons" };
  }
  const r = await pool.query(`DELETE FROM lesson_categories WHERE id = $1`, [id]);
  return { ok: (r.rowCount ?? 0) > 0 };
}

export async function listLessonsAdmin(filters: {
  categoryId?: number | null;
  publishedOnly?: boolean;
}): Promise<LessonAdminSummary[]> {
  const pool = getPool();
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.categoryId != null && filters.categoryId > 0) {
    params.push(filters.categoryId);
    where.push(`l.lesson_category_id = $${params.length}`);
  }
  if (filters.publishedOnly) {
    where.push(`l.is_published = TRUE`);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const r = await pool.query<{
    id: number;
    lesson_category_id: number | null;
    category_name: string | null;
    title: string;
    slug: string | null;
    description: string | null;
    default_answer_ms: number;
    default_study_card_ms: number;
    is_published: boolean;
    sort_order: number;
    item_count: string;
  }>(
    `SELECT l.id, l.lesson_category_id, lc.name_ar AS category_name, l.title, l.slug, l.description,
            l.default_answer_ms, l.default_study_card_ms, l.is_published, l.sort_order,
            (SELECT COUNT(*)::text FROM lesson_items li WHERE li.lesson_id = l.id) AS item_count
     FROM lessons l
     LEFT JOIN lesson_categories lc ON lc.id = l.lesson_category_id
     ${w}
     ORDER BY l.sort_order ASC, l.id DESC`,
    params,
  );
  return r.rows.map((row) => ({
    id: row.id,
    lessonCategoryId: row.lesson_category_id,
    categoryNameAr: row.category_name,
    title: row.title,
    slug: row.slug?.trim() || null,
    description: row.description,
    defaultAnswerMs: row.default_answer_ms,
    defaultStudyCardMs: row.default_study_card_ms,
    isPublished: row.is_published,
    sortOrder: row.sort_order,
    itemCount: Number(row.item_count ?? 0),
  }));
}

export async function insertLesson(params: {
  lessonCategoryId: number | null;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  defaultStudyCardMs: number;
  isPublished: boolean;
  sortOrder: number;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO lessons (
       lesson_category_id, title, slug, description,
       default_answer_ms, default_study_card_ms, is_published, sort_order
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      params.lessonCategoryId,
      params.title.trim(),
      params.slug?.trim() || null,
      params.description?.trim() || null,
      params.defaultAnswerMs,
      params.defaultStudyCardMs,
      params.isPublished,
      params.sortOrder,
    ],
  );
  const id = r.rows[0]?.id;
  if (id == null) throw new Error("insert_lesson_failed");
  return id;
}

export async function getLessonAdmin(lessonId: number): Promise<LessonAdminDetail | null> {
  const pool = getPool();
  const l = await pool.query<{
    id: number;
    lesson_category_id: number | null;
    category_name: string | null;
    title: string;
    slug: string | null;
    description: string | null;
    default_answer_ms: number;
    default_study_card_ms: number;
    is_published: boolean;
    sort_order: number;
    item_count: string;
  }>(
    `SELECT l.id, l.lesson_category_id, lc.name_ar AS category_name, l.title, l.slug, l.description,
            l.default_answer_ms, l.default_study_card_ms, l.is_published, l.sort_order,
            (SELECT COUNT(*)::text FROM lesson_items li WHERE li.lesson_id = l.id) AS item_count
     FROM lessons l
     LEFT JOIN lesson_categories lc ON lc.id = l.lesson_category_id
     WHERE l.id = $1`,
    [lessonId],
  );
  const row = l.rows[0];
  if (!row) return null;

  const joined = await pool.query<{
    section_id: number;
    section_sort: number;
    title_ar: string | null;
    sort_order: number;
    question_id: number;
    answer_ms: number | null;
    study_card_ms: number | null;
    prompt: string;
    study_body: string | null;
  }>(
    `SELECT ls.id AS section_id, ls.sort_order AS section_sort, ls.title_ar,
            li.sort_order, li.question_id, li.answer_ms, li.study_card_ms,
            q.prompt, q.study_body
     FROM lesson_sections ls
     JOIN lesson_items li ON li.lesson_section_id = ls.id
     JOIN questions q ON q.id = li.question_id
     WHERE ls.lesson_id = $1
     ORDER BY ls.sort_order ASC, li.sort_order ASC`,
    [lessonId],
  );

  const sectionOrder: number[] = [];
  const bySection = new Map<
    number,
    { sortOrder: number; titleAr: string | null; items: LessonItemAdmin[] }
  >();
  for (const r of joined.rows) {
    if (!bySection.has(r.section_id)) {
      bySection.set(r.section_id, {
        sortOrder: r.section_sort,
        titleAr: r.title_ar?.trim() ? r.title_ar.trim() : null,
        items: [],
      });
      sectionOrder.push(r.section_id);
    }
    const sec = bySection.get(r.section_id)!;
    sec.items.push({
      sortOrder: r.sort_order,
      questionId: r.question_id,
      answerMs: r.answer_ms,
      studyCardMs: r.study_card_ms,
      promptPreview: r.prompt.length > 180 ? `${r.prompt.slice(0, 180)}…` : r.prompt,
      hasStudyBody: Boolean(r.study_body?.trim()),
    });
  }

  const sections: LessonSectionAdmin[] = sectionOrder.map((sid) => {
    const s = bySection.get(sid)!;
    return {
      id: sid,
      sortOrder: s.sortOrder,
      titleAr: s.titleAr,
      items: s.items,
    };
  });

  return {
    lesson: {
      id: row.id,
      lessonCategoryId: row.lesson_category_id,
      categoryNameAr: row.category_name,
      title: row.title,
      slug: row.slug?.trim() || null,
      description: row.description,
      defaultAnswerMs: row.default_answer_ms,
      defaultStudyCardMs: row.default_study_card_ms,
      isPublished: row.is_published,
      sortOrder: row.sort_order,
      itemCount: Number(row.item_count ?? 0),
    },
    sections,
  };
}

export async function updateLesson(
  lessonId: number,
  patch: {
    lessonCategoryId?: number | null;
    title?: string;
    slug?: string | null;
    description?: string | null;
    defaultAnswerMs?: number;
    defaultStudyCardMs?: number;
    isPublished?: boolean;
    sortOrder?: number;
  },
): Promise<boolean> {
  const pool = getPool();
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  if (patch.lessonCategoryId !== undefined) {
    sets.push(`lesson_category_id = $${i++}`);
    vals.push(patch.lessonCategoryId);
  }
  if (patch.title !== undefined) {
    sets.push(`title = $${i++}`);
    vals.push(patch.title.trim());
  }
  if (patch.slug !== undefined) {
    sets.push(`slug = $${i++}`);
    vals.push(patch.slug?.trim() || null);
  }
  if (patch.description !== undefined) {
    sets.push(`description = $${i++}`);
    vals.push(patch.description?.trim() || null);
  }
  if (patch.defaultAnswerMs !== undefined) {
    sets.push(`default_answer_ms = $${i++}`);
    vals.push(patch.defaultAnswerMs);
  }
  if (patch.defaultStudyCardMs !== undefined) {
    sets.push(`default_study_card_ms = $${i++}`);
    vals.push(patch.defaultStudyCardMs);
  }
  if (patch.isPublished !== undefined) {
    sets.push(`is_published = $${i++}`);
    vals.push(patch.isPublished);
  }
  if (patch.sortOrder !== undefined) {
    sets.push(`sort_order = $${i++}`);
    vals.push(patch.sortOrder);
  }
  if (sets.length === 0) return true;
  sets.push(`updated_at = NOW()`);
  vals.push(lessonId);
  const r = await pool.query(`UPDATE lessons SET ${sets.join(", ")} WHERE id = $${i}`, vals);
  return (r.rowCount ?? 0) > 0;
}

export async function countLessonItems(lessonId: number): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM lesson_items WHERE lesson_id = $1`,
    [lessonId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function deleteLesson(lessonId: number): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query(`DELETE FROM lessons WHERE id = $1`, [lessonId]);
  return (r.rowCount ?? 0) > 0;
}

export type LessonItemReplaceRow = {
  questionId: number;
  answerMs?: number | null;
  studyCardMs?: number | null;
};

export type LessonSectionReplaceInput = {
  titleAr?: string | null;
  items: LessonItemReplaceRow[];
};

/** يستبدل أقسام الدرس وعناصره بالكامل. مصفوفة فارغة = حذف كل العناصر والأقسام. */
export async function replaceLessonSections(lessonId: number, sections: LessonSectionReplaceInput[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM lesson_items WHERE lesson_id = $1`, [lessonId]);
    await client.query(`DELETE FROM lesson_sections WHERE lesson_id = $1`, [lessonId]);
    let secIdx = 0;
    for (const sec of sections) {
      const ins = await client.query<{ id: number }>(
        `INSERT INTO lesson_sections (lesson_id, sort_order, title_ar)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [lessonId, secIdx++, sec.titleAr?.trim() ? sec.titleAr.trim() : null],
      );
      const sectionId = ins.rows[0]?.id;
      if (sectionId == null) throw new Error("insert_lesson_section_failed");
      let itemSort = 0;
      for (const row of sec.items) {
        await client.query(
          `INSERT INTO lesson_items (lesson_id, lesson_section_id, question_id, sort_order, answer_ms, study_card_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [lessonId, sectionId, row.questionId, itemSort++, row.answerMs ?? null, row.studyCardMs ?? null],
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
}

/** توافق خلفي: قسم واحد يضم كل العناصر بالترتيب. */
export async function replaceLessonItems(lessonId: number, ordered: LessonItemReplaceRow[]): Promise<void> {
  await replaceLessonSections(lessonId, [{ titleAr: null, items: ordered }]);
}

export async function listPublishedLessons(filters: {
  categoryId?: number | null;
}): Promise<
  Array<{
    id: number;
    title: string;
    slug: string | null;
    description: string | null;
    sortOrder: number;
    itemCount: number;
    category: { id: number; nameAr: string; icon: string } | null;
  }>
> {
  const pool = getPool();
  const params: unknown[] = [];
  const where: string[] = ["l.is_published = TRUE"];
  if (filters.categoryId != null && filters.categoryId > 0) {
    params.push(filters.categoryId);
    where.push(`l.lesson_category_id = $${params.length}`);
  }
  const r = await pool.query<{
    id: number;
    title: string;
    slug: string | null;
    description: string | null;
    sort_order: number;
    item_count: string;
    cat_id: number | null;
    cat_name: string | null;
    cat_icon: string | null;
  }>(
    `SELECT l.id, l.title, l.slug, l.description, l.sort_order,
            (SELECT COUNT(*)::text FROM lesson_items li WHERE li.lesson_id = l.id) AS item_count,
            lc.id AS cat_id, lc.name_ar AS cat_name, lc.icon AS cat_icon
     FROM lessons l
     LEFT JOIN lesson_categories lc ON lc.id = l.lesson_category_id AND lc.is_active = TRUE
     WHERE ${where.join(" AND ")}
     ORDER BY l.sort_order ASC, l.id DESC`,
    params,
  );
  return r.rows.map((row) => ({
    id: row.id,
    title: row.title,
    slug: row.slug?.trim() || null,
    description: row.description,
    sortOrder: row.sort_order,
    itemCount: Number(row.item_count ?? 0),
    category:
      row.cat_id != null && row.cat_name
        ? { id: row.cat_id, nameAr: row.cat_name, icon: row.cat_icon || "📖" }
        : null,
  }));
}

async function loadLessonPlaybackRows(
  pool: Pool,
  whereSql: string,
  params: unknown[],
): Promise<LessonPlaybackPayload | null> {
  const l = await pool.query<{
    id: number;
    title: string;
    slug: string | null;
    description: string | null;
    default_answer_ms: number;
    default_study_card_ms: number;
    cat_id: number | null;
    cat_name: string | null;
    cat_icon: string | null;
  }>(
    `SELECT l.id, l.title, l.slug, l.description, l.default_answer_ms, l.default_study_card_ms,
            lc.id AS cat_id, lc.name_ar AS cat_name, lc.icon AS cat_icon
     FROM lessons l
     LEFT JOIN lesson_categories lc ON lc.id = l.lesson_category_id
     WHERE ${whereSql}`,
    params,
  );
  const lesson = l.rows[0];
  if (!lesson) return null;

  const rows = await pool.query<{
    section_id: number;
    section_sort: number;
    title_ar: string | null;
    sort_order: number;
    question_id: number;
    answer_ms: number | null;
    study_card_ms: number | null;
    prompt: string;
    options: unknown;
    correct_index: number;
    study_body: string | null;
  }>(
    `SELECT ls.id AS section_id, ls.sort_order AS section_sort, ls.title_ar,
            li.sort_order, li.question_id, li.answer_ms, li.study_card_ms,
            q.prompt, q.options, q.correct_index, q.study_body
     FROM lesson_sections ls
     JOIN lesson_items li ON li.lesson_section_id = ls.id
     JOIN questions q ON q.id = li.question_id
     WHERE ls.lesson_id = $1
     ORDER BY ls.sort_order ASC, li.sort_order ASC`,
    [lesson.id],
  );

  const sectionIds: number[] = [];
  const stepsBySection = new Map<number, LessonPlaybackStep[]>();
  for (const it of rows.rows) {
    if (!stepsBySection.has(it.section_id)) {
      sectionIds.push(it.section_id);
      stepsBySection.set(it.section_id, []);
    }
    const effectiveAnswerMs = it.answer_ms ?? lesson.default_answer_ms;
    const effectiveStudyCardMs = it.study_card_ms ?? lesson.default_study_card_ms;
    stepsBySection.get(it.section_id)!.push({
      sortOrder: it.sort_order,
      questionId: it.question_id,
      prompt: it.prompt,
      options: parseOptions(it.options),
      correctIndex: it.correct_index,
      studyBody: it.study_body?.trim() ? it.study_body.trim() : null,
      effectiveAnswerMs,
      effectiveStudyCardMs,
    });
  }

  const sectionMeta = new Map<number, { sort: number; titleAr: string | null }>();
  for (const it of rows.rows) {
    if (!sectionMeta.has(it.section_id)) {
      sectionMeta.set(it.section_id, {
        sort: it.section_sort,
        titleAr: it.title_ar?.trim() ? it.title_ar.trim() : null,
      });
    }
  }

  const sections: LessonPlaybackSection[] = sectionIds.map((sid) => {
    const m = sectionMeta.get(sid)!;
    return {
      id: sid,
      sortOrder: m.sort,
      titleAr: m.titleAr,
      steps: stepsBySection.get(sid) ?? [],
    };
  });

  const steps: LessonPlaybackStep[] = sections.flatMap((s) => s.steps);

  return {
    id: lesson.id,
    title: lesson.title,
    slug: lesson.slug?.trim() || null,
    description: lesson.description,
    defaultAnswerMs: lesson.default_answer_ms,
    defaultStudyCardMs: lesson.default_study_card_ms,
    category:
      lesson.cat_id != null && lesson.cat_name
        ? { id: lesson.cat_id, nameAr: lesson.cat_name, icon: lesson.cat_icon || "📖" }
        : null,
    sections,
    steps,
  };
}

export async function getPublishedLessonPlaybackById(lessonId: number): Promise<LessonPlaybackPayload | null> {
  const pool = getPool();
  return loadLessonPlaybackRows(pool, `l.id = $1 AND l.is_published = TRUE`, [lessonId]);
}

export async function getPublishedLessonPlaybackBySlug(slug: string): Promise<LessonPlaybackPayload | null> {
  const pool = getPool();
  const s = slug.trim();
  if (!s) return null;
  return loadLessonPlaybackRows(pool, `l.is_published = TRUE AND l.slug = $1`, [s]);
}

export async function getLessonPlaybackAdmin(lessonId: number): Promise<LessonPlaybackPayload | null> {
  const pool = getPool();
  return loadLessonPlaybackRows(pool, `l.id = $1`, [lessonId]);
}

/** مجموع زمن بطاقات المراجعة لمجموعة خطوات (ذات studyBody) — لقسم واحد في مباراة الدرس */
export function lessonStudyPhaseTotalMsForSteps(steps: LessonPlaybackStep[]): number {
  let sum = 0;
  for (const s of steps) {
    if (s.studyBody?.trim()) sum += s.effectiveStudyCardMs;
  }
  return Math.min(300_000, Math.max(5_000, sum > 0 ? sum : 5_000));
}

/** مجموع زمن بطاقات المراجعة للدرس كاملاً (كل الأقسام). */
export function lessonStudyPhaseTotalMs(playback: LessonPlaybackPayload): number {
  return lessonStudyPhaseTotalMsForSteps(playback.steps);
}

export function lessonPlaybackToStudyCardsFromSteps(steps: LessonPlaybackStep[]): StudyPhaseCardPayload[] {
  const out: StudyPhaseCardPayload[] = [];
  let order = 0;
  for (const s of steps) {
    const body = s.studyBody?.trim();
    if (!body) continue;
    out.push({
      id: s.questionId,
      questionId: s.questionId,
      body,
      order: order++,
    });
  }
  return out;
}

export function lessonPlaybackToStudyCards(playback: LessonPlaybackPayload): StudyPhaseCardPayload[] {
  return lessonPlaybackToStudyCardsFromSteps(playback.steps);
}

export function lessonStepToQuestionRow(s: LessonPlaybackStep): QuestionRow {
  return {
    id: s.questionId,
    prompt: s.prompt,
    options: s.options,
    correct_index: s.correctIndex,
    study_body: s.studyBody,
  };
}
