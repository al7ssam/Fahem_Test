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
  "- studyBody must include exactly these sections in Arabic:",
  "  [principle] + [why_correct] + [why_others_wrong] + [memory_tip].",
  "- True/False mode (2 options) is allowed but must include a misconception and explanatory resolution.",
  "- Output must be pure JSON only, no markdown.",
].join("\n");
const MAX_CORRECTION_CYCLE = 1;

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
    "- studyBody must be a micro-lesson in this exact structure:",
    "  [scientific principle/rule] + [why this answer is correct] + [quick memory tip].",
    "- Wording should support active recall and flashcard style (short Q/A friendly).",
    "- Language should be Arabic and pedagogically clear.",
    "Return only the prompt text (no markdown).",
  ].join("\n");
}

function buildCreatorPrompt(args: {
  architectPrompt: string;
  subcategoryKey: string;
  batchSize: number;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  alreadyGenerated: number;
  globalTypeDistribution: {
    global: { conceptual: number; procedural: number; application: number };
    subcategory: { conceptual: number; procedural: number; application: number };
  };
}): string {
  return [
    args.architectPrompt,
    "",
    PEDAGOGICAL_NORMS_ANCHOR,
    "Now generate a JSON array of questions.",
    `Batch size: ${args.batchSize}`,
    `Subcategory key must be exactly: ${args.subcategoryKey}`,
    `Difficulty mode: ${args.difficultyMode}`,
    "If difficulty mode is mix, distribute easy/medium/hard fairly.",
    `Current global questionType distribution: ${JSON.stringify(args.globalTypeDistribution.global)}`,
    `Current subcategory questionType distribution: ${JSON.stringify(args.globalTypeDistribution.subcategory)}`,
    "If any questionType is below healthy floor in recent distribution, compensate in this batch without violating correctness.",
    "Enforce pedagogical question type distribution per batch as close as possible:",
    "- 30% conceptual",
    "- 30% procedural",
    "- 40% application",
    "Every question must include questionType with one of: conceptual, procedural, application.",
    "Every question must include conceptIdsReferenced (string[]), and crossConceptCount number.",
    "DO NOT infer difficulty from questionType.",
    "Each question must satisfy at least one learning-value condition (to be verified by OutputGate):",
    "- concept_introduced OR concept_clarified OR misconception_corrected OR concept_applied_new_context.",
    "studyBody must include mandatory 4-part structure:",
    "1) [principle]",
    "2) [why_correct]",
    "3) [why_others_wrong]",
    "4) [memory_tip]",
    "Self-contained rules:",
    "- studyBody must include a definition/rule covering target concept.",
    "- studyBody must include explanation mapped directly to the correct option.",
    "Distractors rules:",
    "- Wrong options must represent common mistakes, not random noise.",
    "- For each distractor: sharedConceptWithCorrect >= 1 and sameSubcategoryKey = true.",
    "- Each distractor must not be trivially eliminable.",
    "Application rule:",
    "- Reject fake application where answer is directly explicit in prompt.",
    "True/False rule:",
    "- 2 options are allowed only if statement requires explanation and includes a likely misconception.",
    "Write prompts and studyBody in an active-recall/flashcard-friendly style.",
    `Already generated in current run: ${args.alreadyGenerated}`,
    "Return ONLY valid JSON array.",
    "Do not wrap in markdown fences.",
    "No commentary before or after JSON.",
    "Use standard double quotes for all JSON keys and string values.",
  ].join("\n");
}

function buildAuditorPrompt(questions: FactoryQuestion[], validationErrors: FactoryValidationError[]): string {
  return [
    "You are The Auditor layer.",
    PEDAGOGICAL_NORMS_ANCHOR,
    "ROLE CONSTRAINT: Detector-only. No long explanations. No alternative interpretations.",
    "Detect violations and output machine-executable patches only.",
    "Check schema validity and value constraints.",
    "Check questionType/difficulty independence.",
    "Use confidence and severity for each issue.",
    "Mandatory issue codes to detect:",
    "- rote_question (blocking)",
    "- fake_application (blocking)",
    "- no_new_learning (blocking)",
    "- studyBody_missing_explanation (blocking)",
    "- weak_distractors (non_blocking)",
    "- weak_true_false_statement (blocking)",
    "- true_false_without_justification (blocking)",
    "- ambiguous_truth_value (blocking)",
    `Pre-validation errors from server: ${JSON.stringify(validationErrors)}`,
    "Return ONLY valid JSON object with fields:",
    "{",
    '  "summary": string,',
    '  "issues": [{ "code": string, "index": number, "field": string, "evidence": string, "confidence": "high|medium|low", "severity": "blocking|non_blocking" }],',
    '  "patches": [{ "op": "replace", "index": number, "field": "questionType|difficulty|studyBody|prompt|options|correctIndex|conceptIdsReferenced|difficultySignals", "value": any }]',
    "}",
    "No markdown. No extra keys.",
    JSON.stringify(questions),
  ].join("\n");
}

function buildRefinerPrompt(
  questions: FactoryQuestion[],
  audit: FactoryAuditReport,
  validationErrors: FactoryValidationError[],
): string {
  return [
    "You are The Refiner layer.",
    PEDAGOGICAL_NORMS_ANCHOR,
    "ROLE CONSTRAINT: Execution-only.",
    "Apply patches exactly. Do not reinterpret, do not add new patches, do not rebalance distributions.",
    "If a patch would break schema, skip that patch and keep object valid.",
    "If question is rote, add explanatory context.",
    "If distractors are weak, replace with realistic same-domain misconceptions.",
    "If studyBody is missing required parts, complete the 4-part structure.",
    "For true/false, ensure truth-condition is unambiguous and misconception is explicitly resolved.",
    "Return ONLY valid JSON array.",
    "Do not wrap in markdown fences.",
    "No commentary before or after JSON.",
    "Use standard double quotes for all JSON keys and string values.",
    `Audit summary: ${audit.summary}`,
    `Audit issues: ${JSON.stringify(audit.issues)}`,
    `Audit patches: ${JSON.stringify(audit.patches)}`,
    `Validation errors from server: ${JSON.stringify(validationErrors)}`,
    JSON.stringify(questions),
  ].join("\n");
}

function parseAuditReport(text: string): FactoryAuditReport {
  try {
    const parsed = JSON.parse(text) as { summary?: unknown; issues?: unknown; patches?: unknown };
    const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
    const rawPatches = Array.isArray(parsed.patches) ? parsed.patches : [];
    return {
      summary: String(parsed.summary ?? "").trim() || "Audit completed.",
      issues: rawIssues
        .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => Boolean(x))
        .map((x) => ({
          code: String(x.code ?? "unknown_issue"),
          index: Number.isInteger(Number(x.index)) ? Number(x.index) : -1,
          field: String(x.field ?? "unknown"),
          evidence: String(x.evidence ?? ""),
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
            | "difficultySignals",
          value: x.value,
        }))
        .filter((p) => p.index >= 0),
    };
  } catch {
    return {
      summary: "Audit returned non-JSON output.",
      issues: [
        {
          code: "auditor_contract_invalid",
          index: -1,
          field: "root",
          evidence: "non_json_audit_output",
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
  return /(because|therefore|thus|نتيجة|لذلك|بسبب|يؤدي إلى|لان|لأن)/i.test(String(text || ""));
}

function splitStudyBodySections(text: string): {
  principle: string;
  whyCorrect: string;
  whyOthersWrong: string;
  memoryTip: string;
} | null {
  const raw = String(text || "");
  const principleM = raw.match(/\[principle\]([\s\S]*?)(?=\[why_correct\]|$)/i);
  const whyCorrectM = raw.match(/\[why_correct\]([\s\S]*?)(?=\[why_others_wrong\]|$)/i);
  const whyOthersM = raw.match(/\[why_others_wrong\]([\s\S]*?)(?=\[memory_tip\]|$)/i);
  const memoryM = raw.match(/\[memory_tip\]([\s\S]*?)$/i);
  if (!principleM || !whyCorrectM || !whyOthersM || !memoryM) return null;
  return {
    principle: principleM[1].trim(),
    whyCorrect: whyCorrectM[1].trim(),
    whyOthersWrong: whyOthersM[1].trim(),
    memoryTip: memoryM[1].trim(),
  };
}

type GateIssue = { code: string; severity: "blocking" | "warning"; note: string };

function evaluateQuestionGateIssues(question: FactoryQuestion): GateIssue[] {
  const issues: GateIssue[] = [];
  const conceptIds = Array.isArray(question.conceptIdsReferenced) ? question.conceptIdsReferenced : [];
  const promptConcepts = extractConceptIdsFromText(question.prompt, conceptIds);
  const studyConcepts = extractConceptIdsFromText(question.studyBody, conceptIds);
  const sections = splitStudyBodySections(question.studyBody);
  if (!sections) {
    issues.push({ code: "studyBody_missing_explanation", severity: "blocking", note: "missing required sections" });
    return issues;
  }

  const conceptIntroduced = [...studyConcepts].some((x) => !promptConcepts.has(x));
  const conceptClarified =
    [...promptConcepts].some((x) => studyConcepts.has(x)) &&
    /(يعني|هو|تعريف|قاعدة|المقصود)/i.test(sections.principle);
  const misconceptionCorrected =
    sections.whyOthersWrong.length > 10 &&
    /(خاطئ|غير صحيح|خطأ|ليس صحيح|لا يصح)/i.test(sections.whyOthersWrong);
  const contextShift =
    JSON.stringify([...promptConcepts].sort()) !== JSON.stringify([...studyConcepts].sort());
  const conceptAppliedNewContext = studyConcepts.size > 0 && contextShift;
  const learningValueScore = Number(conceptIntroduced) + Number(conceptClarified) + Number(misconceptionCorrected) + Number(conceptAppliedNewContext);
  const roteQuestion = question.options.length >= 2 && sections.whyCorrect.length < 20;
  const strengthOk = hasLogicalConnector(sections.whyCorrect);

  if (learningValueScore < 1 || roteQuestion || !strengthOk) {
    issues.push({ code: "no_new_learning", severity: "blocking", note: "insufficient learning value" });
  }
  if (learningValueScore === 1 && !(misconceptionCorrected || conceptClarified)) {
    issues.push({ code: "no_new_learning", severity: "blocking", note: "edge-case weak signal" });
  }
  const signals = readDifficultySignals(question);
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
    if (!misconceptionCorrected) {
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

function runOutputGateChecks(questions: FactoryQuestion[]): void {
  const warnings: GateIssue[] = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const issues = evaluateQuestionGateIssues(q);
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
        throw new Error(`output_gate_difficulty_mismatch_at_${i + 1}:expected_${expected}:got_${q.difficulty}`);
      }
    }
  }
  ensureQuestionTypeCoverage(questions, 0.2);
  if (warnings.length > 0) {
    console.warn("[output_gate] warnings", warnings.slice(0, 10));
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

  let failedLayer: FactoryLayer | null = "architect";
  let jobSubject = "غير محدد";
  let correctionCycle = 0;
  try {
    await assertNotCancelled(job.id, failedLayer);
    const architectHealth = await getLayerConfigHealth("architect");
    if (architectHealth.status === "fail") {
      throw new Error(`architect_preflight_failed:${architectHealth.reasons.join("|")}`);
    }
    const context = await readSubcategoryContext(job.subcategory_key);
    jobSubject = context.mainCategoryName || context.subcategoryName || job.subcategory_key;

    const architectPrompt = buildArchitectPrompt({
      subcategoryKey: job.subcategory_key,
      subcategoryName: context.subcategoryName,
      subcategoryDescription: context.subcategoryDescription,
      mainCategoryName: context.mainCategoryName,
      difficultyMode: job.difficulty_mode,
      targetCount: job.target_count,
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
      globalTypeDistribution: await readGlobalQuestionTypeDistribution(job.subcategory_key),
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
    const auditorPrompt = buildAuditorPrompt(creatorQuestions, creatorNormalized.validationErrors);
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
    const blockingHighIssues = auditReport.issues.filter(
      (x) => x.severity === "blocking" && x.confidence === "high",
    ).length;
    const blockingMediumIssues = auditReport.issues.filter(
      (x) => x.severity === "blocking" && x.confidence === "medium",
    ).length;
    await appendJobLog(job.id, "info", "Auditor layer completed", "auditor", {
      summary: auditReport.summary,
      issuesCount: auditReport.issues.length,
      patchesCount: auditReport.patches.length,
      blockingHighIssues,
      blockingMediumIssues,
      issues: auditReport.issues,
      model: auditor.modelName,
    });

    failedLayer = "refiner";
    await assertNotCancelled(job.id, failedLayer);
    await setJobState(job.id, { currentLayer: "refiner" });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "refiner",
    });
    correctionCycle += 1;
    if (correctionCycle > MAX_CORRECTION_CYCLE) {
      throw new Error("max_correction_cycle_exceeded");
    }
    const patchPreparedQuestions = applyAuditorPatchesToQuestions(creatorQuestions, auditReport);
    const refinerPrompt = buildRefinerPrompt(patchPreparedQuestions, auditReport, creatorNormalized.validationErrors);
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
    let finalQuestions = normalizeQuestionsFromRefinerStrict(refiner.text, job);
    if (finalQuestions.length > job.batch_size) {
      finalQuestions = finalQuestions.slice(0, job.batch_size);
    }
    if (finalQuestions.length === 0) {
      throw new Error("refiner_returned_empty_batch");
    }
    runOutputGateChecks(finalQuestions);
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
    await appendJobLog(job.id, "info", "Refiner layer committed batch successfully", "refiner", {
      inserted,
      model: refiner.modelName,
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
