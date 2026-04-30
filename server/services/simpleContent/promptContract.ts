/** Output instructions for single-shot question JSON (aligned with factory question shape). */
export const SIMPLE_QUESTION_JSON_CONTRACT = [
  "Output: ONLY a valid JSON array of question objects (no markdown fences, no commentary).",
  "Each object: prompt, options (2 or 4 strings), correctIndex (0-based), studyBody, subcategoryKey, difficulty (easy|medium|hard), questionType (conceptual|procedural|application).",
  "Arabic for prompt/studyBody; difficulty English only.",
  "studyBody: [principle/rule] + [why correct] + [memory tip].",
  "Target mix: ~30% conceptual, ~30% procedural, ~40% application.",
].join("\n");

export function buildDraftPromptSystemMessage(): string {
  return [
    "You write a single high-quality Arabic system prompt for generating educational quiz questions.",
    "The prompt will be stored and reused by humans; be specific about domain, tone, and pedagogy.",
    "Output plain text only (no JSON, no markdown fences).",
  ].join("\n");
}

export function buildDraftPromptUserMessage(input: {
  mainCategoryName: string;
  subcategoryName: string;
  internalDescription: string;
}): string {
  return [
    `التصنيف الرئيسي: ${input.mainCategoryName}`,
    `التصنيف الفرعي: ${input.subcategoryName}`,
    `وصف داخلي للفرع (للمحررين): ${input.internalDescription || "—"}`,
    "اكتب برومبتًا احترافيًا بالعربية يوجّه نموذجًا لاحقًا لتوليد أسئلة تعليمية عالية الجودة لهذا الفرع.",
  ].join("\n");
}

/** Static strings for admin transparency (no secrets). */
export function getAdminPromptTemplatesPayload(): {
  draftSystemMessage: string;
  draftUserMessageTemplate: string;
  questionJsonContract: string;
} {
  return {
    draftSystemMessage: buildDraftPromptSystemMessage(),
    draftUserMessageTemplate: buildDraftPromptUserMessage({
      mainCategoryName: "{{mainCategoryName}}",
      subcategoryName: "{{subcategoryName}}",
      internalDescription: "{{internalDescription}}",
    }),
    questionJsonContract: SIMPLE_QUESTION_JSON_CONTRACT,
  };
}
