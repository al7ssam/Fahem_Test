import { getPool, closePool } from "../db/pool";

type LayerAggregateRow = {
  layer: string;
  jobs: string;
  input_tokens: string;
  output_tokens: string;
  total_cost_usd: string;
  total_cost_sar: string;
};

async function main(): Promise<void> {
  const days = Math.max(1, Number(process.argv[2] ?? 7) || 7);
  const pool = getPool();

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
       COUNT(*) FILTER (WHERE COALESCE(result_summary->>'promptVariant', '') = 'optimized')::text AS optimized_variant_count
     FROM ai_factory_jobs
     WHERE created_at >= NOW() - ($1::text || ' days')::interval`,
    [days],
  );

  const layerAgg = await pool.query<LayerAggregateRow>(
    `SELECT
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
    [days],
  );

  const totalUsage = await pool.query<{
    input_tokens: string;
    output_tokens: string;
    cost_usd: string;
  }>(
    `SELECT
       COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
       COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
       COALESCE(SUM(cost_usd), 0)::text AS cost_usd
     FROM ai_usage_logs
     WHERE created_at >= NOW() - ($1::text || ' days')::interval`,
    [days],
  );

  const s = summary.rows[0];
  const t = totalUsage.rows[0];
  const succeeded = Number(s?.succeeded ?? 0);
  const totalTokens = Number(t?.input_tokens ?? 0) + Number(t?.output_tokens ?? 0);
  const costUsd = Number(t?.cost_usd ?? 0);
  const avgTokensPerSucceededJob = succeeded > 0 ? Math.round(totalTokens / succeeded) : 0;
  const avgCostPerSucceededJob = succeeded > 0 ? Number((costUsd / succeeded).toFixed(6)) : 0;

  console.log(
    JSON.stringify(
      {
        windowDays: days,
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
