/**
 * Plan: measure-baseline — sample ai_factory_inspection_logs for prompt size and truncation signals.
 * Usage: npx tsx server/scripts/aiFactoryInspectionPromptStats.ts [limit=200]
 */
import { getPool, closePool } from "../db/pool";
import { extractGeminiFinishReason } from "../services/aiFactory/modelManager";

type Row = {
  id: string;
  job_id: string;
  layer_name: string;
  prompt_chars: string;
  raw_response_text: string;
  created_at: string;
};

async function main(): Promise<void> {
  const limit = Math.max(1, Math.min(5000, Number(process.argv[2] ?? 200) || 200));
  const pool = getPool();
  const r = await pool.query<Row>(
    `SELECT id::text, job_id::text, layer_name,
            length(prompt_text)::text AS prompt_chars,
            raw_response_text,
            created_at::text
     FROM ai_factory_inspection_logs
     ORDER BY id DESC
     LIMIT $1`,
    [limit],
  );

  const byLayer: Record<string, { count: number; sumChars: number; maxChars: number; maxTokens: number }> = {};
  let maxTokensCount = 0;

  for (const row of r.rows) {
    const fr = extractGeminiFinishReason(row.raw_response_text);
    if (fr === "MAX_TOKENS") maxTokensCount += 1;

    const chars = Number(row.prompt_chars) || 0;
    const L = row.layer_name;
    if (!byLayer[L]) byLayer[L] = { count: 0, sumChars: 0, maxChars: 0, maxTokens: 0 };
    byLayer[L].count += 1;
    byLayer[L].sumChars += chars;
    byLayer[L].maxChars = Math.max(byLayer[L].maxChars, chars);
    if (fr === "MAX_TOKENS") byLayer[L].maxTokens += 1;
  }

  console.log(JSON.stringify({ sampleSize: r.rows.length, limit, maxTokensInSample: maxTokensCount }, null, 2));
  console.log("By layer (avg prompt chars, max, MAX_TOKENS count):");
  for (const [layer, agg] of Object.entries(byLayer).sort()) {
    const avg = agg.count ? Math.round(agg.sumChars / agg.count) : 0;
    console.log(`  ${layer}: n=${agg.count} avgChars=${avg} maxChars=${agg.maxChars} maxTokens=${agg.maxTokens}`);
  }

  console.log("\nLast 15 rows: id, job_id, layer, prompt_chars, finishReason");
  for (const row of r.rows.slice(0, 15)) {
    const fr = extractGeminiFinishReason(row.raw_response_text);
    console.log([row.id, row.job_id, row.layer_name, row.prompt_chars, fr ?? "-"].join("\t"));
  }

  const cfg = await pool.query<{ layer_name: string; reasoning_level: string; max_output_tokens: number }>(
    `SELECT layer_name, reasoning_level, max_output_tokens FROM ai_factory_model_config ORDER BY layer_name`,
  );
  console.log("\nModel config (reasoning / max_output_tokens):");
  for (const c of cfg.rows) {
    console.log(`  ${c.layer_name}: reasoning=${c.reasoning_level} max_out=${c.max_output_tokens}`);
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
