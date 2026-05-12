import { z } from "zod";

/** مخطط مشترك بين GameManager ومعالجات الغرف الخاصة لتجنب الانحراف. */
export const joinLobbySchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    mode: z.enum(["direct", "study_then_quiz", "lesson"]).default("direct"),
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    lessonId: z.number().int().positive().optional(),
    difficultyMode: z.enum(["mix", "easy", "medium", "hard"]).default("mix"),
    playerSessionId: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "lesson") {
      if (data.lessonId == null || !Number.isFinite(data.lessonId) || data.lessonId < 1) {
        ctx.addIssue({ code: "custom", path: ["lessonId"], message: "lesson_id_required" });
      }
    }
  });

export const joinLessonFlexibleSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    mode: z.enum(["direct", "study_then_quiz", "lesson"]).default("direct"),
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    lessonId: z.number().int().positive().optional(),
    customLessonToken: z.string().uuid().optional(),
    difficultyMode: z.enum(["mix", "easy", "medium", "hard"]).default("mix"),
    playerSessionId: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "lesson") {
      const hasToken = Boolean(data.customLessonToken?.trim());
      const hasLesson = data.lessonId != null && Number.isFinite(data.lessonId) && data.lessonId >= 1;
      if (!hasToken && !hasLesson) {
        ctx.addIssue({ code: "custom", path: ["lessonId"], message: "lesson_id_or_token_required" });
      }
      if (hasToken && hasLesson) {
        ctx.addIssue({
          code: "custom",
          path: ["customLessonToken"],
          message: "lesson_token_and_id_conflict",
        });
      }
    }
  });

export const resumeMatchSchema = z.object({
  matchId: z.string().uuid(),
  participantId: z.string().uuid(),
  resumeSecret: z.string().min(1).max(512),
});

export const continueSpectatorSchema = z.object({
  participantId: z.string().uuid().optional(),
});

export const answerSchema = z.object({
  questionId: z.number().int().positive(),
  choiceIndex: z.number().int().min(0),
});

export const abilityHeartAttackSchema = z.object({
  targetParticipantId: z.string().min(1),
});

/** حمولة عميل تُقبل كما هي — للأحداث التي لم تُرسَخ سابقاً (قدرات بجسم فارغ، جاهزية الجولة). */
export const ignoredClientBodySchema = z.unknown();

export type JoinLobbyParsed = z.infer<typeof joinLobbySchema>;
export type JoinLessonFlexibleParsed = z.infer<typeof joinLessonFlexibleSchema>;
export type ResumeMatchParsed = z.infer<typeof resumeMatchSchema>;
