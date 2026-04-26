import { getPool } from "../../db/pool";
import { runLayerModel } from "./modelManager";
import { extractJsonArray, normalizeFactoryQuestion } from "./utils";
import type { FactoryAuditReport, FactoryJobPayload, FactoryLayer, FactoryQuestion } from "./types";

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
    "Create a concise domain-specific prompt in Arabic for generating high-quality study quiz questions.",
    `Main category: ${input.mainCategoryName || "N/A"}`,
    `Subcategory: ${input.subcategoryName} (${input.subcategoryKey})`,
    `Internal description: ${input.subcategoryDescription || "N/A"}`,
    `Difficulty mode: ${input.difficultyMode}`,
    `Target count: ${input.targetCount}`,
    "Rules:",
    "- Prompt must enforce JSON array output only.",
    "- Each question must contain prompt, options, correctIndex, studyBody, subcategoryKey, difficulty.",
    "- options length must be 2 or 4 only.",
    "- correctIndex must be 0-based and inside options length.",
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
}): string {
  return [
    args.architectPrompt,
    "",
    "Now generate a JSON array of questions.",
    `Batch size: ${args.batchSize}`,
    `Subcategory key must be exactly: ${args.subcategoryKey}`,
    `Difficulty mode: ${args.difficultyMode}`,
    "If difficulty mode is mix, distribute easy/medium/hard fairly.",
    `Already generated in current run: ${args.alreadyGenerated}`,
    "Return JSON array only.",
  ].join("\n");
}

function buildAuditorPrompt(questions: FactoryQuestion[]): string {
  return [
    "You are The Auditor layer.",
    "Audit the following JSON questions for correctness, quality, and difficulty fit.",
    "Return JSON object with fields: summary (string), issues (array of strings), requiresRefine (boolean).",
    "If there are no issues, issues should be empty and requiresRefine false.",
    JSON.stringify(questions),
  ].join("\n");
}

function buildRefinerPrompt(questions: FactoryQuestion[], audit: FactoryAuditReport): string {
  return [
    "You are The Refiner layer.",
    "Fix the question array based on the audit report and return corrected JSON array only.",
    "Preserve schema fields exactly.",
    "Constraints: options length 2 or 4, correctIndex in-range, non-empty studyBody, valid difficulty.",
    `Audit summary: ${audit.summary}`,
    `Audit issues: ${JSON.stringify(audit.issues)}`,
    JSON.stringify(questions),
  ].join("\n");
}

function parseAuditReport(text: string): FactoryAuditReport {
  try {
    const parsed = JSON.parse(text) as { summary?: unknown; issues?: unknown };
    return {
      summary: String(parsed.summary ?? "").trim() || "Audit completed.",
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((x) => String(x)) : [],
    };
  } catch {
    return { summary: "Audit returned non-JSON output.", issues: ["non_json_audit_output"] };
  }
}

function normalizeQuestionsFromModel(rawText: string, job: JobRow): FactoryQuestion[] {
  const arr = extractJsonArray(rawText);
  if (!arr) throw new Error("invalid_json_output");
  return arr.map((item, idx) => {
    const q = normalizeFactoryQuestion(item, idx);
    if (q.subcategoryKey !== job.subcategory_key) {
      q.subcategoryKey = job.subcategory_key;
    }
    if (job.difficulty_mode !== "mix") {
      q.difficulty = job.difficulty_mode;
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
        `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6)`,
        [
          q.prompt,
          JSON.stringify(q.options),
          q.correctIndex,
          q.difficulty,
          q.studyBody,
          q.subcategoryKey,
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

  try {
    const context = await readSubcategoryContext(job.subcategory_key);

    const architectPrompt = buildArchitectPrompt({
      subcategoryKey: job.subcategory_key,
      subcategoryName: context.subcategoryName,
      subcategoryDescription: context.subcategoryDescription,
      mainCategoryName: context.mainCategoryName,
      difficultyMode: job.difficulty_mode,
      targetCount: job.target_count,
    });
    const architect = await runLayerModel("architect", architectPrompt);
    await appendJobLog(job.id, "info", "Architect layer completed", "architect", {
      model: architect.modelName,
    });

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
    });
    const creator = await runLayerModel("creator", creatorPrompt);
    const creatorQuestions = normalizeQuestionsFromModel(creator.text, job);
    await appendJobLog(job.id, "info", "Creator layer completed", "creator", {
      generated: creatorQuestions.length,
      model: creator.modelName,
    });

    await setJobState(job.id, { currentLayer: "auditor" });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "auditor",
    });
    const auditorPrompt = buildAuditorPrompt(creatorQuestions);
    const auditor = await runLayerModel("auditor", auditorPrompt);
    const auditReport = parseAuditReport(auditor.text);
    await appendJobLog(job.id, "info", "Auditor layer completed", "auditor", {
      summary: auditReport.summary,
      issuesCount: auditReport.issues.length,
      issues: auditReport.issues,
      model: auditor.modelName,
    });

    await setJobState(job.id, { currentLayer: "refiner" });
    await refreshPipelineState(job.subcategory_key, {
      lastJobId: job.id,
      lastStatus: "running",
      lastLayer: "refiner",
    });
    const refinerPrompt = buildRefinerPrompt(creatorQuestions, auditReport);
    const refiner = await runLayerModel("refiner", refinerPrompt);
    let finalQuestions = normalizeQuestionsFromModel(refiner.text, job);
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
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "unknown_error";
    await appendJobLog(job.id, "error", "Job failed", undefined, {
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
