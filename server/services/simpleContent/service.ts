import { extractJsonArray, normalizeFactoryQuestionsLenient } from "../aiFactory/utils";
import type { FactoryDifficulty } from "../aiFactory/types";
import { readSubcategoryEditorContext } from "./context";
import {
  buildDraftPromptSystemMessage,
  buildDraftPromptUserMessage,
  SIMPLE_QUESTION_JSON_CONTRACT,
} from "./promptContract";
import {
  bumpAutomationNextRun,
  createRun,
  finishRun,
  getPresetById,
  getPromptBody,
  listActivePresets,
  listDueAutomations,
  listRuns,
  upsertPromptBody,
} from "./repository";
import { insertSimpleContentQuestions } from "./insertQuestions";
import { resolveSimpleContentProvider } from "./llm/registry";

function chooseDifficulty(mode: "mix" | "easy" | "medium" | "hard", index: number): "easy" | "medium" | "hard" {
  if (mode === "easy" || mode === "medium" || mode === "hard") return mode;
  const order: Array<"easy" | "medium" | "hard"> = ["easy", "medium", "hard"];
  return order[index % order.length];
}

export async function getSubcategoryContextForAdmin(subcategoryKey: string) {
  return readSubcategoryEditorContext(subcategoryKey);
}

export async function generatePromptDraft(subcategoryKey: string): Promise<string> {
  const ctx = await readSubcategoryEditorContext(subcategoryKey);
  const presets = await listActivePresets();
  const gem = presets.find((p) => p.provider === "gemini") ?? presets[0];
  if (!gem) {
    throw new Error("simple_content_no_active_preset");
  }
  const provider = resolveSimpleContentProvider(gem);
  const text = [
    buildDraftPromptSystemMessage(),
    "",
    buildDraftPromptUserMessage({
      mainCategoryName: ctx.mainCategoryName,
      subcategoryName: ctx.subcategoryName,
      internalDescription: ctx.internalDescription,
    }),
  ].join("\n");
  const out = await provider.complete({ prompt: text }, gem);
  if (out.finishReason === "MAX_TOKENS") {
    throw new Error("layer_output_truncated_max_tokens:layer=simple_content_draft");
  }
  return out.text.trim();
}

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

  const provider = resolveSimpleContentProvider(preset);
  const userPrompt = [
    String(body).trim(),
    "",
    SIMPLE_QUESTION_JSON_CONTRACT,
    `Subcategory key (exact): ${input.subcategoryKey}`,
    `Difficulty mode: ${input.difficultyMode}`,
    `Batch size: ${input.batchSize}`,
  ].join("\n");

  const runId = await createRun({
    subcategoryKey: input.subcategoryKey,
    triggerKind: input.triggerKind,
    preset,
  });

  try {
    const out = await provider.complete({ prompt: userPrompt }, preset);
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
      throw new Error(
        `simple_content_validation_errors:${JSON.stringify(normalized.validationErrors.slice(0, 8))}`,
      );
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
    const inserted = await insertSimpleContentQuestions(finalQ);
    await finishRun(runId, {
      status: "succeeded",
      insertedCount: inserted,
      error: null,
      previewJson: { inserted, subcategoryKey: input.subcategoryKey },
    });
    return { runId, inserted };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    await finishRun(runId, {
      status: "failed",
      insertedCount: 0,
      error: msg,
      previewJson: null,
    });
    throw error;
  }
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

export { getPromptBody, upsertPromptBody, listRuns, listActivePresets };
export { getAutomation, upsertAutomation } from "./repository";
