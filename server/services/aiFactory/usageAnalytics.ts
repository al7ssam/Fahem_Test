import { getPool } from "../../db/pool";
import type { FactoryLayer } from "./types";

const USD_TO_SAR_RATE = 3.75;
type GeminiPricing = {
  inputPerMillion: number;
  outputPerMillion: number;
  source: string;
};

type GeminiPricingRule = {
  pattern: RegExp;
  pricing: GeminiPricing;
};

const GEMINI_FALLBACK_PRICING: GeminiPricing = {
  inputPerMillion: 0.075,
  outputPerMillion: 0.30,
  source: "fallback:gemini-1.5-flash",
};

const GEMINI_PRICING_RULES: GeminiPricingRule[] = [
  {
    pattern: /gemini-3(?:\.0)?-pro/i,
    pricing: { inputPerMillion: 1.25, outputPerMillion: 5.0, source: "gemini-3-pro" },
  },
  {
    pattern: /gemini-3(?:\.0)?-flash/i,
    pricing: { inputPerMillion: 0.5, outputPerMillion: 3.0, source: "gemini-3-flash" },
  },
  {
    pattern: /gemini-1\.5-pro/i,
    pricing: { inputPerMillion: 3.5, outputPerMillion: 10.5, source: "gemini-1.5-pro" },
  },
  {
    pattern: /gemini-1\.5-flash/i,
    pricing: { inputPerMillion: 0.075, outputPerMillion: 0.3, source: "gemini-1.5-flash" },
  },
];

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

function safeRate(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function resolveGeminiPricing(modelId: string): GeminiPricing {
  const normalized = String(modelId || "").trim().toLowerCase();
  for (const rule of GEMINI_PRICING_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.pricing;
    }
  }
  return GEMINI_FALLBACK_PRICING;
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
  const pricing = resolveGeminiPricing(modelId);
  const inputRate = safeRate(pricing.inputPerMillion, GEMINI_FALLBACK_PRICING.inputPerMillion);
  const outputRate = safeRate(pricing.outputPerMillion, GEMINI_FALLBACK_PRICING.outputPerMillion);
  const inputCost = (inputTokens / 1_000_000) * inputRate;
  const outputCost = (outputTokens / 1_000_000) * outputRate;
  const costUsd = roundMoney(inputCost + outputCost);
  const costSar = usdToSar(costUsd);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    costSar,
    pricingSource: `${pricing.source}:${modelId || "unknown"}`,
  };
}

function logPricingVerificationSamples(): void {
  if (process.env.NODE_ENV === "production") return;
  const sampleInput = 1_000_000;
  const sampleOutput = 500_000;
  const pro15 = calculateGeminiCost(sampleInput, sampleOutput, "gemini-1.5-pro");
  const flash3 = calculateGeminiCost(sampleInput, sampleOutput, "gemini-3-flash-preview");
  console.log("[usageAnalytics] pricing-check gemini-1.5-pro", {
    inputTokens: pro15.inputTokens,
    outputTokens: pro15.outputTokens,
    costUsd: pro15.costUsd,
    costSar: pro15.costSar,
    source: pro15.pricingSource,
  });
  console.log("[usageAnalytics] pricing-check gemini-3-flash-preview", {
    inputTokens: flash3.inputTokens,
    outputTokens: flash3.outputTokens,
    costUsd: flash3.costUsd,
    costSar: flash3.costSar,
    source: flash3.pricingSource,
  });
}

logPricingVerificationSamples();

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
  retryIndex?: number;
  attemptId?: string;
  costSource?: "provider_exact" | "estimated";
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_usage_logs
      (job_id, model_id, layer_type, input_tokens, output_tokens, cost_usd, cost_sar, subject, status, retry_index, attempt_id, cost_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
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
      Math.max(0, Math.floor(Number(input.retryIndex ?? 0) || 0)),
      String(input.attemptId || "").trim() || null,
      input.costSource === "provider_exact" ? "provider_exact" : "estimated",
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

export async function getUsageRetryKpis(filters: UsageFilters): Promise<{
  totalTokens: number;
  retryTokens: number;
  retryTokenRatio: number;
  totalCostUsd: number;
  retryCostUsd: number;
  totalCostSar: number;
  retryCostSar: number;
}> {
  const pool = getPool();
  const args: unknown[] = [];
  let baseSql = `
    SELECT
      COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
      COALESCE(SUM(CASE WHEN retry_index > 0 THEN input_tokens + output_tokens ELSE 0 END), 0)::bigint AS retry_tokens,
      COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd,
      COALESCE(SUM(CASE WHEN retry_index > 0 THEN cost_usd ELSE 0 END), 0)::float8 AS retry_cost_usd,
      COALESCE(SUM(cost_sar), 0)::float8 AS total_cost_sar,
      COALESCE(SUM(CASE WHEN retry_index > 0 THEN cost_sar ELSE 0 END), 0)::float8 AS retry_cost_sar
    FROM ai_usage_logs
    WHERE TRUE
  `;
  if (!filters.from && !filters.to) {
    args.push(30);
    baseSql = `
      SELECT
        COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
        COALESCE(SUM(CASE WHEN retry_index > 0 THEN input_tokens + output_tokens ELSE 0 END), 0)::bigint AS retry_tokens,
        COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd,
        COALESCE(SUM(CASE WHEN retry_index > 0 THEN cost_usd ELSE 0 END), 0)::float8 AS retry_cost_usd,
        COALESCE(SUM(cost_sar), 0)::float8 AS total_cost_sar,
        COALESCE(SUM(CASE WHEN retry_index > 0 THEN cost_sar ELSE 0 END), 0)::float8 AS retry_cost_sar
      FROM ai_usage_logs
      WHERE created_at >= NOW() - ($1::text || ' days')::interval
    `;
  }
  const q = applyFilters(baseSql, filters, args);
  const r = await pool.query<{
    total_tokens: string;
    retry_tokens: string;
    total_cost_usd: number;
    retry_cost_usd: number;
    total_cost_sar: number;
    retry_cost_sar: number;
  }>(q.sql, q.args);
  const row = r.rows[0];
  const totalTokens = Number(row?.total_tokens ?? 0);
  const retryTokens = Number(row?.retry_tokens ?? 0);
  return {
    totalTokens,
    retryTokens,
    retryTokenRatio: totalTokens > 0 ? Math.round((retryTokens / totalTokens) * 10_000) / 10_000 : 0,
    totalCostUsd: roundMoney(Number(row?.total_cost_usd ?? 0)),
    retryCostUsd: roundMoney(Number(row?.retry_cost_usd ?? 0)),
    totalCostSar: roundMoney(Number(row?.total_cost_sar ?? 0)),
    retryCostSar: roundMoney(Number(row?.retry_cost_sar ?? 0)),
  };
}

export type SimplificationKpiWindow = {
  from: string;
  to: string;
};

export async function getSimplificationKpisComparison(input: {
  before: SimplificationKpiWindow;
  after: SimplificationKpiWindow;
}): Promise<{
  before: {
    tokensPerInsertedQuestion: number;
    retryTokenRatio: number;
    creatorSchemaFailRate: number;
    costPerInsertedQuestionUsd: number;
  };
  after: {
    tokensPerInsertedQuestion: number;
    retryTokenRatio: number;
    creatorSchemaFailRate: number;
    costPerInsertedQuestionUsd: number;
  };
}> {
  const pool = getPool();
  const calcWindow = async (window: SimplificationKpiWindow) => {
    const usage = await pool.query<{
      total_tokens: string;
      retry_tokens: string;
      total_cost_usd: number;
    }>(
      `SELECT
         COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
         COALESCE(SUM(CASE WHEN retry_index > 0 THEN input_tokens + output_tokens ELSE 0 END), 0)::bigint AS retry_tokens,
         COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd
       FROM ai_usage_logs
       WHERE created_at >= $1::timestamptz
         AND created_at < ($2::date + INTERVAL '1 day')`,
      [window.from, window.to],
    );
    const jobs = await pool.query<{
      inserted_questions: string;
      creator_schema_fail_count: string;
      total_failed_count: string;
    }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'succeeded' THEN COALESCE((result_summary->>'inserted')::int, 0) ELSE 0 END), 0)::bigint AS inserted_questions,
         COALESCE(
           SUM(
             CASE
               WHEN status = 'failed'
                 AND (
                   last_error ILIKE 'creator_invalid_schema%'
                   OR last_error ILIKE 'creator_missing_field%'
                   OR last_error ILIKE 'creator_invalid_question%'
                   OR last_error ILIKE 'schema_gate_%'
                   OR last_error ILIKE 'gate_lite_%'
                 )
               THEN 1
               ELSE 0
             END
           ),
           0
         )::bigint AS creator_schema_fail_count,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)::bigint AS total_failed_count
       FROM ai_factory_jobs
       WHERE created_at >= $1::timestamptz
         AND created_at < ($2::date + INTERVAL '1 day')`,
      [window.from, window.to],
    );
    const usageRow = usage.rows[0];
    const jobsRow = jobs.rows[0];
    const totalTokens = Number(usageRow?.total_tokens ?? 0);
    const retryTokens = Number(usageRow?.retry_tokens ?? 0);
    const totalCostUsd = Number(usageRow?.total_cost_usd ?? 0);
    const inserted = Number(jobsRow?.inserted_questions ?? 0);
    const creatorSchemaFailCount = Number(jobsRow?.creator_schema_fail_count ?? 0);
    const totalFailedCount = Number(jobsRow?.total_failed_count ?? 0);
    return {
      tokensPerInsertedQuestion: inserted > 0 ? Math.round((totalTokens / inserted) * 100) / 100 : 0,
      retryTokenRatio: totalTokens > 0 ? Math.round((retryTokens / totalTokens) * 10_000) / 10_000 : 0,
      creatorSchemaFailRate: totalFailedCount > 0 ? Math.round((creatorSchemaFailCount / totalFailedCount) * 10_000) / 10_000 : 0,
      costPerInsertedQuestionUsd: inserted > 0 ? roundMoney(totalCostUsd / inserted) : 0,
    };
  };

  const [before, after] = await Promise.all([calcWindow(input.before), calcWindow(input.after)]);
  return { before, after };
}
