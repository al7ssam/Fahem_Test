/**
 * Plan F (A/B quality signals): failure patterns by promptVariant over a window.
 * Plan D hint: surface model_config reasoning vs refiner cost.
 * Usage: npx tsx server/scripts/aiFactoryQualitySignals.ts [days=14]
 */
import { getPool, closePool } from "../db/pool";

type Row = {
  variant: string;
  jobs_total: string;
  succeeded: string;
  failed: string;
  truncated: string;
  json_fail: string;
};

async function main(): Promise<void> {
  const days = Math.max(1, Number(process.argv[2] ?? 14) || 14);
  const pool = getPool();

  const r = await pool.query<Row>(
    `SELECT
       COALESCE(NULLIF(result_summary->>'promptVariant', ''), NULLIF(payload->>'promptVariant', ''), 'baseline') AS variant,
       COUNT(*)::text AS jobs_total,
       COUNT(*) FILTER (WHERE status = 'succeeded')::text AS succeeded,
       COUNT(*) FILTER (WHERE status = 'failed')::text AS failed,
       COUNT(*) FILTER (WHERE COALESCE(last_error, '') ILIKE '%layer_output_truncated_max_tokens%')::text AS truncated,
       COUNT(*) FILTER (WHERE COALESCE(last_error, '') ILIKE '%invalid_json%')::text AS json_fail
     FROM ai_factory_jobs
     WHERE created_at >= NOW() - ($1::text || ' days')::interval
     GROUP BY 1
     ORDER BY 1`,
    [days],
  );

  console.log(JSON.stringify({ windowDays: days, byVariant: r.rows }, null, 2));

  const cfg = await pool.query<{ layer_name: string; reasoning_level: string; max_output_tokens: number }>(
    `SELECT layer_name, reasoning_level, max_output_tokens FROM ai_factory_model_config ORDER BY layer_name`,
  );
  const refiner = cfg.rows.find((x) => x.layer_name === "refiner");
  if (refiner && refiner.reasoning_level !== "none") {
    console.log(
      `\nPlan D note: refiner layer uses reasoning_level=${refiner.reasoning_level} — hidden thoughts can dominate usage on Gemini 3; consider "none" if JSON patch stability is the priority.`,
    );
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
