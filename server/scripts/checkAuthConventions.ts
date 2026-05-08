import fs from "fs";
import path from "path";
import { Pool } from "pg";

const ROOT = process.cwd();
const SERVER_DIR = path.join(ROOT, "server");
const INCLUDE_EXT = new Set([".ts"]);
const IGNORE_SEGMENTS = [
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}dist${path.sep}`,
];

type Issue = { file: string; line: number; message: string; snippet: string };

function walk(dir: string, out: string[]): void {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (IGNORE_SEGMENTS.some((x) => full.includes(x))) continue;
    if (item.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!INCLUDE_EXT.has(path.extname(item.name))) continue;
    out.push(full);
  }
}

function scanFile(filePath: string): Issue[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const issues: Issue[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = line.toLowerCase();
    if (normalized.includes("x-admin-secret") && !filePath.endsWith("checkAuthConventions.ts")) {
      issues.push({
        file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
        line: i + 1,
        message: "Forbidden legacy admin guard header detected",
        snippet: line.trim(),
      });
    }
    if (
      (normalized.includes("firebase uid") || normalized.includes("firebase_uid")) &&
      !filePath.endsWith("checkAuthConventions.ts")
    ) {
      issues.push({
        file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
        line: i + 1,
        message: "Firebase UID must not be domain identity",
        snippet: line.trim(),
      });
    }
  }
  return issues;
}

function main(): void {
  const files: string[] = [];
  walk(SERVER_DIR, files);
  const issues = files.flatMap(scanFile);
  if (issues.length > 0) {
    console.error(`[auth:check-conventions] FAILED (${issues.length})`);
    for (const issue of issues.slice(0, 200)) {
      console.error(`- ${issue.file}:${issue.line} ${issue.message}`);
      console.error(`  ${issue.snippet}`);
    }
    process.exit(1);
  }
  console.log("[auth:check-conventions] static checks OK");
}

async function checkAuthSchemaContracts(): Promise<void> {
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    console.log("[auth:check-conventions] schema checks skipped (DATABASE_URL is empty)");
    return;
  }
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  try {
    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND (
           (table_name = 'user_sessions' AND column_name IN ('id', 'client_type', 'refresh_token_hash', 'csrf_token_hash', 'updated_at'))
           OR
           (table_name = 'auth_events' AND column_name IN ('event_type', 'session_id', 'ip_address', 'user_agent', 'metadata_json'))
         )`,
    );
    const keys = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
    const required = [
      "user_sessions.id",
      "user_sessions.client_type",
      "user_sessions.refresh_token_hash",
      "user_sessions.csrf_token_hash",
      "user_sessions.updated_at",
      "auth_events.event_type",
      "auth_events.session_id",
      "auth_events.ip_address",
      "auth_events.user_agent",
      "auth_events.metadata_json",
    ];
    const missing = required.filter((key) => !keys.has(key));
    if (missing.length > 0) {
      throw new Error(`Missing auth schema contract columns: ${missing.join(", ")}`);
    }
    console.log("[auth:check-conventions] schema checks OK");
  } finally {
    await pool.end();
  }
}

void (async () => {
  main();
  await checkAuthSchemaContracts();
})();
