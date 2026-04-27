import { getPool } from "../../db/pool";
import { getLayerConfigHealth, LayerExecutionError, runLayerModel } from "./modelManager";
import { calculateGeminiCost, insertAiUsageLog } from "./usageAnalytics";
import { extractJsonArray, normalizeFactoryQuestion } from "./utils";
import type {
  FactoryAuditReport,
  FactoryJobPayload,
  FactoryLearningSignals,
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

const PEDAGOGICAL_NORMS_ANCHOR = [
  "NORMS_ANCHOR (DO NOT REDEFINE):",
  "- The goal is Atomic Learning Units, not quiz-only assessment.",
  "- Each question must teach a concept, explain it, and correct a likely misconception.",
  "- Each question must be 100% self-contained.",
  "- questionType is independent from difficulty.",
  "- questionType allowed: conceptual | procedural | application.",
  "- difficulty allowed: easy | medium | hard.",
  "- difficulty is derived ONLY from measurable signals:",
  "  conceptIdsReferenced.length and crossConceptCount.",
  "- Difficulty mapping:",
  "  easy: conceptIdsReferenced.length<=1 and crossConceptCount=0",
  "  medium: conceptIdsReferenced.length=2 and crossConceptCount<=1",
  "  hard: conceptIdsReferenced.length>=3 or crossConceptCount>=2",
  "- question is rejected if answer is rote-only, adds no new learning, or studyBody is insufficient.",
  "- studyBody is a single integrated paragraph (no sections, no brackets).",
  "- studyBody_char_length must be between 80 and 250.",
  "- studyBody must include at least one reasoning connector: لأن | بسبب | حيث | إذ | لذلك.",
  "- studyBody must include at least one contrast pattern: وليس | بينما | على عكس | لكن.",
  "- True/False mode (2 options) is allowed but must include a misconception and explanatory resolution.",
  "- Output must be pure JSON only, no markdown.",
].join("\n");
const MAX_CORRECTION_CYCLE = 1;
const MAX_PATCHES_FACTOR = 2;
const SMART_STUDYBODY_MIN_CHARS = 80;
const SMART_STUDYBODY_MAX_CHARS = 250;
const EXECUTION_BATCH_SIZE_CAP = 30;
const ATTEMPT_BUDGET_PER_JOB = 8;
const TOKEN_BUDGET_PER_JOB = 200_000;
const COMPACT_MODE_BY_DEFAULT = true;
const ARCHITECT_SUMMARY_MAX_CHARS = 520;

class JobCancelledError extends Error {
  readonly layer: FactoryLayer | null;
  constructor(layer: FactoryLayer | null) {
    super("job_cancelled_by_admin");
    this.layer = layer;
  }
}

class CreatorGuardError extends Error {
  readonly code:
    | "creator_invalid_json"
    | "creator_not_array"
    | "creator_invalid_question"
    | "creator_missing_field"
    | "creator_wrong_subcategory"
    | "creator_invalid_schema";
  readonly questionIndex: number | null;
  readonly field: string | null;
  readonly rawSnippet: string;

  constructor(
    code: CreatorGuardError["code"],
    message: string,
    meta?: { questionIndex?: number | null; field?: string | null; rawSnippet?: string },
  ) {
    super(message);
    this.code = code;
    this.questionIndex = meta?.questionIndex ?? null;
    this.field = meta?.field ?? null;
    this.rawSnippet = String(meta?.rawSnippet ?? "");
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
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO ai_factory_job_logs (job_id, layer_name, level, message, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [jobId, layer ?? null, level, message, JSON.stringify(details ?? {})],
    );
  } catch {
    // best-effort logging only; never break job flow
  }
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
  try {
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
  } catch {
    // best-effort logging only; never break job flow
  }
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
  retryIndex?: number;
  attemptId?: string;
  costSource?: "provider_exact" | "estimated";
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
      retryIndex: input.retryIndex ?? 0,
      attemptId: input.attemptId,
      costSource: input.costSource ?? "estimated",
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

async function readGlobalQuestionTypeDistribution(subcategoryKey: string): Promise<{
  global: { conceptual: number; procedural: number; application: number };
  subcategory: { conceptual: number; procedural: number; application: number };
}> {
  const pool = getPool();
  const [globalR, subR] = await Promise.all([
    pool.query<{ question_type: string; c: string }>(
      `SELECT question_type, COUNT(*)::text AS c
       FROM questions
       WHERE question_type IN ('conceptual','procedural','application')
       GROUP BY question_type`,
    ),
    pool.query<{ question_type: string; c: string }>(
      `SELECT question_type, COUNT(*)::text AS c
       FROM questions
       WHERE subcategory_key = $1
         AND question_type IN ('conceptual','procedural','application')
       GROUP BY question_type`,
      [subcategoryKey],
    ),
  ]);
  const seed = { conceptual: 0, procedural: 0, application: 0 };
  const toMap = (rows: Array<{ question_type: string; c: string }>) => {
    const out = { ...seed };
    for (const row of rows) {
      const k = String(row.question_type || "") as keyof typeof seed;
      if (k in out) out[k] = Number(row.c || 0);
    }
    return out;
  };
  return { global: toMap(globalR.rows), subcategory: toMap(subR.rows) };
}

function chooseDifficulty(mode: "mix" | "easy" | "medium" | "hard", index: number): "easy" | "medium" | "hard" {
  if (mode === "easy" || mode === "medium" || mode === "hard") return mode;
  const order: Array<"easy" | "medium" | "hard"> = ["easy", "medium", "hard"];
  return order[index % order.length];
}

function buildArchitectPrompt(input: {
  subcategoryKey: string;
  subcategoryName: string;
  subcategoryDescription: string;
  mainCategoryName: string;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  targetCount: number;
}): string {
  return [
    "You are The Architect layer for an educational content factory.",
    "Create a concise domain-specific prompt in Arabic for generating pedagogical study quiz questions.",
    `Main category: ${input.mainCategoryName || "N/A"}`,
    `Subcategory: ${input.subcategoryName} (${input.subcategoryKey})`,
    `Internal description: ${input.subcategoryDescription || "N/A"}`,
    `Difficulty mode: ${input.difficultyMode}`,
    `Target count: ${input.targetCount}`,
    "Rules:",
    PEDAGOGICAL_NORMS_ANCHOR,
    "- Prompt must enforce JSON array output only.",
    "- Each question must contain prompt, options, correctIndex, studyBody, subcategoryKey, difficulty, questionType.",
    "- Enforce pedagogical Bloom-like progression per batch: 30% conceptual, 30% procedural, 40% application.",
    "- questionType values are strictly: conceptual | procedural | application.",
    "- DO NOT map questionType to difficulty.",
    "- difficulty must be set using measurable signals only (isAnswerExplicit, explicitFactCount, crossConceptCount).",
    "- options length must be 2 or 4 only.",
    "- correctIndex must be 0-based and inside options length.",
    "- studyBody must be a single educational paragraph (no sections/brackets).",
    `- studyBody_char_length must be between ${SMART_STUDYBODY_MIN_CHARS} and ${SMART_STUDYBODY_MAX_CHARS}.`,
    "- studyBody must include one reasoning connector: لأن | بسبب | حيث | إذ | لذلك.",
    "- studyBody must include one contrast pattern: وليس | بينما | على عكس | لكن.",
    "- Wording should support active recall and flashcard style (short Q/A friendly).",
    "- Language should be Arabic and pedagogically clear.",
    "Return only the prompt text (no markdown).",
  ].join("\n");
}

function buildCreatorPrompt(args: {
  subcategoryKey: string;
  subcategoryName: string;
  mainCategoryName: string;
  batchSize: number;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  globalTypeDistribution: {
    global: { conceptual: number; procedural: number; application: number };
    subcategory: { conceptual: number; procedural: number; application: number };
  };
}): string {
  const globalDist = args.globalTypeDistribution.global;
  const subDist = args.globalTypeDistribution.subcategory;
  return [
    "You are Generate step for AI Factory.",
    `Main category: ${args.mainCategoryName || "N/A"}`,
    `Subcategory: ${args.subcategoryName} (${args.subcategoryKey})`,
    "Now generate JSON array only. Reuse architect norms; do not restate them.",
    `Batch size: ${args.batchSize}`,
    `Subcategory key must be exactly: ${args.subcategoryKey}`,
    `Difficulty mode: ${args.difficultyMode}`,
    "Mix mode: keep easy/medium/hard balanced.",
    `questionType globalDist=${JSON.stringify(globalDist)} subcategoryDist=${JSON.stringify(subDist)} target=30/30/40.`,
    "Each item must include:",
    "- questionType: conceptual|procedural|application",
    "- conceptIdsReferenced: string[]",
    "- difficultySignals:",
    '{ "isAnswerExplicit": boolean, "explicitFactCount": number, "crossConceptCount": number }',
    "- learningSignals:",
    '{ "introducesNewConcept": boolean, "clarifiesMisconception": boolean, "requiresUnderstanding": boolean, "notPureRecall": boolean }',
    "learningSignals: at least one of introducesNewConcept/clarifiesMisconception/requiresUnderstanding=true and notPureRecall=true.",
    "If conceptIdsReferenced.length <= 1, set difficultySignals.crossConceptCount to 0 exactly.",
    "Never set crossConceptCount greater than conceptIdsReferenced.length - 1.",
    `studyBody: one paragraph, ${SMART_STUDYBODY_MIN_CHARS}-${SMART_STUDYBODY_MAX_CHARS} chars, include reasoning connector + contrast pattern.`,
    "No sections/brackets, no prompt repetition, no vague filler.",
    "options must be string[] only (2 for true/false OR 4 MCQ), no key:value text inside options.",
    "Return ONLY valid JSON array. No markdown. No surrounding text.",
  ].join("\n");
}

function compactQuestionForAudit(question: FactoryQuestion): Record<string, unknown> {
  return {
    prompt: question.prompt,
    options: question.options,
    correctIndex: question.correctIndex,
    studyBody: question.studyBody,
    subcategoryKey: question.subcategoryKey,
    difficulty: question.difficulty,
    questionType: question.questionType,
    conceptIdsReferenced: question.conceptIdsReferenced ?? [],
    difficultySignals: question.difficultySignals ?? null,
    learningSignals: question.learningSignals ?? null,
  };
}

function compactQuestionForContract(question: FactoryQuestion): Record<string, unknown> {
  return {
    prompt: compactSnippet(question.prompt, 160),
    options: question.options.map((x) => compactSnippet(x, 100)),
    correctIndex: question.correctIndex,
    studyBody: compactSnippet(question.studyBody, 220),
    difficulty: question.difficulty,
    questionType: question.questionType,
    conceptIdsReferenced: (question.conceptIdsReferenced ?? []).slice(0, 4),
    difficultySignals: question.difficultySignals ?? null,
    learningSignals: question.learningSignals ?? null,
  };
}

function compactValidationErrorsForPrompt(validationErrors: FactoryValidationError[]): Array<Record<string, unknown>> {
  return validationErrors.slice(0, 12).map((x) => ({
    code: x.code,
    index: x.index,
    field: x.field,
  }));
}

function compactAuditIssuesForPrompt(audit: FactoryAuditReport): Array<Record<string, unknown>> {
  return audit.issues.slice(0, 20).map((x) => ({
    code: x.code,
    index: x.index,
    field: x.field,
    severity: x.severity,
  }));
}

function compactAuditPatchesForPrompt(audit: FactoryAuditReport): Array<Record<string, unknown>> {
  return audit.patches.slice(0, 20).map((x) => ({
    op: x.op,
    index: x.index,
    field: x.field,
    value: x.value,
  }));
}

function buildAuditorPrompt(
  questions: FactoryQuestion[],
  validationErrors: FactoryValidationError[],
  compactMode = false,
  ultraCompactMode = false,
): string {
  const payload = ultraCompactMode
    ? questions.map(compactQuestionForContract)
    : compactMode
      ? questions.map(compactQuestionForAudit)
      : questions;
  const compactValidation = compactValidationErrorsForPrompt(validationErrors);
  return [
    "You are The Auditor layer.",
    ultraCompactMode ? "Use ultra-compact mode output." : compactMode ? "Use compact mode output." : PEDAGOGICAL_NORMS_ANCHOR,
    "ROLE CONSTRAINT: Detector-only. No long explanations. No alternative interpretations. Follow NORMS_ANCHOR only.",
    "Detect only deterministic violations and return machine patches only.",
    "Mandatory checks: schema validity, questionType/difficulty independence, learning_signals consistency.",
    "Issue codes allowed: rote_question,fake_application,no_new_learning,studyBody_out_of_range,studyBody_missing_reasoning_connector,studyBody_missing_contrast,studyBody_repeats_prompt,weak_distractors,weak_true_false_statement,true_false_without_justification,ambiguous_truth_value,learning_signals_missing,learning_signals_inconsistent.",
    `Pre-validation errors (compact): ${JSON.stringify(compactValidation)}`,
    "Return ONLY valid JSON object:",
    "{",
    '  "issues": [{ "code": string, "index": number, "field": string, "confidence": "high|medium|low", "severity": "blocking|non_blocking" }],',
    '  "patches": [{ "op": "replace", "index": number, "field": "questionType|difficulty|studyBody|prompt|options|correctIndex|conceptIdsReferenced|difficultySignals|learningSignals", "value": any }]',
    "}",
    "No markdown. No extra keys.",
    JSON.stringify(payload),
  ].join("\n");
}

function buildRefinerPrompt(
  questions: FactoryQuestion[],
  audit: FactoryAuditReport,
  validationErrors: FactoryValidationError[],
  compactMode = false,
  ultraCompactMode = false,
): string {
  const payload = ultraCompactMode
    ? questions.map(compactQuestionForContract)
    : compactMode
      ? questions.map(compactQuestionForAudit)
      : questions;
  const compactValidation = compactValidationErrorsForPrompt(validationErrors);
  const compactIssues = compactAuditIssuesForPrompt(audit);
  const compactPatches = compactAuditPatchesForPrompt(audit);
  return [
    "You are The Refiner layer.",
    ultraCompactMode ? "Use ultra-compact mode output." : compactMode ? "Use compact mode output." : PEDAGOGICAL_NORMS_ANCHOR,
    "ROLE CONSTRAINT: Execution-only.",
    "Apply patches exactly. Do not reinterpret, do not add new patches, do not rebalance distributions.",
    "If a patch would break schema, skip that patch and keep object valid.",
    "If question is rote, add explanatory context.",
    "If distractors are weak, replace with realistic same-domain misconceptions.",
    `If studyBody is weak, rewrite it as one integrated paragraph (${SMART_STUDYBODY_MIN_CHARS}-${SMART_STUDYBODY_MAX_CHARS} chars).`,
    "The rewritten studyBody must include: concept explanation + why correct answer is correct + misconception hint.",
    "Include at least one reasoning connector: لأن | بسبب | حيث | إذ | لذلك.",
    "Include at least one contrast pattern: وليس | بينما | على عكس | لكن.",
    "Do not use sections, brackets, or internal labels in studyBody.",
    "For true/false, ensure truth-condition is unambiguous and misconception is explicitly resolved.",
    "Return ONLY valid JSON array.",
    "Do not wrap in markdown fences.",
    "No commentary before or after JSON.",
    "Use standard double quotes for all JSON keys and string values.",
    `Audit issues (compact): ${JSON.stringify(compactIssues)}`,
    `Audit patches (compact): ${JSON.stringify(compactPatches)}`,
    `Validation errors (compact): ${JSON.stringify(compactValidation)}`,
    JSON.stringify(payload),
  ].join("\n");
}

function parseAuditReport(text: string): FactoryAuditReport {
  try {
    const parsed = JSON.parse(text) as { issues?: unknown; patches?: unknown };
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : [];
    return {
      issues: rawIssues
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => Boolean(x))
        .map((x) => ({
          code: String(x.code ?? "unknown_issue"),
          index: Number.isInteger(Number(x.index)) ? Number(x.index) : -1,
          field: String(x.field ?? "unknown"),
          confidence:
            String(x.confidence ?? "medium") === "high"
              ? "high"
              : String(x.confidence ?? "medium") === "low"
                ? "low"
                : "medium",
          severity: String(x.severity ?? "blocking") === "non_blocking" ? "non_blocking" : "blocking",
        })),
      patches: rawPatches
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => Boolean(x))
        .filter((x) => String(x.op ?? "") === "replace")
        .map((x) => ({
          op: "replace" as const,
          index: Number.isInteger(Number(x.index)) ? Number(x.index) : -1,
          field: String(x.field ?? "") as
            | "questionType"
            | "difficulty"
            | "studyBody"
            | "prompt"
            | "options"
            | "correctIndex"
            | "conceptIdsReferenced"
            | "difficultySignals"
            | "learningSignals",
          value: x.value,
        }))
        .filter((p) => p.index >= 0),
    };
  } catch {
    return {
      issues: [
        {
          code: "auditor_contract_invalid",
          index: -1,
          field: "root",
          confidence: "high",
          severity: "blocking",
        },
      ],
      patches: [],
    };
  }
}

function compactSnippet(input: string, max = 180): string {
  const s = String(input || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function summarizeArchitectOutput(text: string, max = ARCHITECT_SUMMARY_MAX_CHARS): string {
  return compactSnippet(text, max);
}

function classifyFinishReason(finishReason: string | null, candidateTruncated: boolean): string {
  const reason = String(finishReason || "").toUpperCase();
  if (candidateTruncated || reason === "MAX_TOKENS") return "contract_truncated_max_tokens";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "BLOCKLIST") return "provider_blocked";
  if (reason === "STOP") return "stop";
  return reason ? `finish_reason_${reason.toLowerCase()}` : "finish_reason_unknown";
}

function isDeterministicNonRetryable(errorMessage: string): boolean {
  return (
    errorMessage.includes("provider_empty_response") ||
    errorMessage.includes("provider_blocked") ||
    errorMessage.includes("auditor_contract_invalid") ||
    errorMessage.includes("creator_invalid_schema") ||
    errorMessage.includes("creator_wrong_subcategory")
  );
}

function isTransientFactoryFailure(errorMessage: string): boolean {
  return (
    errorMessage.includes("provider_rate_limit") ||
    errorMessage.includes("provider_service_unavailable") ||
    errorMessage.includes("provider_network") ||
    errorMessage.includes("ETIMEDOUT") ||
    errorMessage.includes("ECONNRESET")
  );
}

function isSingleRecoveryRetryCandidate(errorMessage: string): boolean {
  return (
    errorMessage.includes("creator_invalid_json") ||
    errorMessage.includes("provider_truncated_max_tokens") ||
    errorMessage.includes("contract_truncated_max_tokens")
  );
}

function randomJitterMs(maxMs = 1200): number {
  return Math.floor(Math.random() * Math.max(1, maxMs));
}

function computeRequeueDelayMinutes(attemptCountAfterFailure: number): number {
  const base = Math.min(30, Math.max(1, 2 ** attemptCountAfterFailure));
  return Math.min(45, base + Math.floor(randomJitterMs(90_000) / 60_000));
}

type NormalizedCreatorBatch = {
  questions: FactoryQuestion[];
  validationErrors: FactoryValidationError[];
};

function stripCreatorMarkdownWrapper(rawText: string): string {
  const text = String(rawText || "").trim();
  if (!text) return "";
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function classifyCreatorQuestionError(message: string): {
  code: "creator_invalid_question" | "creator_missing_field";
  field: string | null;
} {
  if (/_missing_/.test(message)) {
    const fieldMatch = message.match(/missing_([a-z_]+)/i);
    const field = fieldMatch?.[1] ? fieldMatch[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : null;
    return { code: "creator_missing_field", field };
  }
  return { code: "creator_invalid_question", field: null };
}

function normalizeQuestionsFromCreatorStrict(rawText: string, job: JobRow): NormalizedCreatorBatch {
  const cleaned = stripCreatorMarkdownWrapper(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new CreatorGuardError(
      "creator_invalid_json",
      `creator_invalid_json:layer=creator:snippet=${compactSnippet(rawText)}`,
      { rawSnippet: compactSnippet(rawText, 300), field: "root", questionIndex: null },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CreatorGuardError("creator_not_array", "creator_not_array:layer=creator", {
      rawSnippet: compactSnippet(rawText, 300),
      field: "root",
      questionIndex: null,
    });
  }
  const questions: FactoryQuestion[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    try {
      const q = normalizeFactoryQuestion(parsed[i], i);
      if (q.subcategoryKey !== job.subcategory_key) {
        throw new CreatorGuardError(
          "creator_wrong_subcategory",
          `creator_wrong_subcategory:question_${i + 1}:expected=${job.subcategory_key}:got=${q.subcategoryKey}`,
          {
            questionIndex: i,
            field: "subcategoryKey",
            rawSnippet: compactSnippet(JSON.stringify(parsed[i]), 300),
          },
        );
      }
      questions.push(q);
    } catch (error) {
      if (error instanceof CreatorGuardError) throw error;
      const message = error instanceof Error ? error.message : "creator_invalid_question";
      const classified = classifyCreatorQuestionError(message);
      throw new CreatorGuardError(classified.code, `${classified.code}:${message}`, {
        questionIndex: i,
        field: classified.field,
        rawSnippet: compactSnippet(JSON.stringify(parsed[i]), 300),
      });
    }
  }
  return { questions, validationErrors: [] };
}

function validateCreatorOutputGate(questions: FactoryQuestion[]): void {
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const conceptIds = Array.isArray(q.conceptIdsReferenced) ? q.conceptIdsReferenced : [];
    if (conceptIds.length === 0) {
      throw new CreatorGuardError("creator_invalid_schema", `creator_invalid_schema:question_${i + 1}:missing_conceptIdsReferenced`, {
        questionIndex: i,
        field: "conceptIdsReferenced",
      });
    }
    if (!q.difficultySignals) {
      throw new CreatorGuardError("creator_invalid_schema", `creator_invalid_schema:question_${i + 1}:missing_difficultySignals`, {
        questionIndex: i,
        field: "difficultySignals",
      });
    }
    const learning = q.learningSignals;
    if (!learning) {
      throw new CreatorGuardError("creator_invalid_schema", `creator_invalid_schema:question_${i + 1}:missing_learningSignals`, {
        questionIndex: i,
        field: "learningSignals",
      });
    }
    if (
      typeof learning.introducesNewConcept !== "boolean" ||
      typeof learning.clarifiesMisconception !== "boolean" ||
      typeof learning.requiresUnderstanding !== "boolean" ||
      typeof learning.notPureRecall !== "boolean"
    ) {
      throw new CreatorGuardError("creator_invalid_schema", `creator_invalid_schema:question_${i + 1}:invalid_learningSignals`, {
        questionIndex: i,
        field: "learningSignals",
      });
    }
    const signals = q.difficultySignals;
    if (
      !Number.isFinite(signals.explicitFactCount) ||
      !Number.isFinite(signals.crossConceptCount) ||
      signals.explicitFactCount < 0 ||
      signals.crossConceptCount < 0
    ) {
      throw new CreatorGuardError("creator_invalid_schema", `creator_invalid_schema:question_${i + 1}:invalid_difficultySignals`, {
        questionIndex: i,
        field: "difficultySignals",
      });
    }
    if (conceptIds.length <= 1 && signals.crossConceptCount !== 0) {
      throw new CreatorGuardError(
        "creator_invalid_schema",
        `creator_invalid_schema:question_${i + 1}:crossConceptCount_must_be_zero_for_single_concept`,
        {
          questionIndex: i,
          field: "difficultySignals.crossConceptCount",
        },
      );
    }
    if (signals.crossConceptCount > Math.max(0, conceptIds.length - 1)) {
      throw new CreatorGuardError(
        "creator_invalid_schema",
        `creator_invalid_schema:question_${i + 1}:crossConceptCount_not_logical`,
        {
          questionIndex: i,
          field: "difficultySignals.crossConceptCount",
        },
      );
    }
  }
}

function normalizeQuestionsFromRefinerStrict(rawText: string, job: JobRow): FactoryQuestion[] {
  const trimmed = String(rawText || "").trim();
  if (/\]\s*\]$/.test(trimmed) || /\}\s*\}$/.test(trimmed)) {
    throw new Error(`refiner_invalid_json_trailing_brackets:layer=refiner:snippet=${compactSnippet(rawText)}`);
  }
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

type DifficultySignals = {
  isAnswerExplicit: boolean;
  explicitFactCount: number;
  crossConceptCount: number;
};

function deriveDifficultyFromSignals(signals: DifficultySignals): "easy" | "medium" | "hard" {
  if (signals.explicitFactCount >= 3 || signals.crossConceptCount >= 2) return "hard";
  if (signals.explicitFactCount === 2) return "medium";
  if (signals.isAnswerExplicit || signals.explicitFactCount <= 1) return "easy";
  return "medium";
}

function readDifficultySignals(question: FactoryQuestion): DifficultySignals | null {
  const q = question as unknown as Record<string, unknown>;
  const raw = q.difficultySignals;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const isAnswerExplicit = Boolean(o.isAnswerExplicit);
  const explicitFactCount = Number(o.explicitFactCount ?? 0);
  const crossConceptCount = Number(o.crossConceptCount);
  if (!Number.isFinite(crossConceptCount)) return null;
  const safeExplicit = !Number.isFinite(explicitFactCount) ? 0 : Math.max(0, Math.floor(explicitFactCount));
  return {
    isAnswerExplicit,
    explicitFactCount: safeExplicit,
    crossConceptCount: Math.max(0, Math.floor(crossConceptCount)),
  };
}

function setFrom(arr: string[]): Set<string> {
  return new Set(arr.map((x) => String(x || "").trim()).filter(Boolean));
}

function tokenizeArabicAndLatin(input: string): string[] {
  return String(input || "")
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06FF_]+/g)
    .map((x) => x.trim())
    .filter((x) => x.length > 1);
}

function extractConceptIdsFromText(text: string, conceptIds: string[]): Set<string> {
  const lowered = String(text || "").toLowerCase();
  const out = new Set<string>();
  for (const id of conceptIds) {
    const token = String(id || "").trim().toLowerCase();
    if (!token) continue;
    if (lowered.includes(token)) out.add(token);
  }
  return out;
}

function hasLogicalConnector(text: string): boolean {
  return /(لأن|لان|بسبب|حيث|إذ|لذلك|because|therefore|thus)/i.test(String(text || ""));
}

function hasContrastPattern(text: string): boolean {
  return /(وليس|بينما|على عكس|لكن)/i.test(String(text || ""));
}

function stripWhitespace(input: string): string {
  return String(input || "").replace(/\s+/g, " ").trim();
}

function studyBodyCharLength(text: string): number {
  return stripWhitespace(text).length;
}

function isSemanticallyThin(text: string): boolean {
  return tokenizeArabicAndLatin(text).length < 8;
}

function promptOverlapRatio(prompt: string, studyBody: string): number {
  const promptTokens = tokenizeArabicAndLatin(prompt);
  const bodyTokens = tokenizeArabicAndLatin(studyBody);
  if (bodyTokens.length === 0 || promptTokens.length === 0) return 0;
  const promptSet = setFrom(promptTokens);
  let overlap = 0;
  for (const t of bodyTokens) {
    if (promptSet.has(t)) overlap += 1;
  }
  return overlap / Math.max(1, bodyTokens.length);
}

type GateIssue = { code: string; severity: "blocking" | "warning"; note: string };

function hasExplanatoryReasoning(text: string): boolean {
  const body = stripWhitespace(text);
  return /(لأن|لان|بسبب|حيث|إذ|لذلك)\s+[^.،]{10,}/i.test(body);
}

function hasMeaningfulContrast(text: string): boolean {
  const body = stripWhitespace(text);
  return /(لكن|بينما|وليس|على عكس)\s+[^.،]{8,}/i.test(body);
}

function evaluateSchemaGateIssues(question: FactoryQuestion): GateIssue[] {
  const issues: GateIssue[] = [];
  if (!Array.isArray(question.options) || !(question.options.length === 2 || question.options.length === 4)) {
    issues.push({ code: "schema_invalid_options", severity: "blocking", note: "options must be 2 or 4" });
  }
  if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= question.options.length) {
    issues.push({ code: "schema_invalid_correct_index", severity: "blocking", note: "correctIndex out of range" });
  }
  if (!Array.isArray(question.conceptIdsReferenced) || question.conceptIdsReferenced.length === 0) {
    issues.push({ code: "schema_missing_concepts", severity: "blocking", note: "conceptIdsReferenced required" });
  }
  if (!question.learningSignals) {
    issues.push({ code: "learning_signals_missing", severity: "blocking", note: "learningSignals required" });
  }
  return issues;
}

function evaluatePedagogyGateIssues(question: FactoryQuestion): GateIssue[] {
  const issues: GateIssue[] = [];
  const conceptIds = Array.isArray(question.conceptIdsReferenced) ? question.conceptIdsReferenced : [];
  const promptConcepts = extractConceptIdsFromText(question.prompt, conceptIds);
  const studyConcepts = extractConceptIdsFromText(question.studyBody, conceptIds);
  const bodyLen = studyBodyCharLength(question.studyBody);
  const hasReasoning = hasLogicalConnector(question.studyBody);
  const hasContrast = hasContrastPattern(question.studyBody);
  const explanatoryReasoning = hasExplanatoryReasoning(question.studyBody);
  const meaningfulContrast = hasMeaningfulContrast(question.studyBody);
  const repeatedPrompt = promptOverlapRatio(question.prompt, question.studyBody) > 0.72;
  const semanticallyThin = isSemanticallyThin(question.studyBody);

  if (bodyLen < SMART_STUDYBODY_MIN_CHARS || bodyLen > SMART_STUDYBODY_MAX_CHARS) {
    issues.push({ code: "studyBody_out_of_range", severity: "blocking", note: `studyBody_char_length=${bodyLen}` });
  }
  if (!hasReasoning) {
    issues.push({ code: "studyBody_missing_reasoning_connector", severity: "blocking", note: "missing reasoning connector" });
  }
  if (!hasContrast) {
    issues.push({ code: "studyBody_missing_contrast", severity: "blocking", note: "missing contrast pattern" });
  }
  if (hasReasoning && !explanatoryReasoning) {
    issues.push({ code: "pedagogy_connector_without_explanation", severity: "blocking", note: "connector exists without causal clause" });
  }
  if (hasContrast && !meaningfulContrast) {
    issues.push({ code: "pedagogy_contrast_without_signal", severity: "blocking", note: "contrast token exists without meaningful clause" });
  }
  if (repeatedPrompt) {
    issues.push({ code: "studyBody_repeats_prompt", severity: "blocking", note: "studyBody mostly repeats prompt text" });
  }
  if (semanticallyThin) {
    issues.push({ code: "studyBody_semantically_empty", severity: "blocking", note: "insufficient semantic content" });
  }

  const conceptIntroduced = [...studyConcepts].some((x) => !promptConcepts.has(x));
  const conceptClarified = [...promptConcepts].some((x) => studyConcepts.has(x)) && explanatoryReasoning;
  const misconceptionCorrected = meaningfulContrast && /(خاطئ|غير صحيح|خطأ|ليس صحيح|لا يصح|وهم|مضلل)/i.test(question.studyBody);
  const contextShift =
    JSON.stringify([...promptConcepts].sort()) !== JSON.stringify([...studyConcepts].sort());
  const conceptAppliedNewContext = studyConcepts.size > 0 && contextShift;
  const learningValueScore = Number(conceptIntroduced) + Number(conceptClarified) + Number(misconceptionCorrected) + Number(conceptAppliedNewContext);
  const roteQuestion = question.options.length >= 2 && !hasReasoning;
  const strengthOk = hasReasoning && !semanticallyThin;

  if (learningValueScore < 1 || roteQuestion || !strengthOk) {
    issues.push({ code: "no_new_learning", severity: "blocking", note: "insufficient learning value" });
  }
  if (learningValueScore === 1 && !(misconceptionCorrected || conceptClarified)) {
    issues.push({ code: "no_new_learning", severity: "blocking", note: "edge-case weak signal" });
  }
  const signals = readDifficultySignals(question);
  const learningSignals = (question.learningSignals ?? null) as FactoryLearningSignals | null;
  if (!learningSignals || !learningSignals.notPureRecall) {
    issues.push({ code: "learning_signals_inconsistent", severity: "blocking", note: "notPureRecall must be true" });
  } else {
    const expectedLearning =
      Number(conceptIntroduced) + Number(misconceptionCorrected) + Number(conceptClarified || conceptAppliedNewContext) >= 1;
    if (
      !(
        learningSignals.introducesNewConcept ||
        learningSignals.clarifiesMisconception ||
        learningSignals.requiresUnderstanding
      ) ||
      !expectedLearning
    ) {
      issues.push({ code: "learning_signals_inconsistent", severity: "blocking", note: "signals do not match measured pedagogy" });
    }
  }
  if ((signals?.isAnswerExplicit ?? false) && !(misconceptionCorrected || conceptClarified)) {
    issues.push({ code: "rote_question", severity: "blocking", note: "explicit answer without educational correction" });
  }

  // distractor checks
  const correct = question.options[question.correctIndex] || "";
  const correctConcepts = extractConceptIdsFromText(correct, conceptIds);
  for (let i = 0; i < question.options.length; i += 1) {
    if (i === question.correctIndex) continue;
    const d = question.options[i];
    const dConcepts = extractConceptIdsFromText(d, conceptIds);
    const shared = [...dConcepts].filter((x) => correctConcepts.has(x)).length;
    const notTriviallyEliminable = tokenizeArabicAndLatin(d).length >= 2;
    if (shared < 1 || !notTriviallyEliminable) {
      issues.push({ code: "weak_distractors", severity: "warning", note: `weak distractor at option ${i}` });
    }
  }

  // true/false checks
  if (question.options.length === 2) {
    const normalized = question.options.map((x) => x.trim().toLowerCase());
    const hasTfPair =
      (normalized.includes("صح") && normalized.includes("خطأ")) ||
      (normalized.includes("true") && normalized.includes("false"));
    if (!hasTfPair) {
      issues.push({ code: "ambiguous_truth_value", severity: "blocking", note: "2-options question not true/false pair" });
    }
    if (!hasContrast) {
      issues.push({ code: "true_false_without_justification", severity: "blocking", note: "missing misconception resolution" });
    }
  }

  return issues;
}

function applyAuditorPatchesToQuestions(questions: FactoryQuestion[], audit: FactoryAuditReport): FactoryQuestion[] {
  const out = questions.map((q) => ({ ...q })) as Array<FactoryQuestion & Record<string, unknown>>;
  for (const patch of audit.patches) {
    if (patch.op !== "replace") continue;
    if (patch.index < 0 || patch.index >= out.length) continue;
    const target = out[patch.index] as Record<string, unknown>;
    target[String(patch.field)] = patch.value;
  }
  return out;
}

function ensureQuestionTypeCoverage(questions: FactoryQuestion[], minPct = 0.2): void {
  const total = questions.length;
  if (total === 0) throw new Error("output_gate_empty_batch");
  if (total < 5) return;
  const counts = {
    conceptual: questions.filter((q) => q.questionType === "conceptual").length,
    procedural: questions.filter((q) => q.questionType === "procedural").length,
    application: questions.filter((q) => q.questionType === "application").length,
  };
  const minCount = Math.ceil(total * minPct);
  if (counts.conceptual < minCount || counts.procedural < minCount || counts.application < minCount) {
    throw new Error(
      `output_gate_question_type_coverage_failed:min=${minCount}:got=${JSON.stringify(counts)}`,
    );
  }
}

function runSchemaGateChecks(questions: FactoryQuestion[]): void {
  for (let i = 0; i < questions.length; i += 1) {
    const issues = evaluateSchemaGateIssues(questions[i]).filter((x) => x.severity === "blocking");
    if (issues.length) {
      throw new Error(`schema_gate_blocking_issue_at_${i + 1}:${issues.map((x) => x.code).join("|")}`);
    }
  }
}

function runPedagogyGateChecks(questions: FactoryQuestion[]): void {
  const warnings: GateIssue[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const issues = evaluatePedagogyGateIssues(q);
    const blocking = issues.filter((x) => x.severity === "blocking");
    if (blocking.length) {
      throw new Error(`output_gate_blocking_issue_at_${i + 1}:${blocking.map((x) => x.code).join("|")}`);
    }
    warnings.push(...issues.filter((x) => x.severity === "warning"));
    const signals = readDifficultySignals(q);
    if (signals) {
      const conceptCount = Array.isArray(q.conceptIdsReferenced) ? q.conceptIdsReferenced.length : 0;
      let expected: "easy" | "medium" | "hard" = "medium";
      if (conceptCount <= 1 && signals.crossConceptCount === 0) expected = "easy";
      else if (conceptCount === 2 && signals.crossConceptCount <= 1) expected = "medium";
      else if (conceptCount >= 3 || signals.crossConceptCount >= 2) expected = "hard";
      if (q.difficulty !== expected) {
        throw new Error(`pedagogy_gate_difficulty_mismatch_at_${i + 1}:expected_${expected}:got_${q.difficulty}`);
      }
    }
  }
  ensureQuestionTypeCoverage(questions, 0.2);
  if (warnings.length > 0) {
    console.warn("[output_gate] warnings", warnings.slice(0, 10));
  }
}

function runGateLiteChecks(questions: FactoryQuestion[]): void {
  runSchemaGateChecks(questions);
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const len = studyBodyCharLength(q.studyBody);
    if (len < SMART_STUDYBODY_MIN_CHARS || len > SMART_STUDYBODY_MAX_CHARS) {
      throw new Error(`gate_lite_studyBody_out_of_range_at_${i + 1}`);
    }
    if (!hasLogicalConnector(q.studyBody)) {
      throw new Error(`gate_lite_missing_reasoning_connector_at_${i + 1}`);
    }
    if (!hasContrastPattern(q.studyBody)) {
      throw new Error(`gate_lite_missing_contrast_pattern_at_${i + 1}`);
    }
    const s = q.learningSignals;
    if (!s || !s.notPureRecall || !(s.introducesNewConcept || s.clarifiesMisconception || s.requiresUnderstanding)) {
      throw new Error(`gate_lite_learning_signals_invalid_at_${i + 1}`);
    }
  }
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

export async function runFactoryJob(job: JobRow): Promise<void> {
  const effectiveBatchSize = Math.min(Math.max(1, job.batch_size), EXECUTION_BATCH_SIZE_CAP);
  await appendJobLog(job.id, "info", `Job started at ${nowIso()}`);
  await setJobState(job.id, {
    status: "running",
    started: true,
    currentLayer: "creator",
    incrementAttempt: true,
    lastError: null,
  });
  await refreshPipelineState(job.subcategory_key, {
    lastJobId: job.id,
    lastStatus: "running",
    lastLayer: "creator",
  });

  let failedLayer: FactoryLayer | null = "creator";
  let jobSubject = "غير محدد";
  let attemptBudgetUsed = 0;
  let tokenBudgetUsed = 0;
  try {
    await assertNotCancelled(job.id, failedLayer);
    const creatorHealth = await getLayerConfigHealth("creator");
    if (creatorHealth.status === "fail") {
      throw new Error(`creator_preflight_failed:${creatorHealth.reasons.join("|")}`);
    }
    const context = await readSubcategoryContext(job.subcategory_key);
    jobSubject = context.mainCategoryName || context.subcategoryName || job.subcategory_key;
    const creatorPrompt = buildCreatorPrompt({
      subcategoryKey: job.subcategory_key,
      subcategoryName: context.subcategoryName,
      mainCategoryName: context.mainCategoryName,
      batchSize: effectiveBatchSize,
      difficultyMode: job.difficulty_mode,
      globalTypeDistribution: await readGlobalQuestionTypeDistribution(job.subcategory_key),
    });
    await appendJobLog(job.id, "info", "Generate step started", "creator");
    let creatorAttempt = 0;
    let creatorNormalized: NormalizedCreatorBatch | null = null;
    let creatorModelName = "";
    let creatorFinishReason: string | null = null;
    let creatorCandidateTruncated = false;
    while (creatorAttempt < 2) {
      creatorAttempt += 1;
      if (attemptBudgetUsed >= ATTEMPT_BUDGET_PER_JOB || tokenBudgetUsed >= TOKEN_BUDGET_PER_JOB) {
        throw new Error("job_budget_exhausted_before_creator");
      }
      const creator = await runLayerModel("creator", creatorPrompt);
      attemptBudgetUsed += 1;
      tokenBudgetUsed += creator.usageMetadata.totalTokens;
      creatorModelName = creator.modelName;
      creatorFinishReason = creator.finishReason;
      creatorCandidateTruncated = creator.candidateTruncated;
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
        retryIndex: creatorAttempt - 1,
        attemptId: `${job.id}-creator-${creatorAttempt}`,
        costSource: "provider_exact",
      });
      try {
        creatorNormalized = normalizeQuestionsFromCreatorStrict(creator.text, job);
        break;
      } catch (error) {
        if (!(error instanceof CreatorGuardError)) throw error;
        const canRetry = error.code === "creator_invalid_json" && creatorAttempt < 2;
        await appendJobLog(job.id, canRetry ? "warn" : "error", "Creator guard failed", "creator", {
          errorCode: error.code,
          error: error.message,
          questionIndex: error.questionIndex,
          field: error.field,
          rawSnippet: error.rawSnippet,
          creatorAttempt,
          willRetry: canRetry,
        });
        if (canRetry) continue;
        throw error;
      }
    }
    if (!creatorNormalized) {
      throw new Error("creator_guard_no_output");
    }
    const creatorQuestions = creatorNormalized.questions;
    validateCreatorOutputGate(creatorQuestions);
    await appendJobLog(job.id, "info", "Generate step completed", "creator", {
      generated: creatorQuestions.length,
      creatorAttempts: creatorAttempt,
      model: creatorModelName,
      finishReason: creatorFinishReason,
      candidateTruncated: creatorCandidateTruncated,
    });

    let finalQuestions = creatorQuestions.slice(0, effectiveBatchSize);
    if (!finalQuestions.length) {
      throw new Error("generator_returned_empty_batch");
    }
    runGateLiteChecks(finalQuestions);
    await saveJobFinalOutput(job.id, finalQuestions);
    await assertNotCancelled(job.id, failedLayer);
    const inserted = await insertQuestionsAllOrNothing(finalQuestions);

    await setJobState(job.id, {
      status: "succeeded",
      finished: true,
      currentLayer: null,
      resultSummary: {
        inserted,
        mode: "generate_gate_lite",
        generated: finalQuestions.length,
        attemptBudgetUsed,
        tokenBudgetUsed,
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
    await appendJobLog(job.id, "info", "Gate step committed batch successfully", "creator", {
      inserted,
      gateMode: "lite",
      finalCount: finalQuestions.length,
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
    const failureCode = errMessage.split(":")[0] || "unknown_error";
    const layerMeta = error instanceof LayerExecutionError ? error.meta : null;
    const creatorMeta =
      error instanceof CreatorGuardError
        ? {
            errorCode: error.code,
            questionIndex: error.questionIndex,
            field: error.field,
            rawSnippet: error.rawSnippet,
          }
        : null;
    if (failedLayer && layerMeta?.modelName) {
      await appendAiUsageLogSafe({
        jobId: job.id,
        subject: jobSubject,
        layer: failedLayer,
        modelId: layerMeta.modelName,
        status: "failed",
        usage: null,
        retryIndex: Math.max(0, job.attempt_count),
        attemptId: `${job.id}-${failedLayer}-failed`,
        costSource: "estimated",
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
      creatorErrorCode: creatorMeta?.errorCode ?? null,
      creatorQuestionIndex: creatorMeta?.questionIndex ?? null,
      creatorField: creatorMeta?.field ?? null,
      creatorRawSnippet: creatorMeta?.rawSnippet ?? null,
      failureCode,
    });
    const nextAttempt = job.attempt_count + 1;
    const canRetryTransient = nextAttempt < job.max_attempts && isTransientFactoryFailure(errMessage);
    const canRetrySingleRecovery =
      nextAttempt < Math.min(job.max_attempts, 2) && isSingleRecoveryRetryCandidate(errMessage);
    if (!isDeterministicNonRetryable(errMessage) && (canRetryTransient || canRetrySingleRecovery)) {
      const backoffMinutes = computeRequeueDelayMinutes(job.attempt_count + 1);
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
      await refreshPipelineState(job.subcategory_key, {
        lastJobId: job.id,
        lastStatus: "failed",
        lastLayer: failedLayer,
        lastError: errMessage,
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
