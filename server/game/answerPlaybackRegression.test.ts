import { describe, expect, it } from "vitest";
import { buildPlaybackFromImportDraft } from "../db/lessons";
import { answerSchema } from "./socketSchemas";

/**
 * انحدار: دروس الاستيراد/المخصصة تولّد questionId سالبة؛ يجب أن يمرّ جسم `answer` عبر answerSchema
 * حتى يصل التحقق إلى Match.canAcceptChoice (وليس أن يُرفض مبكراً في Zod).
 */
describe("answerSchema + buildPlaybackFromImportDraft", () => {
  it("معرّفات الأسئلة السالبة في مسودة الاستيراد تُقبل في answerSchema", () => {
    const playback = buildPlaybackFromImportDraft(
      {
        title: "درس تجريبي",
        slug: null,
        description: null,
        defaultAnswerMs: 15_000,
        sortOrder: 0,
      },
      [
        {
          titleAr: "قسم",
          studyPhaseMs: 5000,
          items: [
            {
              prompt: "س1؟",
              options: ["أ", "ب"],
              correctIndex: 0,
              studyBody: "",
              difficulty: "easy",
              answerMs: null,
              subcategoryKey: "x",
            },
            {
              prompt: "س2؟",
              options: ["أ", "ب", "ج"],
              correctIndex: 1,
              studyBody: "مذاكرة",
              difficulty: "easy",
              answerMs: null,
              subcategoryKey: "x",
            },
          ],
        },
      ],
    );

    expect(playback.steps[0]!.questionId).toBe(-1);
    expect(playback.steps[1]!.questionId).toBe(-2);

    for (const step of playback.steps) {
      const parsed = answerSchema.safeParse({
        questionId: step.questionId,
        choiceIndex: 0,
      });
      expect(parsed.success, `expected parse for qid=${step.questionId}`).toBe(true);
    }
  });
});
