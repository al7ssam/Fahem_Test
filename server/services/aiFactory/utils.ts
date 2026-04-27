import type { FactoryDifficulty, FactoryQuestion, FactoryValidationError } from "./types";

function normalizeJsonLikeText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/^[\s\r\n]*json[\s\r\n]+/i, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");
}

function stripMarkdownFences(input: string): string {
  return input.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function removeTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, "$1");
}

function repairLikelyJsonArray(input: string): string {
  const normalized = normalizeJsonLikeText(input);
  const noFences = stripMarkdownFences(normalized);
  return removeTrailingCommas(noFences).trim();
}

function parseArrayOrQuestions(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const questions = (value as { questions?: unknown }).questions;
    if (Array.isArray(questions)) return questions;
  }
  return null;
}

function tryParseCandidate(candidate: string, useRepair: boolean): unknown[] | null {
  const payload = useRepair ? repairLikelyJsonArray(candidate) : candidate.trim();
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload);
    return parseArrayOrQuestions(parsed);
  } catch {
    return null;
  }
}

export function extractJsonArray(raw: string): unknown[] | null {
  const text = String(raw || "").trim();
  if (!text) return null;

  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");

  const candidates: string[] = [text];
  if (blockMatch?.[1]) candidates.push(blockMatch[1]);
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }

  for (const c of candidates) {
    const parsed = tryParseCandidate(c, false);
    if (parsed) return parsed;
  }
  for (const c of candidates) {
    const parsed = tryParseCandidate(c, true);
    if (parsed) return parsed;
  }
  if (!blockMatch?.[1]) {
    const looseFence = stripMarkdownFences(text);
    if (looseFence !== text) {
      const parsed = tryParseCandidate(looseFence, true);
      if (parsed) return parsed;
    }
  }
  return null;
}

function readStringFromAliases(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function readNumberFromAliases(obj: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = obj[key];
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return Number.NaN;
}

export function normalizeFactoryQuestion(item: unknown, idx: number): FactoryQuestion {
  if (!item || typeof item !== "object") {
    throw new Error(`question_${idx + 1}_invalid_object`);
  }
  const o = item as Record<string, unknown>;
  const prompt = readStringFromAliases(o, ["prompt", "question", "questionText", "question_text", "stem", "title"]);
  const options = Array.isArray(o.options) ? o.options.map((x) => String(x ?? "").trim()) : [];
  const correctIndex = readNumberFromAliases(o, ["correctIndex", "correct_index", "answerIndex", "answer_index"]);
  const studyBody = readStringFromAliases(o, ["studyBody", "study_body", "explanation", "rationale", "reasoning"]);
  const subcategoryKey = String(o.subcategoryKey ?? o.subcategory_key ?? "").trim();
  const difficulty = String(o.difficulty ?? "").trim().toLowerCase();
  const questionType = mapQuestionTypeAlias(String(o.questionType ?? o.question_type ?? ""));
  const conceptIdsRaw = Array.isArray(o.conceptIdsReferenced)
    ? o.conceptIdsReferenced
    : Array.isArray(o.concept_ids_referenced)
      ? o.concept_ids_referenced
      : [];
  const conceptIdsReferenced = conceptIdsRaw
    .map((x) => String(x ?? "").trim())
    .filter((x) => x.length > 0);
  const rawSignals =
    o.difficultySignals && typeof o.difficultySignals === "object"
      ? (o.difficultySignals as Record<string, unknown>)
      : o.difficulty_signals && typeof o.difficulty_signals === "object"
        ? (o.difficulty_signals as Record<string, unknown>)
        : null;
  const difficultySignals =
    rawSignals &&
    Number.isFinite(Number(rawSignals.explicitFactCount)) &&
    Number.isFinite(Number(rawSignals.crossConceptCount))
      ? {
          isAnswerExplicit: Boolean(rawSignals.isAnswerExplicit),
          explicitFactCount: Math.max(0, Math.floor(Number(rawSignals.explicitFactCount))),
          crossConceptCount: Math.max(0, Math.floor(Number(rawSignals.crossConceptCount))),
        }
      : undefined;
  const rawLearningSignals =
    o.learningSignals && typeof o.learningSignals === "object"
      ? (o.learningSignals as Record<string, unknown>)
      : o.learning_signals && typeof o.learning_signals === "object"
        ? (o.learning_signals as Record<string, unknown>)
        : null;
  const learningSignals = rawLearningSignals
    ? {
        introducesNewConcept: Boolean(rawLearningSignals.introducesNewConcept),
        clarifiesMisconception: Boolean(rawLearningSignals.clarifiesMisconception),
        requiresUnderstanding: Boolean(rawLearningSignals.requiresUnderstanding),
        notPureRecall: Boolean(rawLearningSignals.notPureRecall),
      }
    : undefined;

  if (!prompt) throw new Error(`question_${idx + 1}_missing_prompt`);
  if (!(options.length === 2 || options.length === 4)) {
    throw new Error(`question_${idx + 1}_options_must_be_2_or_4`);
  }
  if (options.some((v) => !v)) throw new Error(`question_${idx + 1}_empty_option`);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
    throw new Error(`question_${idx + 1}_invalid_correct_index`);
  }
  if (!studyBody) throw new Error(`question_${idx + 1}_missing_study_body`);
  if (!subcategoryKey) throw new Error(`question_${idx + 1}_missing_subcategory_key`);
  if (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard") {
    throw new Error(`question_${idx + 1}_invalid_difficulty`);
  }
  if (!questionType) throw new Error(`question_${idx + 1}_invalid_question_type`);
  return {
    prompt,
    options,
    correctIndex,
    studyBody,
    subcategoryKey,
    difficulty,
    questionType,
    conceptIdsReferenced,
    difficultySignals,
    learningSignals,
  };
}

function mapDifficultyAlias(raw: string): FactoryQuestion["difficulty"] | null {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v === "easy" || v === "medium" || v === "hard") return v;
  if (v === "سهل") return "easy";
  if (v === "متوسط") return "medium";
  if (v === "صعب") return "hard";
  return null;
}

function mapQuestionTypeAlias(raw: string): FactoryQuestion["questionType"] | null {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return null;
  if (v === "conceptual" || v === "procedural" || v === "application") return v;
  if (v === "concept" || v === "concepts" || v === "conceptual_question") return "conceptual";
  if (v === "procedure" || v === "process" || v === "procedural_question") return "procedural";
  if (v === "applied" || v === "practical" || v === "application_question") return "application";
  if (v === "مفاهيمي" || v === "مفاهيمي") return "conceptual";
  if (v === "إجرائي" || v === "اجرائي") return "procedural";
  if (v === "تطبيقي") return "application";
  return null;
}

function pushValidationError(
  into: FactoryValidationError[],
  input: Omit<FactoryValidationError, "index"> & { index: number },
): void {
  into.push({
    code: input.code,
    field: input.field,
    index: input.index,
    message: input.message,
    before: input.before,
    after: input.after,
  });
}

export function normalizeFactoryQuestionsLenient(
  items: unknown[],
  options: {
    fallbackSubcategoryKey: string;
    forcedDifficultyMode: FactoryDifficulty;
  },
): { questions: FactoryQuestion[]; validationErrors: FactoryValidationError[] } {
  const validationErrors: FactoryValidationError[] = [];
  const questions: FactoryQuestion[] = [];

  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    if (!item || typeof item !== "object") {
      pushValidationError(validationErrors, {
        code: "invalid_object",
        field: "question",
        index: idx,
        message: `question_${idx + 1}_invalid_object`,
      });
      continue;
    }
    const o = item as Record<string, unknown>;
    const prompt = readStringFromAliases(o, ["prompt", "question", "questionText", "question_text", "stem", "title"]);
    const optionsList = Array.isArray(o.options) ? o.options.map((x) => String(x ?? "").trim()) : [];
    const correctIndex = readNumberFromAliases(o, ["correctIndex", "correct_index", "answerIndex", "answer_index"]);
    const studyBody = readStringFromAliases(o, ["studyBody", "study_body", "explanation", "rationale", "reasoning"]);
    const rawSubcategoryKey = String(o.subcategoryKey ?? o.subcategory_key ?? "").trim();
    const mappedDifficulty = mapDifficultyAlias(String(o.difficulty ?? ""));
    const mappedQuestionType = mapQuestionTypeAlias(String(o.questionType ?? o.question_type ?? ""));
    const conceptIdsRaw = Array.isArray(o.conceptIdsReferenced)
      ? o.conceptIdsReferenced
      : Array.isArray(o.concept_ids_referenced)
        ? o.concept_ids_referenced
        : [];
    const conceptIdsReferenced = conceptIdsRaw
      .map((x) => String(x ?? "").trim())
      .filter((x) => x.length > 0);
    const rawSignals =
      o.difficultySignals && typeof o.difficultySignals === "object"
        ? (o.difficultySignals as Record<string, unknown>)
        : o.difficulty_signals && typeof o.difficulty_signals === "object"
          ? (o.difficulty_signals as Record<string, unknown>)
          : null;
    const difficultySignals =
      rawSignals &&
      Number.isFinite(Number(rawSignals.explicitFactCount)) &&
      Number.isFinite(Number(rawSignals.crossConceptCount))
        ? {
            isAnswerExplicit: Boolean(rawSignals.isAnswerExplicit),
            explicitFactCount: Math.max(0, Math.floor(Number(rawSignals.explicitFactCount))),
            crossConceptCount: Math.max(0, Math.floor(Number(rawSignals.crossConceptCount))),
          }
        : undefined;
    const rawLearningSignals =
      o.learningSignals && typeof o.learningSignals === "object"
        ? (o.learningSignals as Record<string, unknown>)
        : o.learning_signals && typeof o.learning_signals === "object"
          ? (o.learning_signals as Record<string, unknown>)
          : null;
    const learningSignals = rawLearningSignals
      ? {
          introducesNewConcept: Boolean(rawLearningSignals.introducesNewConcept),
          clarifiesMisconception: Boolean(rawLearningSignals.clarifiesMisconception),
          requiresUnderstanding: Boolean(rawLearningSignals.requiresUnderstanding),
          notPureRecall: Boolean(rawLearningSignals.notPureRecall),
        }
      : undefined;
    const forcedDifficulty =
      options.forcedDifficultyMode === "mix" ? null : options.forcedDifficultyMode;

    if (!prompt) {
      pushValidationError(validationErrors, {
        code: "missing_prompt",
        field: "prompt",
        index: idx,
        message: `question_${idx + 1}_missing_prompt`,
      });
      continue;
    }
    if (!(optionsList.length === 2 || optionsList.length === 4)) {
      pushValidationError(validationErrors, {
        code: "options_must_be_2_or_4",
        field: "options",
        index: idx,
        message: `question_${idx + 1}_options_must_be_2_or_4`,
        before: optionsList.length,
      });
      continue;
    }
    if (optionsList.some((v) => !v)) {
      pushValidationError(validationErrors, {
        code: "empty_option",
        field: "options",
        index: idx,
        message: `question_${idx + 1}_empty_option`,
      });
      continue;
    }
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= optionsList.length) {
      pushValidationError(validationErrors, {
        code: "invalid_correct_index",
        field: "correctIndex",
        index: idx,
        message: `question_${idx + 1}_invalid_correct_index`,
        before: o.correctIndex ?? o.correct_index,
      });
      continue;
    }
    if (!studyBody) {
      pushValidationError(validationErrors, {
        code: "missing_study_body",
        field: "studyBody",
        index: idx,
        message: `question_${idx + 1}_missing_study_body`,
      });
      continue;
    }

    let subcategoryKey = rawSubcategoryKey;
    if (!rawSubcategoryKey || rawSubcategoryKey !== options.fallbackSubcategoryKey) {
      subcategoryKey = options.fallbackSubcategoryKey;
      pushValidationError(validationErrors, {
        code: !rawSubcategoryKey ? "missing_subcategory_key" : "invalid_subcategory_key",
        field: "subcategoryKey",
        index: idx,
        message: !rawSubcategoryKey
          ? `question_${idx + 1}_missing_subcategory_key`
          : `question_${idx + 1}_invalid_subcategory_key`,
        before: rawSubcategoryKey || null,
        after: subcategoryKey,
      });
    }

    let difficulty: FactoryQuestion["difficulty"];
    if (forcedDifficulty) {
      difficulty = forcedDifficulty;
      if (mappedDifficulty !== forcedDifficulty) {
        pushValidationError(validationErrors, {
          code: "difficulty_overridden_by_mode",
          field: "difficulty",
          index: idx,
          message: `question_${idx + 1}_difficulty_overridden_by_mode`,
          before: o.difficulty ?? null,
          after: forcedDifficulty,
        });
      }
    } else if (mappedDifficulty) {
      difficulty = mappedDifficulty;
      const rawDifficulty = String(o.difficulty ?? "").trim().toLowerCase();
      if (rawDifficulty && rawDifficulty !== mappedDifficulty) {
        pushValidationError(validationErrors, {
          code: "difficulty_alias_normalized",
          field: "difficulty",
          index: idx,
          message: `question_${idx + 1}_difficulty_alias_normalized`,
          before: o.difficulty ?? null,
          after: mappedDifficulty,
        });
      }
    } else {
      difficulty = "medium";
      pushValidationError(validationErrors, {
        code: "invalid_difficulty",
        field: "difficulty",
        index: idx,
        message: `question_${idx + 1}_invalid_difficulty`,
        before: o.difficulty ?? null,
        after: difficulty,
      });
    }

    let questionType: FactoryQuestion["questionType"];
    if (mappedQuestionType) {
      questionType = mappedQuestionType;
      const rawQuestionType = String(o.questionType ?? o.question_type ?? "").trim().toLowerCase();
      if (rawQuestionType && rawQuestionType !== mappedQuestionType) {
        pushValidationError(validationErrors, {
          code: "question_type_alias_normalized",
          field: "questionType",
          index: idx,
          message: `question_${idx + 1}_question_type_alias_normalized`,
          before: o.questionType ?? o.question_type ?? null,
          after: mappedQuestionType,
        });
      }
    } else {
      questionType = "application";
      pushValidationError(validationErrors, {
        code: "invalid_question_type",
        field: "questionType",
        index: idx,
        message: `question_${idx + 1}_invalid_question_type`,
        before: o.questionType ?? o.question_type ?? null,
        after: questionType,
      });
    }

    questions.push({
      prompt,
      options: optionsList,
      correctIndex,
      studyBody,
      subcategoryKey,
      difficulty,
      questionType,
      conceptIdsReferenced,
      difficultySignals,
      learningSignals,
    });
  }

  return { questions, validationErrors };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
