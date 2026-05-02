import { z } from "zod";
import type { LessonImportMetaInput, LessonImportSectionInput } from "./db/lessons";

export function mergedStudyBody(data: {
  studyBody?: string | null;
  study_body?: string | null;
}): string | null {
  const v = data.studyBody ?? data.study_body;
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length === 0 ? null : t;
}

export const questionDifficultySchema = z.enum(["easy", "medium", "hard"]);
export const questionOptionsSchema = z
  .array(z.string().trim().min(1).max(500))
  .refine((arr) => arr.length === 2 || arr.length === 4, {
    message: "options must contain exactly 2 or 4 items",
  });

export const lessonImportItemSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    options: questionOptionsSchema,
    correctIndex: z.number().int().min(0).max(3),
    difficulty: questionDifficultySchema,
    studyBody: z.string().max(50_000).optional(),
    study_body: z.string().max(50_000).optional(),
    answerMs: z.number().int().min(3000).max(120000).nullable().optional(),
    answer_ms: z.number().int().min(3000).max(120000).nullable().optional(),
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    subcategory_key: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.correctIndex >= d.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctIndex"],
        message: "correctIndex must be within options range",
      });
    }
  })
  .superRefine((d, ctx) => {
    const sb = mergedStudyBody(d as { studyBody?: string | null; study_body?: string | null });
    if (!sb?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["studyBody"],
        message: "بطاقة المذاكرة مطلوبة ولا يمكن أن تكون فارغة",
      });
    }
  });

export const lessonImportSectionSchema = z.object({
  titleAr: z.string().max(500).nullable().optional(),
  title_ar: z.string().max(500).nullable().optional(),
  studyPhaseMs: z.number().int().min(2000).max(300000).nullable().optional(),
  study_phase_ms: z.number().int().min(2000).max(300000).nullable().optional(),
  items: z.array(lessonImportItemSchema).min(1).max(50),
});

export const lessonImportBodySchema = z.object({
  lesson: z.object({
    title: z.string().trim().min(1).max(300),
    slug: z.string().trim().max(160).nullable().optional(),
    description: z.string().max(8000).nullable().optional(),
    defaultAnswerMs: z.number().int().min(3000).max(120000),
    sortOrder: z.number().int().min(0).max(100000).optional(),
  }),
  sections: z.array(lessonImportSectionSchema).min(1).max(20),
});

export function normalizeLessonImportPayload(body: z.infer<typeof lessonImportBodySchema>): {
  meta: LessonImportMetaInput;
  sections: LessonImportSectionInput[];
} {
  const slugRaw = body.lesson.slug;
  const slug =
    slugRaw === null || slugRaw === undefined ? null : slugRaw.trim() === "" ? null : slugRaw.trim();
  const meta: LessonImportMetaInput = {
    title: body.lesson.title.trim(),
    slug,
    description: body.lesson.description?.trim() ?? null,
    defaultAnswerMs: body.lesson.defaultAnswerMs,
    sortOrder: body.lesson.sortOrder ?? 0,
  };
  const sections: LessonImportSectionInput[] = body.sections.map((sec) => {
    const titleRaw = sec.titleAr ?? sec.title_ar;
    const titleAr =
      titleRaw === null || titleRaw === undefined ? null : titleRaw.trim() === "" ? null : titleRaw.trim();
    const studyPhaseMs = sec.studyPhaseMs ?? sec.study_phase_ms ?? null;
    const items: LessonImportSectionInput["items"] = sec.items.map((it) => ({
      prompt: it.prompt.trim(),
      options: [...it.options],
      correctIndex: it.correctIndex,
      difficulty: it.difficulty,
      studyBody: mergedStudyBody(it as { studyBody?: string | null; study_body?: string | null })!.trim(),
      answerMs: it.answerMs ?? it.answer_ms ?? null,
      subcategoryKey: (it.subcategoryKey ?? it.subcategory_key ?? "general_default").trim() || "general_default",
    }));
    return { titleAr, studyPhaseMs, items };
  });
  return { meta, sections };
}
