import { getPool, closePool } from "../db/pool";
import { parseUsageFromInspectionRaw } from "../services/aiFactory/efficiencyReport";

type LayerAggregateRow = {
  layer: string;
  jobs: string;
  input_tokens: string;
  output_tokens: string;
  total_cost_usd: string;
  total_cost_sar: string;
};

type ReasoningRow = {
  layer_name: string;
  reasoning_level: string;
};

/**
 * Baseline metrics for AI Factory over a measurement window.
 * Usage: tsx server/scripts/aiFactoryBaselineMetrics.ts [days=7] [subcategory_key?] [--with-inspection-tokens]
 *
 * - Optional subcategory_key narrows jobs + usage to comparable cohorts (A/B fairness).
 * - --with-inspection-tokens: aggregates prompt/thoughts/candidates/total from inspection raw JSON (slower).
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--with-inspection-tokens");
  const withInspection = process.argv.includes("--with-inspection-tokens");
  const days = Math.max(1, Number(args[0] ?? 7) || 7);
  const subcategoryKey = args[1]?.trim() || null;
  const pool = getPool();

  const subFilterJobs = subcategoryKey ? "AND subcategory_key = $2" : "";
  const subParams: unknown[] = subcategoryKey ? [days, subcategoryKey] : [days];

  const summary = await pool.query<{
    jobs_total: string;
    succeeded: string;
    failed: string;
    cancelled: string;
    queued: string;
    running: string;
    avg_questions_per_success: string;
    refiner_skipped_count: string;
    optimized_variant_count: string;
    baseline_variant_count: string;
    avg_batch_size_success: string;
  }>(
    `SELECT
       COUNT(*)::text AS jobs_total,
       COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled,
       COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
       COUNT(*) FILTER (WHERE status = 'running')::text AS running,
       COALESCE(AVG((result_summary->>'inserted')::int) FILTER (WHERE status = 'succeeded'), 0)::text AS avg_questions_per_success,
       COUNT(*) FILTER (WHERE COALESCE((result_summary->>'refinerSkipped')::boolean, false) = true)::text AS refiner_skipped_count,
       COUNT(*) FILTER (WHERE COALESCE(result_summary->>'promptVariant', '') = 'optimized')::text AS optimized_variant_count,
       COUNT(*) FILTER (WHERE COALESCE(NULLIF(result_summary->>'promptVariant', ''), NULLIF(payload->>'promptVariant', ''), 'baseline') = 'baseline')::text AS baseline_variant_count,
       COALESCE(AVG(batch_size) FILTER (WHERE status = 'succeeded'), 0)::text AS avg_batch_size_success
     FROM ai_factory_jobs
     WHERE created_at >= NOW() - ($1::text || ' days')::interval
       ${subFilterJobs}`,
    subParams,
  );

  const usageWhere = subcategoryKey
    ? `u.created_at >= NOW() - ($1::text || ' days')::interval
         AND EXISTS (SELECT 1 FROM ai_factory_jobs j WHERE j.id = u.job_id AND j.subcategory_key = $2)`
    : `created_at >= NOW() - ($1::text || ' days')::interval`;

  const layerAgg = await pool.query<LayerAggregateRow>(
    subcategoryKey
      ? `SELECT
           u.layer_type::text AS layer,
           COUNT(*)::text AS jobs,
           COALESCE(SUM(u.input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(u.output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(u.cost_usd), 0)::text AS total_cost_usd,
           COALESCE(SUM(u.cost_sar), 0)::text AS total_cost_sar
         FROM ai_usage_logs u
         WHERE ${usageWhere}
         GROUP BY u.layer_type
         ORDER BY u.layer_type`
      : `SELECT
           layer_type::text AS layer,
           COUNT(*)::text AS jobs,
           COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(cost_usd), 0)::text AS total_cost_usd,
           COALESCE(SUM(cost_sar), 0)::text AS total_cost_sar
         FROM ai_usage_logs
         WHERE created_at >= NOW() - ($1::text || ' days')::interval
         GROUP BY layer_type
         ORDER BY layer_type`,
    subParams,
  );

  const totalUsage = await pool.query<{
    input_tokens: string;
    output_tokens: string;
    cost_usd: string;
  }>(
    subcategoryKey
      ? `SELECT
           COALESCE(SUM(u.input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(u.output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(u.cost_usd), 0)::text AS cost_usd
         FROM ai_usage_logs u
         WHERE ${usageWhere}`
      : `SELECT
           COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
           COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
           COALESCE(SUM(cost_usd), 0)::text AS cost_usd
         FROM ai_usage_logs
         WHERE created_at >= NOW() - ($1::text || ' days')::interval`,
    subParams,
  );

  const reasoning = await pool.query<ReasoningRow>(
    `SELECT layer_name::text, reasoning_level::text
     FROM ai_factory_model_config
     ORDER BY layer_name`,
  );

  const s = summary.rows[0];
  const t = totalUsage.rows[0];
  const succeeded = Number(s?.succeeded ?? 0);
  const totalTokens = Number(t?.input_tokens ?? 0) + Number(t?.output_tokens ?? 0);
  const costUsd = Number(t?.cost_usd ?? 0);
  const avgTokensPerSucceededJob = succeeded > 0 ? Math.round(totalTokens / succeeded) : 0;
  const avgCostPerSucceededJob = succeeded > 0 ? Number((costUsd / succeeded).toFixed(6)) : 0;

  let inspectionTokenTotals: Record<
    string,
    { promptTokenCount: number; thoughtsTokenCount: number; candidatesTokenCount: number; totalTokenCount: number }
  > | null = null;

  if (withInspection) {
    const jobIdsR = await pool.query<{ id: string }>(
      `SELECT id::text
       FROM ai_factory_jobs
       WHERE status = 'succeeded'
         AND created_at >= NOW() - ($1::text || ' days')::interval
         ${subFilterJobs}
       ORDER BY id DESC
       LIMIT 150`,
      subParams,
    );
    const ids = jobIdsR.rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length) {
      const insp = await pool.query<{ layer_name: string; raw_response_text: string }>(
        `SELECT layer_name::text, raw_response_text
         FROM ai_factory_inspection_logs
         WHERE job_id = ANY($1::bigint[])`,
        [ids],
      );
      inspectionTokenTotals = {};
      for (const row of insp.rows) {
        const u = parseUsageFromInspectionRaw(row.raw_response_text);
        if (!u) continue;
        const L = row.layer_name;
        if (!inspectionTokenTotals[L]) {
          inspectionTokenTotals[L] = {
            promptTokenCount: 0,
            thoughtsTokenCount: 0,
            candidatesTokenCount: 0,
            totalTokenCount: 0,
          };
        }
        inspectionTokenTotals[L].promptTokenCount += u.promptTokenCount;
        inspectionTokenTotals[L].thoughtsTokenCount += u.thoughtsTokenCount;
        inspectionTokenTotals[L].candidatesTokenCount += u.candidatesTokenCount;
        inspectionTokenTotals[L].totalTokenCount += u.totalTokenCount;
      }
    } else {
      inspectionTokenTotals = {};
    }
  }

  console.log(
    JSON.stringify(
      {
        measurementWindow: {
          days,
          subcategoryKey,
          withInspectionTokens: withInspection,
          note: "ثبّت days وsubcategory_key وmodel عند مقارنة baseline vs optimized.",
        },
        jobs: s,
        usageTotals: {
          inputTokens: Number(t?.input_tokens ?? 0),
          outputTokens: Number(t?.output_tokens ?? 0),
          totalTokens,
          costUsd,
          avgTokensPerSucceededJob,
          avgCostPerSucceededJob,
        },
        byLayer: layerAgg.rows.map((r) => ({
          layer: r.layer,
          jobs: Number(r.jobs),
          inputTokens: Number(r.input_tokens),
          outputTokens: Number(r.output_tokens),
          totalTokens: Number(r.input_tokens) + Number(r.output_tokens),
          totalCostUsd: Number(r.total_cost_usd),
          totalCostSar: Number(r.total_cost_sar),
        })),
        modelConfigReasoning: Object.fromEntries(
          reasoning.rows.map((r) => [r.layer_name, r.reasoning_level]),
        ),
        reasoningEnvCaps: {
          AI_FACTORY_REASONING_POLICY_MODE: process.env.AI_FACTORY_REASONING_POLICY_MODE ?? "(default cap)",
          AI_FACTORY_REASONING_CAP_ARCHITECT: process.env.AI_FACTORY_REASONING_CAP_ARCHITECT ?? "",
          AI_FACTORY_REASONING_CAP_CREATOR: process.env.AI_FACTORY_REASONING_CAP_CREATOR ?? "",
          AI_FACTORY_REASONING_CAP_AUDITOR: process.env.AI_FACTORY_REASONING_CAP_AUDITOR ?? "",
          AI_FACTORY_REASONING_CAP_REFINER: process.env.AI_FACTORY_REASONING_CAP_REFINER ?? "",
        },
        inspectionTokenTotalsByLayer: inspectionTokenTotals,
      },
      null,
      2,
    ),
  );

  await closePool();
}

main().catch(async (error) => {
  console.error("baseline_metrics_failed", error instanceof Error ? error.message : String(error));
  await closePool().catch(() => undefined);
  process.exit(1);
});
