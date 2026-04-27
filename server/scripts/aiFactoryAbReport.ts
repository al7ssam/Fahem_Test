import { getPool, closePool } from "../db/pool";

type VariantSummaryRow = {
  variant: string;
  jobs_total: string;
  succeeded: string;
  failed: string;
  cancelled: string;
  refiner_skipped: string;
  avg_inserted: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string;
};

const DEFAULT_TOKEN_REDUCTION_TARGET_PCT = 35;
const DEFAULT_COST_REDUCTION_TARGET_PCT = 30;

/**
 * Compare baseline vs optimized cohorts over a window.
 * Usage: tsx server/scripts/aiFactoryAbReport.ts [days=7] [subcategory_key?]
 */
async function main(): Promise<void> {
  const days = Math.max(1, Number(process.argv[2] ?? 7) || 7);
  const subcategoryKey = process.argv[3]?.trim() || null;
  const pool = getPool();

  const subFilter = subcategoryKey ? "AND subcategory_key = $2" : "";
  const params: unknown[] = subcategoryKey ? [days, subcategoryKey] : [days];

  const rows = await pool.query<VariantSummaryRow>(
    `WITH jobs AS (
       SELECT
         id,
         COALESCE(NULLIF(result_summary->>'promptVariant', ''), NULLIF(payload->>'promptVariant', ''), 'baseline') AS variant,
         status,
         COALESCE((result_summary->>'inserted')::int, 0) AS inserted,
         COALESCE((result_summary->>'refinerSkipped')::boolean, false) AS refiner_skipped
       FROM ai_factory_jobs
       WHERE created_at >= NOW() - ($1::text || ' days')::interval
         ${subFilter}
     ),
     usage AS (
       SELECT
         job_id,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cost_usd), 0) AS cost_usd
       FROM ai_usage_logs
       WHERE created_at >= NOW() - ($1::text || ' days')::interval
       GROUP BY job_id
     )
     SELECT
       jobs.variant::text AS variant,
       COUNT(*)::text AS jobs_total,
       COUNT(*) FILTER (WHERE jobs.status = 'succeeded')::text AS succeeded,
       COUNT(*) FILTER (WHERE jobs.status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE jobs.status = 'cancelled')::text AS cancelled,
       COUNT(*) FILTER (WHERE jobs.refiner_skipped = true)::text AS refiner_skipped,
       COALESCE(AVG(jobs.inserted), 0)::text AS avg_inserted,
       COALESCE(SUM(usage.input_tokens), 0)::text AS input_tokens,
       COALESCE(SUM(usage.output_tokens), 0)::text AS output_tokens,
       COALESCE(SUM(usage.cost_usd), 0)::text AS cost_usd
     FROM jobs
     LEFT JOIN usage ON usage.job_id = jobs.id
     GROUP BY jobs.variant
     ORDER BY jobs.variant`,
    params,
  );

  const report = rows.rows.map((r) => {
    const succeeded = Number(r.succeeded);
    const jobsTotal = Number(r.jobs_total);
    const input = Number(r.input_tokens);
    const output = Number(r.output_tokens);
    const total = input + output;
    const cost = Number(r.cost_usd);
    const avgTokensPerSucceededJob = succeeded > 0 ? Math.round(total / succeeded) : 0;
    const avgCostPerSucceededJob = succeeded > 0 ? Number((cost / succeeded).toFixed(6)) : 0;
    return {
      variant: r.variant,
      jobsTotal,
      succeeded,
      failed: Number(r.failed),
      cancelled: Number(r.cancelled),
      refinerSkipped: Number(r.refiner_skipped),
      successRatePercent: jobsTotal > 0 ? Number(((succeeded / jobsTotal) * 100).toFixed(2)) : 0,
      refinerSkippedRatePercent: jobsTotal > 0 ? Number(((Number(r.refiner_skipped) / jobsTotal) * 100).toFixed(2)) : 0,
      avgInserted: Number(r.avg_inserted),
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      costUsd: cost,
      avgTokensPerSucceededJob,
      avgCostPerSucceededJob,
    };
  });

  const baseline = report.find((x) => x.variant === "baseline");
  const optimized = report.find((x) => x.variant === "optimized");
  const comparison =
    baseline && optimized
      ? {
          tokenReductionPercent:
            baseline.avgTokensPerSucceededJob > 0
              ? Number(
                  (
                    ((baseline.avgTokensPerSucceededJob - optimized.avgTokensPerSucceededJob) /
                      baseline.avgTokensPerSucceededJob) *
                    100
                  ).toFixed(2),
                )
              : 0,
          costReductionPercent:
            baseline.avgCostPerSucceededJob > 0
              ? Number(
                  (
                    ((baseline.avgCostPerSucceededJob - optimized.avgCostPerSucceededJob) /
                      baseline.avgCostPerSucceededJob) *
                    100
                  ).toFixed(2),
                )
              : 0,
        }
      : null;

  const kpiTargets = {
    minTokenReductionPercent: DEFAULT_TOKEN_REDUCTION_TARGET_PCT,
    minCostReductionPercent: DEFAULT_COST_REDUCTION_TARGET_PCT,
    /** لا انحدار قوي لنجاح الوظائف مقارنة بـ baseline في نفس النافذة (نقاط مئوية). */
    maxSuccessRateRegressionVsBaselinePp: 2,
  };

  const kpiGate =
    comparison && baseline && optimized
      ? {
          targets: kpiTargets,
          meetsTokenReduction: comparison.tokenReductionPercent >= kpiTargets.minTokenReductionPercent,
          meetsCostReduction: comparison.costReductionPercent >= kpiTargets.minCostReductionPercent,
          meetsSuccessStability:
            optimized.successRatePercent + kpiTargets.maxSuccessRateRegressionVsBaselinePp >=
            baseline.successRatePercent,
          readyForRolloutGeneralization:
            comparison.tokenReductionPercent >= kpiTargets.minTokenReductionPercent &&
            comparison.costReductionPercent >= kpiTargets.minCostReductionPercent &&
            optimized.successRatePercent + kpiTargets.maxSuccessRateRegressionVsBaselinePp >=
              baseline.successRatePercent,
          notes: [
            "readyForRolloutGeneralization هو مؤشر آلية فقط؛ راجع معدل Refiner وجودة المحتوى يدويًا قبل التعميم.",
            "successRatePercent = succeeded / jobs_total لكل variant؛ meetsSuccessStability يسمح بانحدار حتى 2 نقطة مئوية تحت baseline.",
          ],
        }
      : null;

  console.log(
    JSON.stringify(
      {
        measurementWindow: { days, subcategoryKey },
        variants: report,
        comparison,
        kpiGate,
      },
      null,
      2,
    ),
  );
  await closePool();
}

main().catch(async (error) => {
  console.error("ab_report_failed", error instanceof Error ? error.message : String(error));
  await closePool().catch(() => undefined);
  process.exit(1);
});
