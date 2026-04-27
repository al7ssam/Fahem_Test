import { getPool } from "../../db/pool";
import type { FactoryLayer } from "./types";

const USD_TO_SAR_RATE = 3.75;
const FLASH_INPUT_PER_MILLION = 0.075;
const FLASH_OUTPUT_PER_MILLION = 0.30;

export type UsageTokens = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type GeminiCostResult = UsageTokens & {
  costUsd: number;
  costSar: number;
  pricingSource: string;
};

export type UsageFilters = {
  subject?: string;
  modelId?: string;
  from?: string;
  to?: string;
};

function toSafeTokens(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function roundMoney(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function usdToSar(usd: number, rate = USD_TO_SAR_RATE): number {
  const safeUsd = Number.isFinite(usd) ? Math.max(0, usd) : 0;
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : USD_TO_SAR_RATE;
  return roundMoney(safeUsd * safeRate);
}

export function calculateGeminiCost(inputTokensRaw: unknown, outputTokensRaw: unknown, modelId: string): GeminiCostResult {
  const inputTokens = toSafeTokens(inputTokensRaw);
  const outputTokens = toSafeTokens(outputTokensRaw);
  const totalTokens = inputTokens + outputTokens;
  const inputCost = (inputTokens / 1_000_000) * FLASH_INPUT_PER_MILLION;
  const outputCost = (outputTokens / 1_000_000) * FLASH_OUTPUT_PER_MILLION;
  const costUsd = roundMoney(inputCost + outputCost);
  const costSar = usdToSar(costUsd);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    costSar,
    pricingSource: `gemini_flash_default:${modelId || "unknown"}`,
  };
}

export async function insertAiUsageLog(input: {
  jobId: number;
  modelId: string;
  layerType: FactoryLayer;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costSar: number;
  subject: string;
  status: "success" | "failed";
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_usage_logs
      (job_id, model_id, layer_type, input_tokens, output_tokens, cost_usd, cost_sar, subject, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.jobId,
      input.modelId,
      input.layerType,
      toSafeTokens(input.inputTokens),
      toSafeTokens(input.outputTokens),
      roundMoney(input.costUsd),
      roundMoney(input.costSar),
      String(input.subject || "غير محدد").trim() || "غير محدد",
      input.status,
    ],
  );
}

function applyFilters(baseSql: string, filters: UsageFilters, args: unknown[]): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  if (filters.subject) {
    args.push(filters.subject);
    clauses.push(`subject = $${args.length}`);
  }
  if (filters.modelId) {
    args.push(filters.modelId);
    clauses.push(`model_id = $${args.length}`);
  }
  if (filters.from) {
    args.push(filters.from);
    clauses.push(`created_at >= $${args.length}::timestamptz`);
  }
  if (filters.to) {
    args.push(filters.to);
    clauses.push(`created_at < ($${args.length}::date + INTERVAL '1 day')`);
  }
  if (!clauses.length) return { sql: baseSql, args };
  return { sql: `${baseSql} AND ${clauses.join(" AND ")}`, args };
}

export async function getUsageSummary(filters: UsageFilters): Promise<{
  totalCostUsd: number;
  totalCostSar: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  generatedQuestions: number;
}> {
  const pool = getPool();
  const args: unknown[] = [];
  let baseSql = `
    SELECT
      COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd,
      COALESCE(SUM(cost_sar), 0)::float8 AS total_cost_sar,
      COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens
    FROM ai_usage_logs
    WHERE TRUE
  `;
  if (!filters.from && !filters.to) {
    args.push(30);
    baseSql = `
    SELECT
      COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd,
      COALESCE(SUM(cost_sar), 0)::float8 AS total_cost_sar,
      COALESCE(SUM(input_tokens), 0)::bigint AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0)::bigint AS total_output_tokens
    FROM ai_usage_logs
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `;
  }
  const usageQuery = applyFilters(baseSql, filters, args);
  const usage = await pool.query<{
    total_cost_usd: number;
    total_cost_sar: number;
    total_input_tokens: string;
    total_output_tokens: string;
  }>(usageQuery.sql, usageQuery.args);

  const qArgs: unknown[] = [];
  let qSql = `
    SELECT COALESCE(SUM(COALESCE((j.result_summary->>'inserted')::int, 0)), 0)::bigint AS generated_questions
    FROM ai_factory_jobs j
    WHERE j.status = 'succeeded'
  `;
  if (!filters.from && !filters.to) {
    qArgs.push(30);
    qSql += ` AND j.created_at >= NOW() - ($1::text || ' days')::interval`;
  } else {
    if (filters.from) {
      qArgs.push(filters.from);
      qSql += ` AND j.created_at >= $${qArgs.length}::timestamptz`;
    }
    if (filters.to) {
      qArgs.push(filters.to);
      qSql += ` AND j.created_at < ($${qArgs.length}::date + INTERVAL '1 day')`;
    }
  }
  const subClauses: string[] = [];
  if (!filters.from && !filters.to) {
    subClauses.push(`u.created_at >= NOW() - ($1::text || ' days')::interval`);
  } else {
    if (filters.from) {
      qArgs.push(filters.from);
      subClauses.push(`u.created_at >= $${qArgs.length}::timestamptz`);
    }
    if (filters.to) {
      qArgs.push(filters.to);
      subClauses.push(`u.created_at < ($${qArgs.length}::date + INTERVAL '1 day')`);
    }
  }
  if (filters.subject) {
    qArgs.push(filters.subject);
    subClauses.push(`u.subject = $${qArgs.length}`);
  }
  if (filters.modelId) {
    qArgs.push(filters.modelId);
    subClauses.push(`u.model_id = $${qArgs.length}`);
  }
  if (subClauses.length) {
    qSql += ` AND EXISTS (
      SELECT 1 FROM ai_usage_logs u
      WHERE u.job_id = j.id
        AND ${subClauses.join(" AND ")}
    )`;
  }
  const questions = await pool.query<{ generated_questions: string }>(qSql, qArgs);
  const row = usage.rows[0];
  const totalInputTokens = Number(row?.total_input_tokens ?? 0);
  const totalOutputTokens = Number(row?.total_output_tokens ?? 0);
  return {
    totalCostUsd: roundMoney(Number(row?.total_cost_usd ?? 0)),
    totalCostSar: roundMoney(Number(row?.total_cost_sar ?? 0)),
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    generatedQuestions: Number(questions.rows[0]?.generated_questions ?? 0),
  };
}

export async function getUsageDailyCost(filters: UsageFilters): Promise<Array<{ day: string; costUsd: number; costSar: number }>> {
  const pool = getPool();
  const args: unknown[] = [];
  let baseSql = `
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
      COALESCE(SUM(cost_sar), 0)::float8 AS cost_sar
    FROM ai_usage_logs
    WHERE TRUE
  `;
  if (!filters.from && !filters.to) {
    args.push(7);
    baseSql = `
    SELECT
      to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
      COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
      COALESCE(SUM(cost_sar), 0)::float8 AS cost_sar
    FROM ai_usage_logs
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `;
  }
  const q = applyFilters(baseSql, filters, args);
  const r = await pool.query<{ day: string; cost_usd: number; cost_sar: number }>(
    `${q.sql} GROUP BY 1 ORDER BY 1 ASC`,
    q.args,
  );
  return r.rows.map((x) => ({
    day: x.day,
    costUsd: roundMoney(Number(x.cost_usd ?? 0)),
    costSar: roundMoney(Number(x.cost_sar ?? 0)),
  }));
}

export async function getRecentUsage(
  filters: UsageFilters,
  limit = 20,
): Promise<
  Array<{
    id: number;
    jobId: number;
    modelId: string;
    layerType: FactoryLayer;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    costSar: number;
    subject: string;
    status: "success" | "failed";
    createdAt: string;
  }>
> {
  const pool = getPool();
  const sqlArgs: unknown[] = [];
  let sql = `
    SELECT id, job_id, model_id, layer_type, input_tokens, output_tokens, cost_usd, cost_sar, subject, status, created_at
    FROM ai_usage_logs
    WHERE TRUE
  `;
  if (!filters.from && !filters.to) {
    sqlArgs.push(30);
    sql = `
    SELECT id, job_id, model_id, layer_type, input_tokens, output_tokens, cost_usd, cost_sar, subject, status, created_at
    FROM ai_usage_logs
    WHERE created_at >= NOW() - ($1::text || ' days')::interval
  `;
  }
  const q = applyFilters(sql, filters, sqlArgs);
  q.args.push(Math.min(100, Math.max(1, Number(limit) || 20)));
  sql = `${q.sql} ORDER BY id DESC LIMIT $${q.args.length}`;
  const r = await pool.query<{
    id: number;
    job_id: number;
    model_id: string;
    layer_type: FactoryLayer;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    cost_sar: number;
    subject: string;
    status: "success" | "failed";
    created_at: string;
  }>(sql, q.args);
  return r.rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    modelId: row.model_id,
    layerType: row.layer_type,
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    costUsd: roundMoney(Number(row.cost_usd ?? 0)),
    costSar: roundMoney(Number(row.cost_sar ?? 0)),
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function getUsageFilterOptions(): Promise<{ subjects: string[]; modelIds: string[] }> {
  const pool = getPool();
  const [subjectsR, modelsR] = await Promise.all([
    pool.query<{ subject: string }>(
      `SELECT DISTINCT subject FROM ai_usage_logs WHERE btrim(subject) <> '' ORDER BY subject ASC`,
    ),
    pool.query<{ model_id: string }>(
      `SELECT DISTINCT model_id FROM ai_usage_logs WHERE btrim(model_id) <> '' ORDER BY model_id ASC`,
    ),
  ]);
  return {
    subjects: subjectsR.rows.map((x) => x.subject),
    modelIds: modelsR.rows.map((x) => x.model_id),
  };
}
