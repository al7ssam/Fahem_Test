import { getPool, closePool } from "../db/pool";
import type { FactoryLayer, FactoryReasoningLevel } from "../services/aiFactory/types";

const TARGET_REASONING: Record<FactoryLayer, FactoryReasoningLevel> = {
  architect: "low",
  creator: "low",
  auditor: "none",
  refiner: "none",
};

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const pool = getPool();

  const current = await pool.query<{
    layer_name: FactoryLayer;
    reasoning_level: FactoryReasoningLevel;
  }>(
    `SELECT layer_name, reasoning_level
     FROM ai_factory_model_config
     ORDER BY layer_name`,
  );

  const changes = current.rows
    .map((row) => ({
      layer: row.layer_name,
      from: row.reasoning_level,
      to: TARGET_REASONING[row.layer_name],
    }))
    .filter((x) => x.from !== x.to);

  if (!changes.length) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          changed: 0,
          changes: [],
          measurementHint: {
            baselineScript: "tsx server/scripts/aiFactoryBaselineMetrics.ts 7 [subcategory_key?] [--with-inspection-tokens]",
            abReportScript: "tsx server/scripts/aiFactoryAbReport.ts 7 [subcategory_key?]",
            note: "بعد تغيير reasoning_level قارن total/thoughts عبر --with-inspection-tokens ثم ab-report لنفس النافذة والفئة.",
          },
        },
        null,
        2,
      ),
    );
    await closePool();
    return;
  }

  if (!dryRun) {
    await pool.query(
      `UPDATE ai_factory_model_config
       SET reasoning_level = CASE layer_name
         WHEN 'architect' THEN $1
         WHEN 'creator' THEN $2
         WHEN 'auditor' THEN $3
         WHEN 'refiner' THEN $4
         ELSE reasoning_level
       END,
       updated_at = NOW()
       WHERE layer_name IN ('architect', 'creator', 'auditor', 'refiner')`,
      [
        TARGET_REASONING.architect,
        TARGET_REASONING.creator,
        TARGET_REASONING.auditor,
        TARGET_REASONING.refiner,
      ],
    );
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        changed: changes.length,
        changes,
        measurementHint: {
          baselineScript: "tsx server/scripts/aiFactoryBaselineMetrics.ts 7 [subcategory_key?] [--with-inspection-tokens]",
          abReportScript: "tsx server/scripts/aiFactoryAbReport.ts 7 [subcategory_key?]",
          envCaps: "AI_FACTORY_REASONING_POLICY_MODE و AI_FACTORY_REASONING_CAP_<LAYER> في modelManager",
        },
      },
      null,
      2,
    ),
  );
  await closePool();
}

main().catch(async (error) => {
  console.error("reasoning_tune_failed", error instanceof Error ? error.message : String(error));
  await closePool().catch(() => undefined);
  process.exit(1);
});
