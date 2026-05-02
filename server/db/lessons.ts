import type { Pool, PoolClient } from "pg";
import type { QuestionRow, StudyPhaseCardPayload } from "./questions";
import { getPool } from "./pool";

/**
 * عند غياب study_phase_ms للقسم: يُستخدم كبديل لكل بطاقة مذاكرة بلا study_card_ms على صف lesson_items
 * عند احتساب المجموع (legacy فقط).
 */
const LESSON_LEGACY_STUDY_SUM_FALLBACK_MS = 10_000;

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
  isPublished: boolean;
  sortOrder: number;
  itemCount: number;
};

export type LessonItemAdmin = {
  sortOrder: number;
  questionId: number;
  answerMs: number | null;
  /** مهجور — زمن بطاقات المذاكرة يحدد لكل قسم عبر studyPhaseMs */
  studyCardMs?: number | null;
  promptPreview: string;
  hasStudyBody: boolean;
  /** سؤال أُنشئ من إدارة هذا الدرس (questions.lesson_id) */
  lessonOwned: boolean;
  /** للتحرير عند lessonOwned */
  prompt?: string;
  options?: string[];
  correctIndex?: number;
  studyBody?: string | null;
  difficulty?: string | null;
};

export type LessonSectionAdmin = {
  id: number;
  sortOrder: number;
  titleAr: string | null;
  /** زمن طور المذاكرة لهذا القسم بالمللي (NULL = احتساب تراجع من المجموع السابق على الخادم عند التشغيل) */
  studyPhaseMs: number | null;
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
  /** زمن طور المذاكرة المعتمد للقسم بعد الضغط بين 5000 و 300000 مللي */
  studyPhaseMs: number;
  steps: LessonPlaybackStep[];
};

export type LessonPlaybackPayload = {
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
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
    is_published: boolean;
    sort_order: number;
    item_count: string;
  }>(
    `SELECT l.id, l.lesson_category_id, lc.name_ar AS category_name, l.title, l.slug, l.description,
            l.default_answer_ms, l.is_published, l.sort_order,
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
  isPublished: boolean;
  sortOrder: number;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO lessons (
       lesson_category_id, title, slug, description,
       default_answer_ms, is_published, sort_order
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.lessonCategoryId,
      params.title.trim(),
      params.slug?.trim() || null,
      params.description?.trim() || null,
      params.defaultAnswerMs,
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
    is_published: boolean;
    sort_order: number;
    item_count: string;
  }>(
    `SELECT l.id, l.lesson_category_id, lc.name_ar AS category_name, l.title, l.slug, l.description,
            l.default_answer_ms, l.is_published, l.sort_order,
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
    study_phase_ms: number | null;
    sort_order: number;
    question_id: number;
    answer_ms: number | null;
    study_card_ms: number | null;
    prompt: string;
    options: unknown;
    correct_index: number;
    study_body: string | null;
    lesson_id: number | null;
    difficulty: string | null;
  }>(
    `SELECT ls.id AS section_id, ls.sort_order AS section_sort, ls.title_ar,
            ls.study_phase_ms,
            li.sort_order, li.question_id, li.answer_ms, li.study_card_ms,
            q.prompt, q.options, q.correct_index, q.study_body, q.lesson_id, q.difficulty
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
    {
      sortOrder: number;
      titleAr: string | null;
      studyPhaseMs: number | null;
      items: LessonItemAdmin[];
    }
  >();
  for (const r of joined.rows) {
    if (!bySection.has(r.section_id)) {
      bySection.set(r.section_id, {
        sortOrder: r.section_sort,
        titleAr: r.title_ar?.trim() ? r.title_ar.trim() : null,
        studyPhaseMs: r.study_phase_ms,
        items: [],
      });
      sectionOrder.push(r.section_id);
    }
    const sec = bySection.get(r.section_id)!;
    const lessonOwned = r.lesson_id != null && r.lesson_id === lessonId;
    let optionsParsed: string[] | undefined;
    if (lessonOwned) {
      try {
        const raw = r.options;
        optionsParsed = Array.isArray(raw)
          ? (raw as unknown[]).map((x) => String(x))
          : typeof raw === "string"
            ? (JSON.parse(raw) as string[])
            : [];
      } catch {
        optionsParsed = [];
      }
    }
    const item: LessonItemAdmin = {
      sortOrder: r.sort_order,
      questionId: r.question_id,
      answerMs: r.answer_ms,
      promptPreview: r.prompt.length > 180 ? `${r.prompt.slice(0, 180)}…` : r.prompt,
      hasStudyBody: Boolean(r.study_body?.trim()),
      lessonOwned,
    };
    if (lessonOwned) {
      item.prompt = r.prompt;
      item.options = optionsParsed;
      item.correctIndex = r.correct_index;
      item.studyBody = r.study_body?.trim() ? r.study_body : null;
      item.difficulty = r.difficulty;
    }
    sec.items.push(item);
  }

  const sections: LessonSectionAdmin[] = sectionOrder.map((sid) => {
    const s = bySection.get(sid)!;
    return {
      id: sid,
      sortOrder: s.sortOrder,
      titleAr: s.titleAr,
      studyPhaseMs: s.studyPhaseMs,
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
  studyPhaseMs?: number | null;
  items: LessonItemReplaceRow[];
};

function clampResolvedStudyPhaseMs(ms: number): number {
  return Math.min(300_000, Math.max(5_000, ms));
}

function legacySectionStudyPhaseMs(
  sectionRows: Array<{ study_body: string | null; study_card_ms: number | null }>,
  perCardMsFallback: number,
): number {
  let sum = 0;
  for (const r of sectionRows) {
    if (r.study_body?.trim()) sum += r.study_card_ms ?? perCardMsFallback;
  }
  return clampResolvedStudyPhaseMs(sum > 0 ? sum : perCardMsFallback);
}

/** مسودة استيراد درس من JSON (بدون تصنيف). */
export type LessonImportQuestionInput = {
  prompt: string;
  options: string[];
  correctIndex: number;
  difficulty: string;
  studyBody: string;
  /** مللي ثانية لكل عنصر في الدرس؛ null = استخدام defaultAnswerMs للدرس */
  answerMs: number | null;
  subcategoryKey: string;
};

export type LessonImportSectionInput = {
  titleAr: string | null;
  studyPhaseMs: number | null;
  items: LessonImportQuestionInput[];
};

export type LessonImportMetaInput = {
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  sortOrder: number;
};

/**
 * يبني حمولة التشغيل كما في قاعدة البيانات، لمعاينة الاستيراد أو للاختبار.
 * معرفات الأسئلة سالبة متناقصة ما لم يُمرَّر مُخصّص.
 */
export function buildPlaybackFromImportDraft(
  meta: LessonImportMetaInput,
  sectionInputs: LessonImportSectionInput[],
  options?: { lessonId?: number; startingQuestionId?: number },
): LessonPlaybackPayload {
  const lessonId = options?.lessonId ?? 0;
  let nextQ =
    options?.startingQuestionId !== undefined ? options.startingQuestionId : -1;

  const sections: LessonPlaybackSection[] = sectionInputs.map((secIn, si) => {
    const secRows = secIn.items.map((it) => ({
      study_body: it.studyBody?.trim() ? it.studyBody.trim() : null,
      study_card_ms: null as number | null,
    }));

    const steps: LessonPlaybackStep[] = [];
    const studyIndices: number[] = [];
    for (const it of secIn.items) {
      const studyBody = it.studyBody?.trim() ? it.studyBody.trim() : null;
      const effectiveAnswerMs = it.answerMs ?? meta.defaultAnswerMs;
      const qid = nextQ--;
      const idx = steps.length;
      steps.push({
        sortOrder: idx,
        questionId: qid,
        prompt: it.prompt,
        options: [...it.options],
        correctIndex: it.correctIndex,
        studyBody,
        effectiveAnswerMs,
        effectiveStudyCardMs: 0,
      });
      if (studyBody) studyIndices.push(idx);
    }

    let resolved: number;
    if (secIn.studyPhaseMs != null) {
      resolved = clampResolvedStudyPhaseMs(secIn.studyPhaseMs);
    } else {
      resolved = legacySectionStudyPhaseMs(secRows, LESSON_LEGACY_STUDY_SUM_FALLBACK_MS);
    }

    const n = studyIndices.length;
    if (n > 0) {
      const parts = distributeStudyPhaseMsToCardSlots(resolved, n);
      for (let i = 0; i < n; i++) {
        steps[studyIndices[i]!]!.effectiveStudyCardMs = parts[i]!;
      }
    }

    return {
      id: -(si + 1),
      sortOrder: si,
      titleAr: secIn.titleAr?.trim() ? secIn.titleAr.trim() : null,
      studyPhaseMs: resolved,
      steps,
    };
  });

  const stepsFlat: LessonPlaybackStep[] = sections.flatMap((s) => s.steps);

  return {
    id: lessonId,
    title: meta.title.trim(),
    slug: meta.slug?.trim() || null,
    description: meta.description?.trim() ?? null,
    defaultAnswerMs: meta.defaultAnswerMs,
    category: null,
    sections,
    steps: stepsFlat,
  };
}

/** يوزّع إجمالي القسم على بطاقات المذاكرة بحيث يبقى المجموع = الإجمالي بعد الضغط. */
function distributeStudyPhaseMsToCardSlots(totalMs: number, cardCount: number): number[] {
  if (cardCount <= 0) return [];
  const t = clampResolvedStudyPhaseMs(totalMs);
  const base = Math.floor(t / cardCount);
  let rem = t - base * cardCount;
  const out: number[] = [];
  for (let i = 0; i < cardCount; i++) {
    out.push(base + (i < rem ? 1 : 0));
  }
  return out;
}

/** يستبدل أقسام الدرس وعناصره دون فتح معاملة (للاستدعاء من داخل معاملة أوسع). */
export async function replaceLessonSectionsWithClient(
  client: PoolClient,
  lessonId: number,
  sections: LessonSectionReplaceInput[],
): Promise<void> {
  await client.query(`DELETE FROM lesson_items WHERE lesson_id = $1`, [lessonId]);
  await client.query(`DELETE FROM lesson_sections WHERE lesson_id = $1`, [lessonId]);
  let secIdx = 0;
  for (const sec of sections) {
    const ins = await client.query<{ id: number }>(
      `INSERT INTO lesson_sections (lesson_id, sort_order, title_ar, study_phase_ms)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        lessonId,
        secIdx++,
        sec.titleAr?.trim() ? sec.titleAr.trim() : null,
        sec.studyPhaseMs != null ? sec.studyPhaseMs : null,
      ],
    );
    const sectionId = ins.rows[0]?.id;
    if (sectionId == null) throw new Error("insert_lesson_section_failed");
    let itemSort = 0;
    for (const row of sec.items) {
      await client.query(
        `INSERT INTO lesson_items (lesson_id, lesson_section_id, question_id, sort_order, answer_ms, study_card_ms)
         VALUES ($1, $2, $3, $4, $5, NULL)`,
        [lessonId, sectionId, row.questionId, itemSort++, row.answerMs ?? null],
      );
    }
  }
}

/** يستبدل أقسام الدرس وعناصره بالكامل. مصفوفة فارغة = حذف كل العناصر والأقسام. */
export async function replaceLessonSections(lessonId: number, sections: LessonSectionReplaceInput[]): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await replaceLessonSectionsWithClient(client, lessonId, sections);
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

/**
 * إنشاء درس وأسئلته وأقسامه في معاملة واحدة (تصنيف الدرس دائماً null).
 */
export async function importLessonFromJsonTransaction(
  meta: LessonImportMetaInput,
  sections: LessonImportSectionInput[],
): Promise<{ lessonId: number }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lr = await client.query<{ id: number }>(
      `INSERT INTO lessons (
         lesson_category_id, title, slug, description,
         default_answer_ms, is_published, sort_order
       ) VALUES ($1, $2, $3, $4, $5, FALSE, $6)
       RETURNING id`,
      [
        null,
        meta.title.trim(),
        meta.slug?.trim() || null,
        meta.description?.trim() || null,
        meta.defaultAnswerMs,
        meta.sortOrder,
      ],
    );
    const lessonId = lr.rows[0]?.id;
    if (lessonId == null) throw new Error("insert_lesson_failed");

    const replaceSections: LessonSectionReplaceInput[] = [];
    for (const sec of sections) {
      const rows: LessonItemReplaceRow[] = [];
      for (const it of sec.items) {
        const insQ = await client.query<{ id: number }>(
          `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key, lesson_id)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)
           RETURNING id`,
          [
            it.prompt.trim(),
            JSON.stringify(it.options),
            it.correctIndex,
            it.difficulty,
            it.studyBody.trim(),
            it.subcategoryKey.trim() || "general_default",
            lessonId,
          ],
        );
        const qid = insQ.rows[0]?.id;
        if (qid == null) throw new Error("insert_question_failed");
        rows.push({ questionId: qid, answerMs: it.answerMs });
      }
      replaceSections.push({
        titleAr: sec.titleAr?.trim() ? sec.titleAr.trim() : null,
        studyPhaseMs: sec.studyPhaseMs,
        items: rows,
      });
    }

    await replaceLessonSectionsWithClient(client, lessonId, replaceSections);
    await client.query("COMMIT");
    return { lessonId };
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
    cat_id: number | null;
    cat_name: string | null;
    cat_icon: string | null;
  }>(
    `SELECT l.id, l.title, l.slug, l.description, l.default_answer_ms,
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
    study_phase_ms: number | null;
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
            ls.study_phase_ms,
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
  const sectionSeen = new Set<number>();
  for (const it of rows.rows) {
    if (!sectionSeen.has(it.section_id)) {
      sectionSeen.add(it.section_id);
      sectionIds.push(it.section_id);
    }
  }

  const sections: LessonPlaybackSection[] = sectionIds.map((sid) => {
    const secRows = rows.rows.filter((r) => r.section_id === sid);
    const first = secRows[0];
    const steps: LessonPlaybackStep[] = [];
    const studyIndices: number[] = [];
    for (const it of secRows) {
      const effectiveAnswerMs = it.answer_ms ?? lesson.default_answer_ms;
      const studyBody = it.study_body?.trim() ? it.study_body.trim() : null;
      const idx = steps.length;
      steps.push({
        sortOrder: it.sort_order,
        questionId: it.question_id,
        prompt: it.prompt,
        options: parseOptions(it.options),
        correctIndex: it.correct_index,
        studyBody,
        effectiveAnswerMs,
        effectiveStudyCardMs: 0,
      });
      if (studyBody) studyIndices.push(idx);
    }

    let resolved: number;
    if (first?.study_phase_ms != null) {
      resolved = clampResolvedStudyPhaseMs(first.study_phase_ms);
    } else {
      resolved = legacySectionStudyPhaseMs(secRows, LESSON_LEGACY_STUDY_SUM_FALLBACK_MS);
    }

    const n = studyIndices.length;
    if (n > 0) {
      const parts = distributeStudyPhaseMsToCardSlots(resolved, n);
      for (let i = 0; i < n; i++) {
        steps[studyIndices[i]].effectiveStudyCardMs = parts[i]!;
      }
    }

    return {
      id: sid,
      sortOrder: first?.section_sort ?? 0,
      titleAr: first?.title_ar?.trim() ? first.title_ar.trim() : null,
      studyPhaseMs: resolved,
      steps,
    };
  });

  const steps: LessonPlaybackStep[] = sections.flatMap((s) => s.steps);

  return {
    id: lesson.id,
    title: lesson.title,
    slug: lesson.slug?.trim() || null,
    description: lesson.description,
    defaultAnswerMs: lesson.default_answer_ms,
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
