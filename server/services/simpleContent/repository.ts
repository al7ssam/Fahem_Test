import { getPool } from "../../db/pool";
import type { SimpleContentAutomation, SimpleContentPreset } from "./types";

export const APP_KEY_SIMPLE_CONTENT_DRAFT_SYSTEM = "simple_content_draft_system_template";
export const APP_KEY_SIMPLE_CONTENT_DRAFT_USER = "simple_content_draft_user_template";
export const APP_KEY_SIMPLE_CONTENT_DEFAULT_DRAFT_PRESET_ID = "simple_content_default_draft_preset_id";
export const APP_KEY_SIMPLE_CONTENT_DEFAULT_GENERATE_PRESET_ID = "simple_content_default_generate_preset_id";

function mapPreset(row: {
  id: number;
  provider: string;
  model_id: string;
  label_ar: string;
  max_output_tokens: number;
  temperature: number;
  api_key_env: string;
  is_active: boolean;
  sort_order: number;
}): SimpleContentPreset {
  return {
    id: row.id,
    provider: row.provider === "openai" ? "openai" : "gemini",
    modelId: row.model_id,
    labelAr: row.label_ar,
    maxOutputTokens: Number(row.max_output_tokens),
    temperature: Number(row.temperature),
    apiKeyEnv: row.api_key_env,
    isActive: row.is_active,
    sortOrder: Number(row.sort_order),
  };
}

export async function listActivePresets(): Promise<SimpleContentPreset[]> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, is_active, sort_order
     FROM simple_content_model_presets
     WHERE is_active = TRUE
     ORDER BY sort_order ASC, id ASC`,
  );
  return r.rows.map((row) => mapPreset(row as Parameters<typeof mapPreset>[0]));
}

export async function getPresetById(id: number): Promise<SimpleContentPreset | null> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, provider, model_id, label_ar, max_output_tokens, temperature, api_key_env, is_active, sort_order
     FROM simple_content_model_presets WHERE id = $1 LIMIT 1`,
    [id],
  );
  const row = r.rows[0] as Parameters<typeof mapPreset>[0] | undefined;
  return row ? mapPreset(row) : null;
}

export async function getPromptBody(subcategoryKey: string): Promise<string> {
  const pool = getPool();
  const r = await pool.query<{ prompt_body: string }>(
    `SELECT prompt_body FROM simple_content_prompts WHERE subcategory_key = $1 LIMIT 1`,
    [subcategoryKey],
  );
  return String(r.rows[0]?.prompt_body ?? "");
}

export async function upsertPromptBody(subcategoryKey: string, promptBody: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO simple_content_prompts (subcategory_key, prompt_body, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (subcategory_key) DO UPDATE SET
       prompt_body = EXCLUDED.prompt_body,
       updated_at = NOW()`,
    [subcategoryKey, promptBody],
  );
}

export async function getAutomation(subcategoryKey: string): Promise<SimpleContentAutomation | null> {
  const pool = getPool();
  const r = await pool.query<{
    subcategory_key: string;
    enabled: boolean;
    interval_minutes: number;
    model_preset_id: number | null;
    last_run_at: Date | null;
    next_run_at: Date | null;
  }>(
    `SELECT subcategory_key, enabled, interval_minutes, model_preset_id, last_run_at, next_run_at
     FROM simple_content_automation WHERE subcategory_key = $1 LIMIT 1`,
    [subcategoryKey],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    subcategoryKey: row.subcategory_key,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    modelPresetId: row.model_preset_id,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  };
}

export async function upsertAutomation(input: {
  subcategoryKey: string;
  enabled: boolean;
  intervalMinutes: number;
  modelPresetId: number | null;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO simple_content_automation (
       subcategory_key, enabled, interval_minutes, model_preset_id, last_run_at, next_run_at, updated_at
     )
     VALUES ($1, $2, $3, $4, NULL, NULL, NOW())
     ON CONFLICT (subcategory_key) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       interval_minutes = EXCLUDED.interval_minutes,
       model_preset_id = EXCLUDED.model_preset_id,
       updated_at = NOW()`,
    [input.subcategoryKey, input.enabled, input.intervalMinutes, input.modelPresetId],
  );
  if (input.enabled) {
    await pool.query(
      `UPDATE simple_content_automation
       SET next_run_at = COALESCE(next_run_at, NOW())
       WHERE subcategory_key = $1`,
      [input.subcategoryKey],
    );
  } else {
    await pool.query(
      `UPDATE simple_content_automation SET next_run_at = NULL WHERE subcategory_key = $1`,
      [input.subcategoryKey],
    );
  }
}

export async function createRun(input: {
  subcategoryKey: string;
  triggerKind: "manual" | "scheduled";
  preset: SimpleContentPreset | null;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO simple_content_runs (
       subcategory_key, trigger_kind, status, provider, model_id, preset_id, inserted_count, created_at
     )
     VALUES ($1, $2, 'running', $3, $4, $5, 0, NOW())
     RETURNING id::text`,
    [
      input.subcategoryKey,
      input.triggerKind,
      input.preset?.provider ?? null,
      input.preset?.modelId ?? null,
      input.preset?.id ?? null,
    ],
  );
  return Number(r.rows[0]?.id ?? 0);
}

export type SimpleContentRunStatus = "running" | "pending_review" | "succeeded" | "failed";

export async function finalizeSimpleContentRun(
  runId: number,
  data: {
    status: "succeeded" | "failed" | "pending_review";
    insertedCount: number;
    error: string | null;
    previewJson: unknown | null;
    requestPrompt: string | null;
    modelResponse: string | null;
    normalizedQuestions: unknown | null;
    usageInputTokens: number | null;
    usageOutputTokens: number | null;
    usageTotalTokens: number | null;
    estimatedCostUsd: number | null;
  },
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE simple_content_runs SET
       status = $2,
       inserted_count = $3,
       error = $4,
       preview_json = $5::jsonb,
       request_prompt = $6,
       model_response = $7,
       normalized_questions = $8::jsonb,
       usage_input_tokens = $9,
       usage_output_tokens = $10,
       usage_total_tokens = $11,
       estimated_cost_usd = $12,
       finished_at = NOW()
     WHERE id = $1`,
    [
      runId,
      data.status,
      data.insertedCount,
      data.error,
      data.previewJson ? JSON.stringify(data.previewJson) : null,
      data.requestPrompt,
      data.modelResponse,
      data.normalizedQuestions != null ? JSON.stringify(data.normalizedQuestions) : null,
      data.usageInputTokens,
      data.usageOutputTokens,
      data.usageTotalTokens,
      data.estimatedCostUsd,
    ],
  );
}

export async function getAppSettingValue(key: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [key]);
  const v = r.rows[0]?.value;
  if (v == null || !String(v).trim()) return null;
  return String(v);
}

export async function upsertAppSettingValue(key: string, value: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export type SimpleContentRunDetail = {
  id: number;
  subcategoryKey: string;
  triggerKind: string;
  status: SimpleContentRunStatus;
  provider: string | null;
  modelId: string | null;
  presetId: number | null;
  insertedCount: number;
  error: string | null;
  previewJson: unknown | null;
  requestPrompt: string | null;
  modelResponse: string | null;
  normalizedQuestions: unknown | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  usageTotalTokens: number | null;
  estimatedCostUsd: number | null;
  createdAt: string;
  finishedAt: string | null;
};

export async function getRunById(runId: number): Promise<SimpleContentRunDetail | null> {
  const pool = getPool();
  const r = await pool.query<{
    id: string;
    subcategory_key: string;
    trigger_kind: string;
    status: string;
    provider: string | null;
    model_id: string | null;
    preset_id: number | null;
    inserted_count: string;
    error: string | null;
    preview_json: unknown | null;
    request_prompt: string | null;
    model_response: string | null;
    normalized_questions: unknown | null;
    usage_input_tokens: number | null;
    usage_output_tokens: number | null;
    usage_total_tokens: number | null;
    estimated_cost_usd: string | null;
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id::text, subcategory_key, trigger_kind, status, provider, model_id, preset_id,
            inserted_count::text, error, preview_json, request_prompt, model_response, normalized_questions,
            usage_input_tokens, usage_output_tokens, usage_total_tokens,
            estimated_cost_usd::text,
            created_at, finished_at
     FROM simple_content_runs WHERE id = $1 LIMIT 1`,
    [runId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const st = row.status as SimpleContentRunStatus;
  const costRaw = row.estimated_cost_usd;
  const estimatedCostUsd =
    costRaw != null && costRaw !== "" && Number.isFinite(Number(costRaw)) ? Number(costRaw) : null;
  return {
    id: Number(row.id),
    subcategoryKey: row.subcategory_key,
    triggerKind: row.trigger_kind,
    status: st,
    provider: row.provider,
    modelId: row.model_id,
    presetId: row.preset_id,
    insertedCount: Number(row.inserted_count),
    error: row.error,
    previewJson: row.preview_json,
    requestPrompt: row.request_prompt,
    modelResponse: row.model_response,
    normalizedQuestions: row.normalized_questions,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    usageTotalTokens: row.usage_total_tokens,
    estimatedCostUsd,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

type RunRow = {
  id: string;
  status: string;
  trigger_kind: string;
  inserted_count: string;
  error: string | null;
  created_at: Date;
  provider: string | null;
  model_id: string | null;
  display_question_count: string | null;
};

export type ListRunsOptions = {
  triggerKind?: "manual" | "scheduled";
  status?: string;
};

export async function getRunsUsageSummaryForSubcategory(subcategoryKey: string): Promise<{
  runCount: number;
  successCount: number;
  failedCount: number;
  /** مجموع تقديرات التكلفة (USD) عندما يكون الحقل غير فارغ */
  sumEstimatedCostUsd: number | null;
  sumInputTokens: number;
  sumOutputTokens: number;
  sumTotalTokens: number;
}> {
  const pool = getPool();
  const r = await pool.query<{
    run_count: string;
    success_count: string;
    failed_count: string;
    sum_cost: string | null;
    sum_in: string | null;
    sum_out: string | null;
    sum_tot: string | null;
  }>(
    `SELECT
       COUNT(*)::text AS run_count,
       COUNT(*) FILTER (WHERE status = 'succeeded')::text AS success_count,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_count,
       SUM(estimated_cost_usd)::text AS sum_cost,
       COALESCE(SUM(usage_input_tokens) FILTER (WHERE usage_input_tokens IS NOT NULL), 0)::text AS sum_in,
       COALESCE(SUM(usage_output_tokens) FILTER (WHERE usage_output_tokens IS NOT NULL), 0)::text AS sum_out,
       COALESCE(SUM(usage_total_tokens) FILTER (WHERE usage_total_tokens IS NOT NULL), 0)::text AS sum_tot
     FROM simple_content_runs
     WHERE subcategory_key = $1`,
    [subcategoryKey],
  );
  const row = r.rows[0];
  const num = (v: string | null | undefined) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
  const costRaw = row?.sum_cost;
  const sumEstimatedCostUsd =
    costRaw != null && costRaw !== "" && Number.isFinite(Number(costRaw)) ? Number(costRaw) : null;
  return {
    runCount: num(row?.run_count),
    successCount: num(row?.success_count),
    failedCount: num(row?.failed_count),
    sumEstimatedCostUsd,
    sumInputTokens: num(row?.sum_in),
    sumOutputTokens: num(row?.sum_out),
    sumTotalTokens: num(row?.sum_tot),
  };
}

export async function listRuns(
  subcategoryKey: string,
  limit: number,
  options?: ListRunsOptions,
): Promise<
  Array<{
    id: number;
    status: string;
    triggerKind: string;
    insertedCount: number;
    error: string | null;
    createdAt: string;
    provider: string | null;
    modelId: string | null;
    /** أسئلة في المعاينة من المصفوفة، أو من preview_json، أو inserted_count عند الإدراج */
    questionCount: number | null;
  }>
> {
  const pool = getPool();
  const clauses: string[] = ["subcategory_key = $1"];
  const params: unknown[] = [subcategoryKey];
  let p = 2;
  if (options?.triggerKind === "manual" || options?.triggerKind === "scheduled") {
    clauses.push(`trigger_kind = $${p}`);
    params.push(options.triggerKind);
    p++;
  }
  if (options?.status && String(options.status).trim()) {
    clauses.push(`status = $${p}`);
    params.push(String(options.status).trim());
    p++;
  }
  const whereSql = clauses.join(" AND ");
  params.push(Math.max(1, Math.min(100, limit)));
  const limitIdx = p;
  const r = await pool.query<RunRow>(
    `SELECT id::text, status, trigger_kind, inserted_count::text, error, created_at, provider, model_id,
            COALESCE(
              CASE
                WHEN normalized_questions IS NOT NULL AND jsonb_typeof(normalized_questions) = 'array'
                THEN jsonb_array_length(normalized_questions)
              END,
              CASE
                WHEN preview_json IS NOT NULL
                     AND preview_json ? 'questionCount'
                     AND (preview_json->>'questionCount') ~ '^[0-9]+$'
                THEN (preview_json->>'questionCount')::int
              END,
              CASE WHEN inserted_count > 0 THEN inserted_count END
            )::text AS display_question_count
     FROM simple_content_runs
     WHERE ${whereSql}
     ORDER BY id DESC
     LIMIT $${limitIdx}`,
    params,
  );
  return r.rows.map((row) => {
    const qcRaw = row.display_question_count;
    const questionCount =
      qcRaw != null && qcRaw !== "" && Number.isFinite(Number(qcRaw)) ? Number(qcRaw) : null;
    return {
      id: Number(row.id),
      status: row.status,
      triggerKind: row.trigger_kind,
      insertedCount: Number(row.inserted_count),
      error: row.error,
      createdAt: row.created_at.toISOString(),
      provider: row.provider,
      modelId: row.model_id,
      questionCount,
    };
  });
}

export async function listDueAutomations(): Promise<SimpleContentAutomation[]> {
  const pool = getPool();
  const r = await pool.query<{
    subcategory_key: string;
    enabled: boolean;
    interval_minutes: number;
    model_preset_id: number | null;
    last_run_at: Date | null;
    next_run_at: Date | null;
  }>(
    `SELECT subcategory_key, enabled, interval_minutes, model_preset_id, last_run_at, next_run_at
     FROM simple_content_automation
     WHERE enabled = TRUE
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     ORDER BY subcategory_key ASC`,
  );
  return r.rows.map((row) => ({
    subcategoryKey: row.subcategory_key,
    enabled: row.enabled,
    intervalMinutes: row.interval_minutes,
    modelPresetId: row.model_preset_id,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
  }));
}

export async function bumpAutomationNextRun(subcategoryKey: string, intervalMinutes: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE simple_content_automation SET
       last_run_at = NOW(),
       next_run_at = NOW() + ($2::int * INTERVAL '1 minute'),
       updated_at = NOW()
     WHERE subcategory_key = $1`,
    [subcategoryKey, intervalMinutes],
  );
}
