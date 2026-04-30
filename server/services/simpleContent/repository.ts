import { getPool } from "../../db/pool";
import type { SimpleContentAutomation, SimpleContentPreset } from "./types";

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
    ],
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
    created_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id::text, subcategory_key, trigger_kind, status, provider, model_id, preset_id,
            inserted_count::text, error, preview_json, request_prompt, model_response, normalized_questions,
            created_at, finished_at
     FROM simple_content_runs WHERE id = $1 LIMIT 1`,
    [runId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const st = row.status as SimpleContentRunStatus;
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
};

export async function listRuns(
  subcategoryKey: string,
  limit: number,
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
  }>
> {
  const pool = getPool();
  const r = await pool.query<RunRow>(
    `SELECT id::text, status, trigger_kind, inserted_count::text, error, created_at, provider, model_id
     FROM simple_content_runs
     WHERE subcategory_key = $1
     ORDER BY id DESC
     LIMIT $2`,
    [subcategoryKey, Math.max(1, Math.min(100, limit))],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    status: row.status,
    triggerKind: row.trigger_kind,
    insertedCount: Number(row.inserted_count),
    error: row.error,
    createdAt: row.created_at.toISOString(),
    provider: row.provider,
    modelId: row.model_id,
  }));
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
