import { extractJsonArray, normalizeFactoryQuestionsLenient } from "../aiFactory/utils";
import type { FactoryDifficulty, FactoryQuestion } from "../aiFactory/types";
import { readSubcategoryEditorContext } from "./context";
import {
  buildDraftPromptSystemMessage,
  buildDraftPromptUserMessage,
  SIMPLE_QUESTION_JSON_CONTRACT,
} from "./promptContract";
import {
  bumpAutomationNextRun,
  createRun,
  finalizeSimpleContentRun,
  getPresetById,
  getPromptBody,
  getRunById,
  listActivePresets,
  listDueAutomations,
  listRuns,
  upsertPromptBody,
} from "./repository";
import { insertSimpleContentQuestions } from "./insertQuestions";
import { resolveSimpleContentProvider } from "./llm/registry";
import type { SimpleContentPreset } from "./types";

function chooseDifficulty(mode: "mix" | "easy" | "medium" | "hard", index: number): "easy" | "medium" | "hard" {
  if (mode === "easy" || mode === "medium" || mode === "hard") return mode;
  const order: Array<"easy" | "medium" | "hard"> = ["easy", "medium", "hard"];
  return order[index % order.length];
}

function buildUserPromptBlock(input: {
  promptBody: string;
  subcategoryKey: string;
  difficultyMode: FactoryDifficulty;
  batchSize: number;
}): string {
  return [
    String(input.promptBody).trim(),
    "",
    SIMPLE_QUESTION_JSON_CONTRACT,
    `Subcategory key (exact): ${input.subcategoryKey}`,
    `Difficulty mode: ${input.difficultyMode}`,
    `Batch size: ${input.batchSize}`,
  ].join("\n");
}

async function resolvePresetForDraft(presetId?: number): Promise<SimpleContentPreset> {
  if (presetId != null) {
    const p = await getPresetById(presetId);
    if (!p || !p.isActive) {
      throw new Error("simple_content_invalid_preset");
    }
    return p;
  }
  const presets = await listActivePresets();
  const gem = presets.find((pr) => pr.provider === "gemini") ?? presets[0];
  if (!gem) {
    throw new Error("simple_content_no_active_preset");
  }
  return gem;
}

async function llmNormalizeToFinalQuestions(input: {
  subcategoryKey: string;
  batchSize: number;
  difficultyMode: FactoryDifficulty;
  preset: SimpleContentPreset;
  userPrompt: string;
}): Promise<{ modelText: string; finishReason: string | null; finalQuestions: FactoryQuestion[] }> {
  const provider = resolveSimpleContentProvider(input.preset);
  const out = await provider.complete({ prompt: input.userPrompt }, input.preset);
  if (out.finishReason === "MAX_TOKENS") {
    throw new Error("layer_output_truncated_max_tokens:layer=simple_content");
  }
  const arr = extractJsonArray(out.text);
  if (!arr) {
    throw new Error("invalid_json_output:layer=simple_content");
  }
  const normalized = normalizeFactoryQuestionsLenient(arr, {
    fallbackSubcategoryKey: input.subcategoryKey,
    forcedDifficultyMode: input.difficultyMode,
  });
  if (normalized.validationErrors.length > 0) {
    throw new Error(`simple_content_validation_errors:${JSON.stringify(normalized.validationErrors.slice(0, 8))}`);
  }
  if (normalized.questions.length === 0) {
    throw new Error("simple_content_no_valid_questions");
  }
  let finalQ = normalized.questions;
  if (finalQ.length > input.batchSize) {
    finalQ = finalQ.slice(0, input.batchSize);
  }
  if (input.difficultyMode === "mix") {
    finalQ = finalQ.map((q, idx) => ({
      ...q,
      difficulty: chooseDifficulty("mix", idx),
    }));
  }
  return { modelText: out.text, finishReason: out.finishReason ?? null, finalQuestions: finalQ };
}

export async function getSubcategoryContextForAdmin(subcategoryKey: string) {
  return readSubcategoryEditorContext(subcategoryKey);
}

export async function generatePromptDraft(subcategoryKey: string, presetId?: number): Promise<string> {
  const ctx = await readSubcategoryEditorContext(subcategoryKey);
  const preset = await resolvePresetForDraft(presetId);
  const provider = resolveSimpleContentProvider(preset);
  const text = [
    buildDraftPromptSystemMessage(),
    "",
    buildDraftPromptUserMessage({
      mainCategoryName: ctx.mainCategoryName,
      subcategoryName: ctx.subcategoryName,
      internalDescription: ctx.internalDescription,
    }),
  ].join("\n");
  const out = await provider.complete({ prompt: text }, preset);
  if (out.finishReason === "MAX_TOKENS") {
    throw new Error("layer_output_truncated_max_tokens:layer=simple_content_draft");
  }
  return out.text.trim();
}

/** Scheduled or legacy API: LLM + insert immediately, full audit row. */
export async function runSimpleContentGenerate(input: {
  subcategoryKey: string;
  batchSize: number;
  difficultyMode: FactoryDifficulty;
  presetId: number;
  triggerKind: "manual" | "scheduled";
}): Promise<{ runId: number; inserted: number }> {
  const preset = await getPresetById(input.presetId);
  if (!preset || !preset.isActive) {
    throw new Error("simple_content_invalid_preset");
  }
  const body = await getPromptBody(input.subcategoryKey);
  if (!String(body).trim()) {
    throw new Error("simple_content_prompt_empty");
  }
  const userPrompt = buildUserPromptBlock({
    promptBody: body,
    subcategoryKey: input.subcategoryKey,
    difficultyMode: input.difficultyMode,
    batchSize: input.batchSize,
  });
  const runId = await createRun({
    subcategoryKey: input.subcategoryKey,
    triggerKind: input.triggerKind,
    preset,
  });
  let modelText: string | null = null;
  try {
    const { modelText: mt, finalQuestions } = await llmNormalizeToFinalQuestions({
      subcategoryKey: input.subcategoryKey,
      batchSize: input.batchSize,
      difficultyMode: input.difficultyMode,
      preset,
      userPrompt,
    });
    modelText = mt;
    const questionIds = await insertSimpleContentQuestions(finalQuestions);
    await finalizeSimpleContentRun(runId, {
      status: "succeeded",
      insertedCount: questionIds.length,
      error: null,
      previewJson: {
        questionIds,
        subcategoryKey: input.subcategoryKey,
        inserted: questionIds.length,
      },
      requestPrompt: userPrompt,
      modelResponse: modelText,
      normalizedQuestions: null,
    });
    return { runId, inserted: questionIds.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    await finalizeSimpleContentRun(runId, {
      status: "failed",
      insertedCount: 0,
      error: msg,
      previewJson: null,
      requestPrompt: userPrompt,
      modelResponse: modelText,
      normalizedQuestions: null,
    });
    throw error;
  }
}

/** Manual only: LLM + normalize stored as pending_review (no insert). */
export async function runSimpleContentGeneratePreview(input: {
  subcategoryKey: string;
  batchSize: number;
  difficultyMode: FactoryDifficulty;
  presetId: number;
}): Promise<{ runId: number; questionCount: number }> {
  const preset = await getPresetById(input.presetId);
  if (!preset || !preset.isActive) {
    throw new Error("simple_content_invalid_preset");
  }
  const body = await getPromptBody(input.subcategoryKey);
  if (!String(body).trim()) {
    throw new Error("simple_content_prompt_empty");
  }
  const userPrompt = buildUserPromptBlock({
    promptBody: body,
    subcategoryKey: input.subcategoryKey,
    difficultyMode: input.difficultyMode,
    batchSize: input.batchSize,
  });
  const runId = await createRun({
    subcategoryKey: input.subcategoryKey,
    triggerKind: "manual",
    preset,
  });
  let modelText: string | null = null;
  try {
    const { modelText: mt, finalQuestions } = await llmNormalizeToFinalQuestions({
      subcategoryKey: input.subcategoryKey,
      batchSize: input.batchSize,
      difficultyMode: input.difficultyMode,
      preset,
      userPrompt,
    });
    modelText = mt;
    await finalizeSimpleContentRun(runId, {
      status: "pending_review",
      insertedCount: 0,
      error: null,
      previewJson: {
        subcategoryKey: input.subcategoryKey,
        questionCount: finalQuestions.length,
      },
      requestPrompt: userPrompt,
      modelResponse: modelText,
      normalizedQuestions: finalQuestions,
    });
    return { runId, questionCount: finalQuestions.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    await finalizeSimpleContentRun(runId, {
      status: "failed",
      insertedCount: 0,
      error: msg,
      previewJson: null,
      requestPrompt: userPrompt,
      modelResponse: modelText,
      normalizedQuestions: null,
    });
    throw error;
  }
}

export async function commitSimpleContentRun(runId: number): Promise<{ inserted: number; questionIds: number[] }> {
  const run = await getRunById(runId);
  if (!run || run.status !== "pending_review" || run.triggerKind !== "manual") {
    throw new Error("simple_content_commit_invalid");
  }
  const raw = run.normalizedQuestions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("simple_content_commit_empty");
  }
  const questions = raw as FactoryQuestion[];
  const questionIds = await insertSimpleContentQuestions(questions);
  await finalizeSimpleContentRun(runId, {
    status: "succeeded",
    insertedCount: questionIds.length,
    error: null,
    previewJson: {
      questionIds,
      subcategoryKey: run.subcategoryKey,
      inserted: questionIds.length,
    },
    requestPrompt: run.requestPrompt,
    modelResponse: run.modelResponse,
    normalizedQuestions: null,
  });
  return { inserted: questionIds.length, questionIds };
}

export async function runSimpleContentSchedulerTick(): Promise<void> {
  const due = await listDueAutomations();
  const defaultBatch = Math.max(
    1,
    Math.min(50, Number(process.env.SIMPLE_CONTENT_SCHEDULER_BATCH_SIZE ?? 10) || 10),
  );
  for (const row of due) {
    const presetId = row.modelPresetId ?? (await listActivePresets())[0]?.id;
    if (!presetId) continue;
    try {
      await runSimpleContentGenerate({
        subcategoryKey: row.subcategoryKey,
        batchSize: defaultBatch,
        difficultyMode: "mix",
        presetId,
        triggerKind: "scheduled",
      });
    } catch {
      // errors recorded in simple_content_runs
    }
    await bumpAutomationNextRun(row.subcategoryKey, row.intervalMinutes);
  }
}

export { getPromptBody, upsertPromptBody, listRuns, listActivePresets, getRunById };
export { getAutomation, upsertAutomation } from "./repository";
