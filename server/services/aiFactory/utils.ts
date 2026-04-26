import type { FactoryQuestion } from "./types";

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
