/**
 * يطبّق ملفات db/migrations/*.sql بالترتيب، مرة واحدة لكل ملف، عبر جدول schema_migrations.
 *
 * ترقية من السلوك القديم (تشغيل كل الملفات في كل مرة):
 * - على قاعدة كانت متزامنة مع الكود وتريد تفعيل التتبع دون إعادة تنفيذ SQL:
 *   FAHEM_MIGRATE_BASELINE=1 npm run db:migrate
 *   (مرة واحدة فقط؛ يسجّل أسماء كل ملفات الترحيل الحالية دون تشغيلها.)
 */
import fs from "fs";
import path from "path";
import { getPool, closePool } from "../db/pool";
import { config } from "../config";

async function ensureMigrationsTable(pool: ReturnType<typeof getPool>): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function isMigrationApplied(
  pool: ReturnType<typeof getPool>,
  filename: string,
): Promise<boolean> {
  const r = await pool.query<{ one: number }>(
    `SELECT 1 AS one FROM schema_migrations WHERE filename = $1 LIMIT 1`,
    [filename],
  );
  return r.rowCount !== null && r.rowCount > 0;
}

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is required for migrations");
    process.exit(1);
  }
  const pool = getPool();
  await ensureMigrationsTable(pool);

  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const baseline =
    process.env.FAHEM_MIGRATE_BASELINE === "1" || process.env.FAHEM_MIGRATE_BASELINE === "true";
  if (baseline) {
    for (const file of files) {
      await pool.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING`,
        [file],
      );
      console.log("Baseline recorded:", file);
    }
    await closePool();
    console.log("Baseline complete. SQL files were not executed.");
    return;
  }

  for (const file of files) {
    if (await isMigrationApplied(pool, file)) {
      console.log("Skipping (already applied):", file);
      continue;
    }
    const migrationPath = path.join(migrationsDir, file);
    const raw = fs.readFileSync(migrationPath, "utf8");
    const sql = raw.replace(/^\uFEFF/, "");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log("Migration applied:", migrationPath);
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback errors */
      }
      console.error("Migration failed:", migrationPath);
      throw e;
    } finally {
      client.release();
    }
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
