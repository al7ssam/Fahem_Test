/**
 * One-off: connect to admin DB (postgres) and create fahem_rollback_bd65b8b if missing.
 * Run: npx tsx server/scripts/ensureRollbackDb.ts
 */
import path from "path";
import dotenv from "dotenv";
import { Client } from "pg";

const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "../../.env"),
];
for (const p of envCandidates) {
  const r = dotenv.config({ path: p });
  if (!r.error && process.env.DATABASE_URL) break;
}

const NEW_DB = "fahem_rollback_bd65b8b";

function parseDbUrl(raw: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(raw.replace(/^postgres(ql)?:\/\//, "http://"));
  const db = (u.pathname || "").replace(/^\//, "") || "postgres";
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: db,
  };
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL missing");
    process.exit(1);
  }
  const base = parseDbUrl(dbUrl);
  const useSsl = base.host !== "localhost" && base.host !== "127.0.0.1";
  const client = new Client({
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    database: "postgres",
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [NEW_DB]);
  if (exists.rows.length) {
    console.log("DB_EXISTS", NEW_DB);
  } else {
    await client.query(`CREATE DATABASE "${NEW_DB.replace(/"/g, "")}"`);
    console.log("DB_CREATED", NEW_DB);
  }
  await client.end();
}

main().catch((e) => {
  console.error("CREATE_DB_FAILED", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
