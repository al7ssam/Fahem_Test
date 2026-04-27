import { getPool } from "../../db/pool";
import { getLayerConfigHealth, LayerExecutionError, runLayerModel } from "./modelManager";
import { calculateGeminiCost, insertAiUsageLog } from "./usageAnalytics";
import { extractJsonArray, normalizeFactoryQuestion, normalizeFactoryQuestionsLenient } from "./utils";
import type {
  FactoryAuditReport,
  FactoryJobPayload,
  FactoryLayer,
  FactoryQuestion,
  FactoryValidationError,
} from "./types";

type JobRow = {
  id: number;
  subcategory_key: string;
  difficulty_mode: "mix" | "easy" | "medium" | "hard";
  target_count: number;
  batch_size: number;
  status: string;
  payload: unknown;
  attempt_count: number;
  max_attempts: number;
};

class JobCancelledError extends Error {
  readonly layer: FactoryLayer | null;
  constructor(layer: FactoryLayer | null) {
    super("job_cancelled_by_admin");
    this.layer = layer;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

async function appendJobLog(
  jobId: number,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  layer?: FactoryLayer,
  details?: unknown,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_factory_job_logs (job_id, layer_name, level, message, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [jobId, layer ?? null, level, message, JSON.stringify(details ?? {})],
  );
}

async function appendInspectionLog(input: {
  jobId: number;
  layer: FactoryLayer;
  promptText: string;
  rawResponseText: string;
  provider: string;
  modelName: string;
  apiVersion: string;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_factory_inspection_logs
      (job_id, layer_name, prompt_text, raw_response_text, provider, model_name, api_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.jobId,
      input.layer,
      input.promptText,
      input.rawResponseText,
      input.provider,
      input.modelName,
      input.apiVersion,
    ],
  );
}

async function appendAiUsageLogSafe(input: {
  jobId: number;
  subject: string;
  layer: FactoryLayer;
  modelId: string;
  status: "success" | "failed";
  usage?: {
    inputTokens: number;
    outputTokens: number;
  } | null;
}): Promise<void> {
  try {
    const pricing = calculateGeminiCost(
      input.usage?.inputTokens ?? 0,
      input.usage?.outputTokens ?? 0,
      input.modelId,
    );
    await insertAiUsageLog({
      jobId: input.jobId,
      modelId: input.modelId,
      layerType: input.layer,
      inputTokens: pricing.inputTokens,
      outputTokens: pricing.outputTokens,
      costUsd: pricing.costUsd,
      costSar: pricing.costSar,
      subject: input.subject,
      status: input.status,
    });
  } catch (error) {
    await appendJobLog(input.jobId, "warn", "usage_log_write_failed", input.layer, {
      error: error instanceof Error ? error.message : "unknown_usage_log_error",
      modelId: input.modelId,
      status: input.status,
    });
  }
}

async function isJobCancelled(jobId: number): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM ai_factory_jobs WHERE id = $1 LIMIT 1`,
    [jobId],
  );
  return String(r.rows[0]?.status || "") === "cancelled";
}

async function assertNotCancelled(jobId: number, layer: FactoryLayer | null): Promise<void> {
  if (await isJobCancelled(jobId)) {
    throw new JobCancelledError(layer);
  }
}

async function saveJobFinalOutput(jobId: number, questions: FactoryQuestion[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE ai_factory_jobs
     SET final_output_json = $1::jsonb, updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(questions), jobId],
  );
}

async function setJobState(
  jobId: number,
  data: {
    status?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    currentLayer?: FactoryLayer | null;
    lastError?: string | null;
    resultSummary?: unknown;
    started?: boolean;
    finished?: boolean;
    nextRunAt?: Date | null;
    incrementAttempt?: boolean;
  },
): Promise<void> {
  const pool = getPool();
  const updates: string[] = [];
  const params: unknown[] = [];
  if (data.status) {
    params.push(data.status);
    updates.push(`status = $${params.length}`);
  }
  if (data.currentLayer !== undefined) {
    params.push(data.currentLayer);
    updates.push(`current_layer = $${params.length}`);
  }
  if (data.lastError !== undefined) {
    params.push(data.lastError);
    updates.push(`last_error = $${params.length}`);
  }
  if (data.resultSummary !== undefined) {
    params.push(JSON.stringify(data.resultSummary ?? {}));
    updates.push(`result_summary = $${params.length}::jsonb`);
  }
  if (data.started) updates.push(`started_at = NOW()`);
  if (data.finished) updates.push(`finished_at = NOW()`);
  if (data.nextRunAt !== undefined) {
    params.push(data.nextRunAt);
    updates.push(`next_run_at = $${params.length}`);
  }
  if (data.incrementAttempt) updates.push(`attempt_count = attempt_count + 1`);
  updates.push(`updated_at = NOW()`);
  params.push(jobId);
  await pool.query(
    `UPDATE ai_factory_jobs SET ${updates.join(", ")} WHERE id = $${params.length}`,
    params,
  );
}

async function readSubcategoryContext(subcategoryKey: string): Promise<{
  subcategoryName: string;
  subcategoryDescription: string;
  mainCategoryName: string;
}> {
  const pool = getPool();
  const r = await pool.query<{
    sub_name_ar: string;
    sub_desc: string;
    main_name_ar: string;
  }>(
    `SELECT
       COALESCE(sc.name_ar, sc.subcategory_key) AS sub_name_ar,
       COALESCE(sc.internal_description, '') AS sub_desc,
       COALESCE(mc.name_ar, '') AS main_name_ar
     FROM question_subcategories sc
     LEFT JOIN question_main_categories mc ON mc.id = sc.main_category_id
     WHERE sc.subcategory_key = $1
     LIMIT 1`,
    [subcategoryKey],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(`subcategory_not_found:${subcategoryKey}`);
  }
  return {
    subcategoryName: row.sub_name_ar,
    subcategoryDescription: row.sub_desc,
    mainCategoryName: row.main_name_ar,
  };
}

function chooseDifficulty(mode: "mix" | "easy" | "medium" | "hard", index: number): "easy" | "medium" | "hard" {
  if (mode === "easy" || mode === "medium" || mode === "hard") return mode;
  const order: Array<"easy" | "medium" | "hard"> = ["easy", "medium", "hard"];
  return order[index % order.length];
}

type FactoryPromptVariant = "baseline" | "optimized";

type PromptConstraintPack = {
  schema: string;
  distribution: string;
  studyBody: string;
  output: string;
};

const SHARED_PROMPT_CONSTRAINTS: PromptConstraintPack = {
  schema:
    "Each question must contain: prompt, options, correctIndex, studyBody, subcategoryKey, difficulty, questionType. options length must be 2 or 4, correctIndex must be in range.",
  distribution:
    "questionType distribution target per batch: 30% conceptual, 30% procedural, 40% application.",
  studyBody:
    "studyBody must be exactly [principle/rule] + [why correct] + [memory tip], concise and flashcard-friendly.",
  output: "Return ONLY valid JSON (no markdown fences, no commentary).",
};

function resolvePromptVariant(payload: unknown): FactoryPromptVariant {
  const fromPayload =
    payload && typeof payload === "object" ? String((payload as Record<string, unknown>).promptVariant ?? "") : "";
  if (fromPayload === "baseline" || fromPayload === "optimized") return fromPayload;
  const fromEnv = String(process.env.AI_FACTORY_PROMPT_VARIANT ?? "").trim().toLowerCase();
  if (fromEnv === "baseline" || fromEnv === "optimized") return fromEnv;
  return "optimized";
}

function buildPromptArchitectureAnalysis(input: {
  variant: FactoryPromptVariant;
  subcategoryKey: string;
  subcategoryName: string;
  mainCategoryName: string;
}): Record<string, unknown> {
  return {
    variant: input.variant,
    subcategoryKey: input.subcategoryKey,
    subcategoryName: input.subcategoryName,
    mainCategoryName: input.mainCategoryName,
    sharedConstraintPack: SHARED_PROMPT_CONSTRAINTS,
  };
}

function buildArchitectPrompt(input: {
  subcategoryKey: string;
  subcategoryName: string;
  subcategoryDescription: string;
  mainCategoryName: string;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  targetCount: number;
  variant: FactoryPromptVariant;
}): string {
  if (input.variant === "baseline") {
    return [
      "You are The Architect layer for an educational content factory.",
      "Create a concise domain-specific prompt in Arabic for generating pedagogical study quiz questions.",
      `Main category: ${input.mainCategoryName || "N/A"}`,
      `Subcategory: ${input.subcategoryName} (${input.subcategoryKey})`,
      `Internal description: ${input.subcategoryDescription || "N/A"}`,
      `Difficulty mode: ${input.difficultyMode}`,
      `Target count: ${input.targetCount}`,
      "Rules:",
      "- Prompt must enforce JSON array output only.",
      "- Each question must contain prompt, options, correctIndex, studyBody, subcategoryKey, difficulty, questionType.",
      "- Enforce pedagogical Bloom-like progression per batch: 30% conceptual, 30% procedural, 40% application.",
      "- questionType values are strictly: conceptual | procedural | application.",
      "- difficulty mapping must follow learning progression:",
      "  easy => foundational concepts and terminology.",
      "  medium => procedural/relational reasoning and ordered steps.",
      "  hard => synthesis/problem solving and connecting multiple ideas.",
      "- options length must be 2 or 4 only.",
      "- correctIndex must be 0-based and inside options length.",
      "- studyBody must be a micro-lesson in this exact structure:",
      "  [scientific principle/rule] + [why this answer is correct] + [quick memory tip].",
      "- Wording should support active recall and flashcard style (short Q/A friendly).",
      "- Language should be Arabic and pedagogically clear.",
      "Return only the prompt text (no markdown).",
    ].join("\n");
  }
  return [
    "You are The Architect layer.",
    "Return a SHORT Arabic domain brief (3-6 lines) that helps generation quality for this subcategory.",
    `Main category: ${input.mainCategoryName || "N/A"}`,
    `Subcategory: ${input.subcategoryName} (${input.subcategoryKey})`,
    `Internal description: ${input.subcategoryDescription || "N/A"}`,
    `Difficulty mode: ${input.difficultyMode}`,
    `Target count: ${input.targetCount}`,
    "Do not repeat full schema constraints; focus on domain misconceptions, concept boundaries, and pedagogical focus.",
    "Return plain text only.",
  ].join("\n");
}

function buildCreatorPrompt(args: {
  architectPrompt: string;
  subcategoryKey: string;
  batchSize: number;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  alreadyGenerated: number;
  variant: FactoryPromptVariant;
}): string {
  if (args.variant === "baseline") {
    return [
      args.architectPrompt,
      "",
      "Now generate a JSON array of questions.",
      `Batch size: ${args.batchSize}`,
      `Subcategory key must be exactly: ${args.subcategoryKey}`,
      `Difficulty mode: ${args.difficultyMode}`,
      "If difficulty mode is mix, distribute easy/medium/hard fairly.",
      "Enforce pedagogical question type distribution per batch as close as possible:",
      "- 30% conceptual",
      "- 30% procedural",
      "- 40% application",
      "Every question must include questionType with one of: conceptual, procedural, application.",
      "studyBody must be a micro-lesson with mandatory 3-part structure:",
      "1) Scientific principle/rule",
      "2) Why the answer is correct",
      "3) Quick memory tip",
      "Write prompts and studyBody in an active-recall/flashcard-friendly style.",
      `Already generated in current run: ${args.alreadyGenerated}`,
      "Return ONLY valid JSON array.",
      "Do not wrap in markdown fences.",
      "No commentary before or after JSON.",
      "Use standard double quotes for all JSON keys and string values.",
    ].join("\n");
  }
  return [
    "You are The Creator layer for educational quiz content in Arabic.",
    `Domain brief from Architect:\n${args.architectPrompt}`,
    "Generate the final question array now.",
    `Batch size: ${args.batchSize}`,
    `Subcategory key must be exactly: ${args.subcategoryKey}`,
    `Difficulty mode: ${args.difficultyMode}`,
    SHARED_PROMPT_CONSTRAINTS.schema,
    SHARED_PROMPT_CONSTRAINTS.distribution,
    "difficulty values must be English only: easy | medium | hard.",
    SHARED_PROMPT_CONSTRAINTS.studyBody,
    "Language must be Arabic and suitable for active recall.",
    `Already generated in current run: ${args.alreadyGenerated}`,
    SHARED_PROMPT_CONSTRAINTS.output,
    "Use standard double quotes for all JSON keys and string values.",
  ].join("\n");
}

function buildAuditorPrompt(
  questions: FactoryQuestion[],
  validationErrors: FactoryValidationError[],
  variant: FactoryPromptVariant,
): string {
  if (variant === "baseline") {
    return [
      "You are The Auditor layer.",
      "You are responsible for auditing pedagogical integrity, technical integrity, and content quality.",
      "Audit the following JSON questions for correctness, pedagogical balance, and technical integrity.",
      "You MUST verify that difficulty uses English values only: easy, medium, hard.",
      "If Arabic difficulty values are found (سهل، متوسط، صعب), report them as issues that require fixing.",
      "Verify questionType exists and uses only: conceptual, procedural, application.",
      "Check educational distribution target in the batch (closest possible): 30% conceptual, 30% procedural, 40% application.",
      "Check difficulty-to-learning mapping:",
      "- easy => foundational concepts/terminology",
      "- medium => procedural logic and step ordering",
      "- hard => synthesis/problem-solving",
      "Check studyBody is a micro-lesson with mandatory structure:",
      "[principle/rule] + [why correct] + [memory tip].",
      "Check wording supports active recall/flashcard usage (short, direct, memory-oriented).",
      "Ensure all JSON keys and values conform to required schema constraints.",
      `Pre-validation errors from server: ${JSON.stringify(validationErrors)}`,
      "Return JSON object with fields: summary (string), issues (array of strings), requiresRefine (boolean).",
      "If there are no issues, issues should be empty and requiresRefine false.",
      JSON.stringify(questions),
    ].join("\n");
  }
  return [
    "You are The Auditor layer.",
    "Audit only risks not already guaranteed by strict schema validation.",
    "Focus on: pedagogical mismatch, weak active-recall wording, malformed micro-lesson structure, or wrong conceptual/procedural/application intent.",
    SHARED_PROMPT_CONSTRAINTS.distribution,
    "difficulty must be English only: easy | medium | hard.",
    SHARED_PROMPT_CONSTRAINTS.studyBody,
    `Pre-validation errors from server: ${JSON.stringify(validationErrors)}`,
    "Return strict JSON object with fields:",
    `{"summary":"...", "issues":["..."], "requiresRefine": true|false}`,
    "Do not use markdown fences.",
    JSON.stringify(questions),
  ].join("\n");
}

function buildRefinerPrompt(
  questions: FactoryQuestion[],
  audit: FactoryAuditReport,
  validationErrors: FactoryValidationError[],
  variant: FactoryPromptVariant,
): string {
  if (variant === "baseline") {
    return [
      "You are The Refiner layer.",
      "Fix the question array based on the audit report and return corrected JSON array only.",
      "Preserve schema fields exactly.",
      "You must repair technical and pedagogical issues before final output.",
      "Constraints: options length 2 or 4, correctIndex in-range, non-empty studyBody, valid difficulty.",
      "questionType is mandatory and must be one of: conceptual, procedural, application.",
      "Rebalance questionType distribution in the batch as close as possible to: 30% conceptual, 30% procedural, 40% application.",
      "Align difficulty with pedagogical mapping:",
      "- easy foundational concepts",
      "- medium procedural reasoning",
      "- hard synthesis/problem-solving",
      "Difficulty must be English only (easy, medium, hard).",
      "studyBody must follow exact micro-lesson structure:",
      "[principle/rule] + [why correct] + [memory tip].",
      "Use active-recall and flashcard-friendly style when rewriting.",
      "Fix any invalid values and malformed structures whenever possible.",
      "Return ONLY valid JSON array.",
      "Do not wrap in markdown fences.",
      "No commentary before or after JSON.",
      "Use standard double quotes for all JSON keys and string values.",
      `Audit summary: ${audit.summary}`,
      `Audit issues: ${JSON.stringify(audit.issues)}`,
      `Validation errors from server: ${JSON.stringify(validationErrors)}`,
      JSON.stringify(questions),
    ].join("\n");
  }
  return [
    "You are The Refiner layer.",
    "Repair only issues reported by Auditor and validator while keeping valid rows unchanged as much as possible.",
    SHARED_PROMPT_CONSTRAINTS.schema,
    SHARED_PROMPT_CONSTRAINTS.distribution,
    SHARED_PROMPT_CONSTRAINTS.studyBody,
    SHARED_PROMPT_CONSTRAINTS.output,
    "Use standard double quotes for all JSON keys and string values.",
    `Audit summary: ${audit.summary}`,
    `Audit issues: ${JSON.stringify(audit.issues)}`,
    `requiresRefine: ${String(audit.requiresRefine)}`,
    `Validation errors from server: ${JSON.stringify(validationErrors)}`,
    JSON.stringify(questions),
  ].join("\n");
}

function extractJsonPayload(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) return raw.slice(first, last + 1).trim();
  return null;
}

function parseAuditReport(text: string): FactoryAuditReport {
  const payload = extractJsonPayload(text);
  if (!payload) {
    return {
      summary: "Audit returned non-JSON output.",
      issues: ["non_json_audit_output"],
      requiresRefine: true,
    };
  }
  try {
    const parsed = JSON.parse(payload) as { summary?: unknown; issues?: unknown; requiresRefine?: unknown };
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x)) : [];
    const requiresRefine =
      typeof parsed.requiresRefine === "boolean" ? parsed.requiresRefine : issues.length > 0;
    return {
      summary: String(parsed.summary ?? "").trim() || "Audit completed.",
      issues,
      requiresRefine,
    };
  } catch {
    return {
      summary: "Audit returned invalid JSON payload.",
      issues: ["invalid_json_audit_output"],
      requiresRefine: true,
    };
  }
}

function compactSnippet(input: string, max = 180): string {
  const s = String(input || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

type NormalizedCreatorBatch = {
  questions: FactoryQuestion[];
  validationErrors: FactoryValidationError[];
};

function normalizeQuestionsFromCreator(rawText: string, job: JobRow): NormalizedCreatorBatch {
  const arr = extractJsonArray(rawText);
  if (!arr) {
    return {
      questions: [],
      validationErrors: [
        {
          code: "invalid_json_output",
          field: "root",
          index: -1,
          message: `invalid_json_output:layer=creator:snippet=${compactSnippet(rawText)}`,
          before: compactSnippet(rawText, 300),
        },
      ],
    };
  }
  return normalizeFactoryQuestionsLenient(arr, {
    fallbackSubcategoryKey: job.subcategory_key,
    forcedDifficultyMode: job.difficulty_mode,
  });
}

function normalizeQuestionsFromRefinerStrict(rawText: string, job: JobRow): FactoryQuestion[] {
  const arr = extractJsonArray(rawText);
  if (!arr) {
    throw new Error(`invalid_json_output:layer=refiner:snippet=${compactSnippet(rawText)}`);
  }
  return arr.map((item, idx) => {
    const q = normalizeFactoryQuestion(item, idx);
    if (q.subcategoryKey !== job.subcategory_key) {
      throw new Error(`question_${idx + 1}_invalid_subcategory_key_after_refiner`);
    }
    if (job.difficulty_mode !== "mix" && q.difficulty !== job.difficulty_mode) {
      throw new Error(`question_${idx + 1}_invalid_difficulty_after_refiner`);
    }
    return q;
  });
}

async function insertQuestionsAllOrNothing(questions: FactoryQuestion[]): Promise<number> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const q of questions) {
      await client.query(
        `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key, question_type)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)`,
        [
          q.prompt,
          JSON.stringify(q.options),
          q.correctIndex,
          q.difficulty,
          q.studyBody,
          q.subcategoryKey,
          q.questionType,
        ],
      );
    }
    await client.query("COMMIT");
    return questions.length;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}

async function refreshPipelineState(
  subcategoryKey: string,
  update: {
    lastJobId: number;
    lastStatus: "running" | "succeeded" | "failed";
    lastLayer?: FactoryLayer | null;
    lastError?: string | null;
    generatedDelta?: number;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_factory_pipeline_state (
       subcategory_key, last_job_id, last_status, last_layer, last_error, generated_count, target_count, last_run_at, last_success_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 200, NOW(), CASE WHEN $3 = 'succeeded' THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (subcategory_key) DO UPDATE SET
       last_job_id = EXCLUDED.last_job_id,
       last_status = EXCLUDED.last_status,
       last_layer = EXCLUDED.last_layer,
       last_error = EXCLUDED.last_error,
       generated_count = GREATEST(0, ai_factory_pipeline_state.generated_count + EXCLUDED.generated_count),
       last_run_at = NOW(),
       last_success_at = CASE WHEN EXCLUDED.last_status = 'succeeded' THEN NOW() ELSE ai_factory_pipeline_state.last_success_at END,
       updated_at = NOW()`,
    [
      subcategoryKey,
      update.lastJobId,
      update.lastStatus,
      update.lastLayer ?? null,
      update.lastError ?? null,
      Number(update.generatedDelta ?? 0),
    ],
  );
}

/**
 * Safety net: if runFactoryJob rejects outside its catch (should be rare after preamble moved inside try),
 * transition the job from running using the same retry policy as the main catch (uses claim-time attempt_count).
 */
export async function recoverFactoryJobAfterUnhandledError(job: JobRow, err: unknown): Promise<void> {
  const r = await getPool().query<{ status: string }>(
    `SELECT status FROM ai_factory_jobs WHERE id = $1 LIMIT 1`,
    [job.id],
  );
  if (String(r.rows[0]?.status || "") !== "running") return;

  const errMessage =
    err instanceof Error ? `worker_orchestrator_unhandled:${err.message}` : "worker_orchestrator_unhandled:unknown_error";
  const subKey = job.subcategory_key;

  await appendJobLog(job.id, "error", "Orchestrator exited unexpectedly", undefined, {
    error: errMessage,
  });

  if (job.attempt_count + 1 < job.max_attempts) {
    const backoffMinutes = Math.min(30, Math.max(1, 2 ** (job.attempt_count + 1)));
    const nextRunAt = new Date(Date.now() + backoffMinutes * 60_000);
    await setJobState(job.id, {
      status: "queued",
      finished: false,
      currentLayer: null,
      lastError: errMessage,
      nextRunAt,
    });
    await appendJobLog(job.id, "warn", "Job re-queued after worker safety recovery", undefined, {
      nextRunAt: nextRunAt.toISOString(),
      backoffMinutes,
    });
  } else {
    await setJobState(job.id, {
      status: "failed",
      finished: true,
      currentLayer: null,
      lastError: errMessage,
    });
    await refreshPipelineState(subKey, {
      lastJobId: job.id,
      lastStatus: "failed",
      lastLayer: null,
      lastError: errMessage,
    });
  }
}

/** Jobs left `running` (e.g. process crash) with no progress for this long are re-queued or failed on server start. */
const STALE_RUNNING_THRESHOLD_MINUTES = 60;

export async function reclaimStaleRunningJobsOnStartup(): Promise<number> {
  const pool = getPool();
  const stale = await pool.query<{
    id: number;
    attempt_count: number;
    max_attempts: number;
    subcategory_key: string;
  }>(
    `SELECT id, attempt_count, max_attempts, subcategory_key
     FROM ai_factory_jobs
     WHERE status = 'running'
       AND updated_at < NOW() - (INTERVAL '1 minute' * $1::int)`,
    [STALE_RUNNING_THRESHOLD_MINUTES],
  );
  let reclaimed = 0;
  for (const row of stale.rows) {
    const errTag = "stale_running_reclaimed_on_startup";
    await appendJobLog(row.id, "warn", errTag, undefined, {
      staleAfterMinutes: STALE_RUNNING_THRESHOLD_MINUTES,
    });
    if (row.attempt_count < row.max_attempts) {
      const backoffMinutes = Math.min(30, Math.max(1, 2 ** row.attempt_count));
      const nextRunAt = new Date(Date.now() + backoffMinutes * 60_000);
      await setJobState(row.id, {
        status: "queued",
        finished: false,
        currentLayer: null,
        lastError: errTag,
        nextRunAt,
      });
      await appendJobLog(row.id, "warn", "Stale running job re-queued on startup", undefined, {
        nextRunAt: nextRunAt.toISOString(),
        backoffMinutes,
      });
    } else {
      await setJobState(row.id, {
        status: "failed",
        finished: true,
        currentLayer: null,
        lastError: errTag,
      });
      await refreshPipelineState(row.subcategory_key, {
        lastJobId: row.id,
        lastStatus: "failed",
        lastLayer: null,
        lastError: errTag,
      });
    }
    reclaimed += 1;
  }
  return reclaimed;
}

export async function runFactoryJob(job: JobRow): Promise<void> {
  let failedLayer: FactoryLayer | null = "architect";
  let jobSubject = "غير محدد";
  const promptVariant = resolvePromptVariant(job.payload);
  try {
    await appendJobLog(job.id, "info", `Job started at ${nowIso()}`);
    await setJobState(job.id, {
      status: "running",
      started: true,
      currentLayer: "architect",
      incrementAttempt: true,
      lastError: null,
    });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "architect",
    });
    await assertNotCancelled(job.id, failedLayer);
    const architectHealth = await getLayerConfigHealth("architect");
    if (architectHealth.status === "fail") {
      throw new Error(`architect_preflight_failed:${architectHealth.reasons.join("|")}`);
    }
    const context = await readSubcategoryContext(job.subcategory_key);
    jobSubject = context.mainCategoryName || context.subcategoryName || job.subcategory_key;
    await appendJobLog(job.id, "info", "Prompt architecture analysis", "architect", {
      analysis: buildPromptArchitectureAnalysis({
        variant: promptVariant,
        subcategoryKey: job.subcategory_key,
        subcategoryName: context.subcategoryName,
        mainCategoryName: context.mainCategoryName,
      }),
    });

    const architectPrompt = buildArchitectPrompt({
      subcategoryKey: job.subcategory_key,
      subcategoryName: context.subcategoryName,
      subcategoryDescription: context.subcategoryDescription,
      mainCategoryName: context.mainCategoryName,
      difficultyMode: job.difficulty_mode,
      targetCount: job.target_count,
      variant: promptVariant,
    });
    const architect = await runLayerModel("architect", architectPrompt);
    await assertNotCancelled(job.id, failedLayer);
    await appendInspectionLog({
      jobId: job.id,
      layer: "architect",
      promptText: architectPrompt,
      rawResponseText: architect.rawResponseText,
      provider: architect.provider,
      modelName: architect.modelName,
      apiVersion: architect.apiVersion,
    });
    await appendAiUsageLogSafe({
      jobId: job.id,
      subject: jobSubject,
      layer: "architect",
      modelId: architect.modelName,
      status: "success",
      usage: architect.usageMetadata,
    });
    await appendJobLog(job.id, "info", "Architect layer completed", "architect", {
      model: architect.modelName,
    });

    failedLayer = "creator";
    await assertNotCancelled(job.id, failedLayer);
    await setJobState(job.id, { currentLayer: "creator" });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "creator",
    });
    const creatorPrompt = buildCreatorPrompt({
      architectPrompt: architect.text,
      subcategoryKey: job.subcategory_key,
      batchSize: job.batch_size,
      difficultyMode: job.difficulty_mode,
      alreadyGenerated: 0,
      variant: promptVariant,
    });
    await appendJobLog(job.id, "info", "Creator layer started", "creator");
    const creator = await runLayerModel("creator", creatorPrompt);
    await assertNotCancelled(job.id, failedLayer);
    await appendInspectionLog({
      jobId: job.id,
      layer: "creator",
      promptText: creatorPrompt,
      rawResponseText: creator.rawResponseText,
      provider: creator.provider,
      modelName: creator.modelName,
      apiVersion: creator.apiVersion,
    });
    await appendAiUsageLogSafe({
      jobId: job.id,
      subject: jobSubject,
      layer: "creator",
      modelId: creator.modelName,
      status: "success",
      usage: creator.usageMetadata,
    });
    const creatorNormalized = normalizeQuestionsFromCreator(creator.text, job);
    const creatorQuestions = creatorNormalized.questions;
    await appendJobLog(job.id, "info", "Creator layer completed", "creator", {
      generated: creatorQuestions.length,
      validationErrorsCount: creatorNormalized.validationErrors.length,
      validationErrors: creatorNormalized.validationErrors,
      model: creator.modelName,
    });

    failedLayer = "auditor";
    await assertNotCancelled(job.id, failedLayer);
    await setJobState(job.id, { currentLayer: "auditor" });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "auditor",
    });
    const auditorPrompt = buildAuditorPrompt(creatorQuestions, creatorNormalized.validationErrors, promptVariant);
    await appendJobLog(job.id, "info", "Auditor layer started", "auditor");
    const auditor = await runLayerModel("auditor", auditorPrompt);
    await assertNotCancelled(job.id, failedLayer);
    await appendInspectionLog({
      jobId: job.id,
      layer: "auditor",
      promptText: auditorPrompt,
      rawResponseText: auditor.rawResponseText,
      provider: auditor.provider,
      modelName: auditor.modelName,
      apiVersion: auditor.apiVersion,
    });
    await appendAiUsageLogSafe({
      jobId: job.id,
      subject: jobSubject,
      layer: "auditor",
      modelId: auditor.modelName,
      status: "success",
      usage: auditor.usageMetadata,
    });
    const auditReport = parseAuditReport(auditor.text);
    await appendJobLog(job.id, "info", "Auditor layer completed", "auditor", {
      summary: auditReport.summary,
      issuesCount: auditReport.issues.length,
      requiresRefine: auditReport.requiresRefine,
      issues: auditReport.issues,
      model: auditor.modelName,
    });

    const shouldRunRefiner =
      creatorNormalized.validationErrors.length > 0 ||
      auditReport.issues.length > 0 ||
      auditReport.requiresRefine;
    await appendJobLog(job.id, "info", "Refiner gating decision", undefined, {
      shouldRunRefiner,
      reasons: {
        validationErrors: creatorNormalized.validationErrors.length,
        auditIssues: auditReport.issues.length,
        requiresRefine: auditReport.requiresRefine,
      },
      promptVariant,
    });

    let finalQuestions = creatorQuestions;
    let finalLayerUsed: FactoryLayer = "creator";
    if (shouldRunRefiner) {
      failedLayer = "refiner";
      await assertNotCancelled(job.id, failedLayer);
      await setJobState(job.id, { currentLayer: "refiner" });
      await refreshPipelineState(job.subcategory_key, {
        lastJobId: job.id,
        lastStatus: "running",
        lastLayer: "refiner",
      });
      const refinerPrompt = buildRefinerPrompt(
        creatorQuestions,
        auditReport,
        creatorNormalized.validationErrors,
        promptVariant,
      );
      await appendJobLog(job.id, "info", "Refiner layer started", "refiner");
      const refiner = await runLayerModel("refiner", refinerPrompt);
      await assertNotCancelled(job.id, failedLayer);
      await appendInspectionLog({
        jobId: job.id,
        layer: "refiner",
        promptText: refinerPrompt,
        rawResponseText: refiner.rawResponseText,
        provider: refiner.provider,
        modelName: refiner.modelName,
        apiVersion: refiner.apiVersion,
      });
      await appendAiUsageLogSafe({
        jobId: job.id,
        subject: jobSubject,
        layer: "refiner",
        modelId: refiner.modelName,
        status: "success",
        usage: refiner.usageMetadata,
      });
      finalQuestions = normalizeQuestionsFromRefinerStrict(refiner.text, job);
      finalLayerUsed = "refiner";
    } else {
      await appendJobLog(job.id, "info", "Refiner skipped by gate", undefined, {
        promptVariant,
      });
    }

    if (finalQuestions.length > job.batch_size) {
      finalQuestions = finalQuestions.slice(0, job.batch_size);
    }
    if (finalQuestions.length === 0) {
      throw new Error("refiner_returned_empty_batch");
    }
    if (job.difficulty_mode === "mix") {
      finalQuestions = finalQuestions.map((q, idx) => ({
        ...q,
        difficulty: chooseDifficulty(job.difficulty_mode, idx),
      }));
    }
    await saveJobFinalOutput(job.id, finalQuestions);
    await assertNotCancelled(job.id, failedLayer);
    const inserted = await insertQuestionsAllOrNothing(finalQuestions);

    await setJobState(job.id, {
      status: "succeeded",
      finished: true,
      currentLayer: null,
      resultSummary: {
        inserted,
        auditedIssues: auditReport.issues.length,
        finalLayerUsed,
        promptVariant,
        refinerSkipped: !shouldRunRefiner,
      },
      lastError: null,
    });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "succeeded",
      lastLayer: null,
      generatedDelta: inserted,
      lastError: null,
    });
    await appendJobLog(job.id, "info", "Final batch committed successfully", finalLayerUsed, {
      inserted,
      finalLayerUsed,
      promptVariant,
      refinerSkipped: !shouldRunRefiner,
    });
    failedLayer = null;
  } catch (error) {
    if (error instanceof JobCancelledError) {
      await appendJobLog(job.id, "warn", "Job cancelled by admin", error.layer ?? undefined, {
        cancelled: true,
      });
      await setJobState(job.id, {
        status: "cancelled",
        finished: true,
        currentLayer: null,
        lastError: "cancelled_by_admin",
      });
      await refreshPipelineState(job.subcategory_key, {
        lastJobId: job.id,
        lastStatus: "failed",
        lastLayer: null,
        lastError: "cancelled_by_admin",
      });
      return;
    }
    const errMessage = error instanceof Error ? error.message : "unknown_error";
    const layerMeta = error instanceof LayerExecutionError ? error.meta : null;
    if (failedLayer && layerMeta?.modelName) {
      await appendAiUsageLogSafe({
        jobId: job.id,
        subject: jobSubject,
        layer: failedLayer,
        modelId: layerMeta.modelName,
        status: "failed",
        usage: null,
      });
    }
    await appendJobLog(job.id, "error", "Job failed", failedLayer ?? undefined, {
      error: errMessage,
      failedLayer: failedLayer ?? layerMeta?.layer ?? null,
      providerCode: layerMeta?.providerCode ?? null,
      retryable: layerMeta?.retryable ?? null,
      attempt: layerMeta?.attempt ?? null,
      maxAttempts: layerMeta?.maxAttempts ?? null,
      modelName: layerMeta?.modelName ?? null,
      apiVersion: layerMeta?.apiVersion ?? null,
      providerMessage: layerMeta?.providerMessage ?? null,
    });
    if (job.attempt_count + 1 < job.max_attempts) {
      const backoffMinutes = Math.min(30, Math.max(1, 2 ** (job.attempt_count + 1)));
      const nextRunAt = new Date(Date.now() + backoffMinutes * 60_000);
      await setJobState(job.id, {
        status: "queued",
        finished: false,
        currentLayer: null,
        lastError: errMessage,
        nextRunAt,
      });
      await appendJobLog(job.id, "warn", "Job re-queued after failure", undefined, {
        nextRunAt: nextRunAt.toISOString(),
        backoffMinutes,
      });
    } else {
      await setJobState(job.id, {
        status: "failed",
        finished: true,
        currentLayer: null,
        lastError: errMessage,
      });
      await refreshPipelineState(job.subcategory_key, {
        lastJobId: job.id,
        lastStatus: "failed",
        lastLayer: null,
        lastError: errMessage,
      });
    }
    return;
  }
}

export type FactoryJobPublic = {
  id: number;
  subcategoryKey: string;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  targetCount: number;
  batchSize: number;
  status: string;
  currentLayer: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  resultSummary: unknown;
};

export async function listFactoryJobs(limit = 50): Promise<FactoryJobPublic[]> {
  const pool = getPool();
  const r = await pool.query<{
    id: number;
    subcategory_key: string;
    difficulty_mode: "mix" | "easy" | "medium" | "hard";
    target_count: number;
    batch_size: number;
    status: string;
    current_layer: string | null;
    attempt_count: number;
    max_attempts: number;
    last_error: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    result_summary: unknown;
  }>(
    `SELECT id, subcategory_key, difficulty_mode, target_count, batch_size, status, current_layer,
            attempt_count, max_attempts, last_error, created_at, started_at, finished_at, result_summary
     FROM ai_factory_jobs
     ORDER BY id DESC
     LIMIT $1`,
    [Math.min(200, Math.max(1, limit))],
  );
  return r.rows.map((row) => ({
    id: row.id,
    subcategoryKey: row.subcategory_key,
    difficultyMode: row.difficulty_mode,
    targetCount: row.target_count,
    batchSize: row.batch_size,
    status: row.status,
    currentLayer: row.current_layer,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    resultSummary: row.result_summary,
  }));
}

export async function getFactoryJobLogs(jobId: number): Promise<Array<{
  id: number;
  layerName: string | null;
  level: string;
  message: string;
  details: unknown;
  createdAt: string;
}>> {
  const pool = getPool();
  const r = await pool.query<{
    id: number;
    layer_name: string | null;
    level: string;
    message: string;
    details: unknown;
    created_at: string;
  }>(
    `SELECT id, layer_name, level, message, details, created_at
     FROM ai_factory_job_logs
     WHERE job_id = $1
     ORDER BY id ASC`,
    [jobId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    layerName: row.layer_name,
    level: row.level,
    message: row.message,
    details: row.details,
    createdAt: row.created_at,
  }));
}

export type FactoryJobErrorTimelineEntry = {
  id: number;
  layerName: string | null;
  message: string;
  details: unknown;
  createdAt: string;
};

export async function getFactoryJobErrorTimeline(jobId: number): Promise<FactoryJobErrorTimelineEntry[]> {
  const pool = getPool();
  const r = await pool.query<{
    id: number;
    layer_name: string | null;
    message: string;
    details: unknown;
    created_at: string;
  }>(
    `SELECT id, layer_name, message, details, created_at
     FROM ai_factory_job_logs
     WHERE job_id = $1
       AND level = 'error'
     ORDER BY id ASC`,
    [jobId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    layerName: row.layer_name,
    message: row.message,
    details: row.details,
    createdAt: row.created_at,
  }));
}

export type FactoryInspectionEntry = {
  id: number;
  layerName: FactoryLayer;
  promptText: string;
  rawResponseText: string;
  provider: string;
  modelName: string;
  apiVersion: string;
  createdAt: string;
};

export async function getFactoryInspectionLogs(jobId: number): Promise<FactoryInspectionEntry[]> {
  const pool = getPool();
  const r = await pool.query<{
    id: number;
    layer_name: FactoryLayer;
    prompt_text: string;
    raw_response_text: string;
    provider: string;
    model_name: string;
    api_version: string;
    created_at: string;
  }>(
    `SELECT id, layer_name, prompt_text, raw_response_text, provider, model_name, api_version, created_at
     FROM ai_factory_inspection_logs
     WHERE job_id = $1
     ORDER BY id ASC`,
    [jobId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    layerName: row.layer_name,
    promptText: row.prompt_text,
    rawResponseText: row.raw_response_text,
    provider: row.provider,
    modelName: row.model_name,
    apiVersion: row.api_version,
    createdAt: row.created_at,
  }));
}
