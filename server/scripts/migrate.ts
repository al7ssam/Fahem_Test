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
  const migrationPath = path.join(
    process.cwd(),
    "db",
    "migrations",
    "001_questions.sql",
  );
  const sql = fs.readFileSync(migrationPath, "utf8");
  await pool.query(sql);
  console.log("Migration applied:", migrationPath);
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
