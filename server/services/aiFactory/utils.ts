import type { FactoryQuestion } from "./types";

export function extractJsonArray(raw: string): unknown[] | null {
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // ignore and try fenced block extraction
  }
  const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (blockMatch?.[1]) {
    try {
      const parsed = JSON.parse(blockMatch[1].trim());
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      const parsed = JSON.parse(text.slice(firstBracket, lastBracket + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

export function normalizeFactoryQuestion(item: unknown, idx: number): FactoryQuestion {
  if (!item || typeof item !== "object") {
    throw new Error(`question_${idx + 1}_invalid_object`);
  }
  const o = item as Record<string, unknown>;
  const prompt = String(o.prompt ?? "").trim();
  const options = Array.isArray(o.options) ? o.options.map((x) => String(x ?? "").trim()) : [];
  const correctIndex = Number(o.correctIndex ?? o.correct_index);
  const studyBody = String(o.studyBody ?? o.study_body ?? "").trim();
  const subcategoryKey = String(o.subcategoryKey ?? o.subcategory_key ?? "").trim();
  const difficulty = String(o.difficulty ?? "").trim().toLowerCase();

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
  return {
    prompt,
    options,
    correctIndex,
    studyBody,
    subcategoryKey,
    difficulty,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
