import { extractJsonArray, normalizeFactoryQuestionsLenient } from "../aiFactory/utils";
import type { FactoryDifficulty, FactoryQuestion } from "../aiFactory/types";
import { readSubcategoryEditorContext } from "./context";
import {
  applyDraftUserTemplatePlaceholders,
  buildDraftPromptSystemMessage,
  buildDraftPromptUserMessageTemplate,
  getAdminPromptTemplatesPayload,
  SIMPLE_CONTENT_DRAFT_PLACEHOLDERS_HELP,
  SIMPLE_QUESTION_JSON_CONTRACT,
} from "./promptContract";
import {
  APP_KEY_SIMPLE_CONTENT_DRAFT_SYSTEM,
  APP_KEY_SIMPLE_CONTENT_DRAFT_USER,
  APP_KEY_SIMPLE_CONTENT_DEFAULT_DRAFT_PRESET_ID,
  APP_KEY_SIMPLE_CONTENT_DEFAULT_GENERATE_PRESET_ID,
  bumpAutomationNextRun,
  createRun,
  finalizeSimpleContentRun,
  getAppSettingValue,
  getPresetById,
  getPromptBody,
  getRunById,
  listActivePresets,
  listDueAutomations,
  getRunsUsageSummaryForSubcategory,
  listRuns,
  upsertAppSettingValue,
  upsertPromptBody,
} from "./repository";
import { insertSimpleContentQuestions } from "./insertQuestions";
import { resolveSimpleContentProvider } from "./llm/registry";
import type { SimpleContentPreset } from "./types";
import type { LLMTokenUsage } from "./llm/types";
import { estimateGeminiCallCostUsd, GEMINI_PRICING_DOC_URL } from "./geminiPricing";

const PRICING_DISCLAIMER_AR =
  "تقدير تقريبي بناءً على أسعار المنشورات الرسمية لـ Google (طبقة Standard)؛ الفاتورة الفعلية من مزود الخدمة.";

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

function packUsageForFinalize(
  preset: SimpleContentPreset,
  usage: LLMTokenUsage | null | undefined,
): {
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  usageTotalTokens: number | null;
  estimatedCostUsd: number | null;
} {
  if (!usage) {
    return { usageInputTokens: null, usageOutputTokens: null, usageTotalTokens: null, estimatedCostUsd: null };
  }
  const inT = usage.inputTokens;
  const outT = usage.outputTokens;
  const tot = usage.totalTokens;
  if (preset.provider !== "gemini") {
    return { usageInputTokens: inT, usageOutputTokens: outT, usageTotalTokens: tot, estimatedCostUsd: null };
  }
  const { usd } = estimateGeminiCallCostUsd(preset.modelId, inT, outT);
  return {
    usageInputTokens: inT,
    usageOutputTokens: outT,
    usageTotalTokens: tot,
    estimatedCostUsd: usd,
  };
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

async function loadEffectiveDraftPromptParts(ctx: {
  mainCategoryName: string;
  subcategoryName: string;
  internalDescription: string;
}): Promise<{ system: string; userFilled: string }> {
  const [sysDb, userDb] = await Promise.all([
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_SYSTEM),
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_USER),
  ]);
  const system = String(sysDb ?? "").trim() ? String(sysDb) : buildDraftPromptSystemMessage();
  const userTpl = String(userDb ?? "").trim() ? String(userDb) : buildDraftPromptUserMessageTemplate();
  const userFilled = applyDraftUserTemplatePlaceholders(userTpl, ctx);
  return { system, userFilled };
}

export async function getSimpleContentDraftTemplateForAdmin(): Promise<{
  system: string;
  userTemplate: string;
  defaultsFromCode: { system: string; userTemplate: string };
  placeholdersHelp: string;
  pricingDocUrl: string;
}> {
  const [sysDb, userDb] = await Promise.all([
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_SYSTEM),
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_USER),
  ]);
  const defaults = getAdminPromptTemplatesPayload();
  return {
    system: String(sysDb ?? "").trim() ? String(sysDb) : defaults.draftSystemMessage,
    userTemplate: String(userDb ?? "").trim() ? String(userDb) : defaults.draftUserMessageTemplate,
    defaultsFromCode: {
      system: defaults.draftSystemMessage,
      userTemplate: defaults.draftUserMessageTemplate,
    },
    placeholdersHelp: SIMPLE_CONTENT_DRAFT_PLACEHOLDERS_HELP,
    pricingDocUrl: GEMINI_PRICING_DOC_URL,
  };
}

export async function saveSimpleContentDraftTemplate(input: { system: string; userTemplate: string }): Promise<void> {
  await upsertAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_SYSTEM, input.system);
  await upsertAppSettingValue(APP_KEY_SIMPLE_CONTENT_DRAFT_USER, input.userTemplate);
}

type LlmSnap = { usage: LLMTokenUsage | null; modelText: string | null };

async function llmNormalizeToFinalQuestions(
  input: {
    subcategoryKey: string;
    batchSize: number;
    difficultyMode: FactoryDifficulty;
    preset: SimpleContentPreset;
    userPrompt: string;
  },
  snap: LlmSnap,
): Promise<{ modelText: string; finishReason: string | null; finalQuestions: FactoryQuestion[] }> {
  const provider = resolveSimpleContentProvider(input.preset);
  const out = await provider.complete({ prompt: input.userPrompt }, input.preset);
  snap.usage = out.usage ?? null;
  snap.modelText = out.text;
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

export async function generatePromptDraft(
  subcategoryKey: string,
  presetId?: number,
): Promise<{
  draft: string;
  usage: LLMTokenUsage | null;
  estimatedCostUsd: number | null;
  pricingTier: string;
  pricingDocUrl: string;
  pricingDisclaimer: string;
}> {
  const ctx = await readSubcategoryEditorContext(subcategoryKey);
  const preset = await resolvePresetForDraft(presetId);
  const { system, userFilled } = await loadEffectiveDraftPromptParts({
    mainCategoryName: ctx.mainCategoryName,
    subcategoryName: ctx.subcategoryName,
    internalDescription: ctx.internalDescription,
  });
  const provider = resolveSimpleContentProvider(preset);
  const text = [system, "", userFilled].join("\n");
  const out = await provider.complete({ prompt: text }, preset);
  if (out.finishReason === "MAX_TOKENS") {
    throw new Error("layer_output_truncated_max_tokens:layer=simple_content_draft");
  }
  const usage = out.usage ?? null;
  let costUsd: number | null = null;
  let tier: string;
  if (preset.provider !== "gemini") {
    tier = "non_gemini";
  } else if (!usage) {
    tier = "no_usage_metadata";
  } else {
    const est = estimateGeminiCallCostUsd(preset.modelId, usage.inputTokens, usage.outputTokens);
    costUsd = est.usd;
    tier = est.pricingTier;
  }
  return {
    draft: out.text.trim(),
    usage,
    estimatedCostUsd: costUsd,
    pricingTier: tier,
    pricingDocUrl: GEMINI_PRICING_DOC_URL,
    pricingDisclaimer: PRICING_DISCLAIMER_AR,
  };
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
  const snap: LlmSnap = { usage: null, modelText: null };
  try {
    const { modelText: mt, finalQuestions } = await llmNormalizeToFinalQuestions(
      {
        subcategoryKey: input.subcategoryKey,
        batchSize: input.batchSize,
        difficultyMode: input.difficultyMode,
        preset,
        userPrompt,
      },
      snap,
    );
    const usagePack = packUsageForFinalize(preset, snap.usage);
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
      modelResponse: mt,
      normalizedQuestions: null,
      ...usagePack,
    });
    return { runId, inserted: questionIds.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    const usagePack = packUsageForFinalize(preset, snap.usage);
    await finalizeSimpleContentRun(runId, {
      status: "failed",
      insertedCount: 0,
      error: msg,
      previewJson: null,
      requestPrompt: userPrompt,
      modelResponse: snap.modelText,
      normalizedQuestions: null,
      ...usagePack,
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
  const snap: LlmSnap = { usage: null, modelText: null };
  try {
    const { modelText: mt, finalQuestions } = await llmNormalizeToFinalQuestions(
      {
        subcategoryKey: input.subcategoryKey,
        batchSize: input.batchSize,
        difficultyMode: input.difficultyMode,
        preset,
        userPrompt,
      },
      snap,
    );
    const usagePack = packUsageForFinalize(preset, snap.usage);
    await finalizeSimpleContentRun(runId, {
      status: "pending_review",
      insertedCount: 0,
      error: null,
      previewJson: {
        subcategoryKey: input.subcategoryKey,
        questionCount: finalQuestions.length,
      },
      requestPrompt: userPrompt,
      modelResponse: mt,
      normalizedQuestions: finalQuestions,
      ...usagePack,
    });
    return { runId, questionCount: finalQuestions.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown_error";
    const usagePack = packUsageForFinalize(preset, snap.usage);
    await finalizeSimpleContentRun(runId, {
      status: "failed",
      insertedCount: 0,
      error: msg,
      previewJson: null,
      requestPrompt: userPrompt,
      modelResponse: snap.modelText,
      normalizedQuestions: null,
      ...usagePack,
    });
    const wrapped = error instanceof Error ? error : new Error(String(error));
    Object.assign(wrapped, { runId });
    throw wrapped;
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
    usageInputTokens: run.usageInputTokens,
    usageOutputTokens: run.usageOutputTokens,
    usageTotalTokens: run.usageTotalTokens,
    estimatedCostUsd: run.estimatedCostUsd,
  });
  return { inserted: questionIds.length, questionIds };
}

function parsePositiveIntSetting(raw: string | null): number | null {
  if (raw == null || !String(raw).trim()) return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function getSimpleContentPresetUiDefaults(): Promise<{
  defaultDraftPresetId: number | null;
  defaultGeneratePresetId: number | null;
}> {
  const [draftRaw, genRaw] = await Promise.all([
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DEFAULT_DRAFT_PRESET_ID),
    getAppSettingValue(APP_KEY_SIMPLE_CONTENT_DEFAULT_GENERATE_PRESET_ID),
  ]);
  return {
    defaultDraftPresetId: parsePositiveIntSetting(draftRaw),
    defaultGeneratePresetId: parsePositiveIntSetting(genRaw),
  };
}

async function setSimpleContentPresetUiDefaults(input: {
  draftPresetId?: number | null;
  generatePresetId?: number | null;
}): Promise<void> {
  const active = await listActivePresets();
  const activeIds = new Set(active.map((p) => p.id));
  const assertValid = (id: number | null) => {
    if (id != null && !activeIds.has(id)) {
      throw new Error("simple_content_invalid_preset");
    }
  };
  if (Object.prototype.hasOwnProperty.call(input, "draftPresetId")) {
    const v = input.draftPresetId ?? null;
    assertValid(v);
    await upsertAppSettingValue(
      APP_KEY_SIMPLE_CONTENT_DEFAULT_DRAFT_PRESET_ID,
      v == null ? "" : String(v),
    );
  }
  if (Object.prototype.hasOwnProperty.call(input, "generatePresetId")) {
    const v = input.generatePresetId ?? null;
    assertValid(v);
    await upsertAppSettingValue(
      APP_KEY_SIMPLE_CONTENT_DEFAULT_GENERATE_PRESET_ID,
      v == null ? "" : String(v),
    );
  }
}

/** يمنع تشغيل دورة جديدة قبل انتهاء السابقة (تيك cron كل دقيقة قد يتداخل). */
let simpleContentSchedulerTickRunning = false;

/** يُزاد عند تخطّي تيك لأن الدورة السابقة ما زالت تعمل (مراقبة تشغيلية). */
let simpleContentSchedulerSkippedBusyTicks = 0;

/** بعد الفشل: إن كانت `false` لا يُحدَّث `next_run_at` (إعادة المحاولة عند الاستحقاق دون تأخير إضافي). أنظر `SIMPLE_CONTENT_SCHEDULER_BUMP_AFTER_FAILURE`. */
function bumpScheduledAfterFailure(): boolean {
  const raw = process.env.SIMPLE_CONTENT_SCHEDULER_BUMP_AFTER_FAILURE;
  if (raw === undefined || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

export function getSimpleContentSchedulerStats(): { skippedTicksBusy: number } {
  return { skippedTicksBusy: simpleContentSchedulerSkippedBusyTicks };
}

/**
 * سياسة الموعد للجدولة الافتراضية: بعد محاولة ناجحة نُحدّث `next_run_at`.
 * عند الفشل: يُحدَّث الموعد أيضًا ما لم يُضبط `SIMPLE_CONTENT_SCHEDULER_BUMP_AFTER_FAILURE=false`
 * (حينها يبقى الموعد الحالي فيُعاد الاستحقاق في التيكات التالية بلا تأخير إضافي بمقدار الفاصل).
 * تفاصيل الفشل في `simple_content_runs` والسجلات.
 */
export async function runSimpleContentSchedulerTick(): Promise<void> {
  if (simpleContentSchedulerTickRunning) {
    simpleContentSchedulerSkippedBusyTicks += 1;
    console.info("[simple_content_scheduler] tick skipped (previous tick still running)");
    return;
  }
  simpleContentSchedulerTickRunning = true;
  try {
    const due = await listDueAutomations();
    const defaultBatch = Math.max(
      1,
      Math.min(50, Number(process.env.SIMPLE_CONTENT_SCHEDULER_BATCH_SIZE ?? 10) || 10),
    );
    const bumpAfterFail = bumpScheduledAfterFailure();
    for (const row of due) {
      const presetId = row.modelPresetId ?? (await listActivePresets())[0]?.id;
      if (!presetId) continue;
      let generateOk = false;
      try {
        await runSimpleContentGenerate({
          subcategoryKey: row.subcategoryKey,
          batchSize: defaultBatch,
          difficultyMode: "mix",
          presetId,
          triggerKind: "scheduled",
        });
        generateOk = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          `[simple_content_scheduler] scheduled generate failed subcategory=${row.subcategoryKey} intervalMin=${row.intervalMinutes}: ${detail}`,
        );
      }
      const shouldBump = generateOk || bumpAfterFail;
      if (shouldBump) {
        await bumpAutomationNextRun(row.subcategoryKey, row.intervalMinutes);
        if (!generateOk) {
          console.info(
            `[simple_content_scheduler] next_run bumped after failure subcategory=${row.subcategoryKey} (see simple_content_runs for run row)`,
          );
        }
      } else if (!generateOk) {
        console.info(
          `[simple_content_scheduler] next_run not bumped after failure (SIMPLE_CONTENT_SCHEDULER_BUMP_AFTER_FAILURE=false) subcategory=${row.subcategoryKey}`,
        );
      }
    }
  } finally {
    simpleContentSchedulerTickRunning = false;
  }
}

export {
  getPromptBody,
  upsertPromptBody,
  listRuns,
  listActivePresets,
  getRunById,
  getRunsUsageSummaryForSubcategory,
  getSimpleContentPresetUiDefaults,
  setSimpleContentPresetUiDefaults,
};
export { getAutomation, upsertAutomation } from "./repository";
