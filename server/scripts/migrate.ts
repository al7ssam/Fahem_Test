import fs from "fs";
import path from "path";
import { getPool, closePool } from "../db/pool";
import { config } from "../config";

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is required for migrations");
    process.exit(1);
  }
  const pool = getPool();
  const migrationsDir = path.join(process.cwd(), "db", "migrations");
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const migrationPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(migrationPath, "utf8");
    await pool.query(sql);
    console.log("Migration applied:", migrationPath);
  }
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
