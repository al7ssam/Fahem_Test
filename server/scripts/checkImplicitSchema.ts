import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const TARGET_DIRS = [
  path.join(ROOT, "server"),
];
const ALLOWED_EXT = new Set([".ts", ".sql"]);
const IGNORE_SEGMENTS = [
  `${path.sep}node_modules${path.sep}`,
  `${path.sep}dist${path.sep}`,
  `${path.sep}.cursor${path.sep}`,
];
const TABLES = [
  "app_settings",
  "questions",
  "question_main_categories",
  "question_subcategories",
  "question_study_cards",
  "game_result_copy",
  "lesson_categories",
  "lesson_items",
  "lesson_sections",
  "lessons",
  "ai_factory_jobs",
  "ai_factory_job_logs",
  "ai_factory_inspection_logs",
  "ai_factory_model_config",
  "ai_factory_pipeline_state",
  "ai_usage_logs",
  "simple_content_automation",
  "simple_content_model_presets",
  "simple_content_pricing_audit_logs",
  "simple_content_prompts",
  "simple_content_runs",
  "schema_migrations",
];
const CLAUSE_RE = new RegExp(
  `\\b(FROM|JOIN|UPDATE|INSERT\\s+INTO|DELETE\\s+FROM|ALTER\\s+TABLE|CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?)\\s+((public\\.)?(${TABLES.join("|")}))\\b`,
  "gi",
);

type Finding = {
  file: string;
  line: number;
  sqlClause: string;
  table: string;
  snippet: string;
};

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (IGNORE_SEGMENTS.some((segment) => full.includes(segment))) continue;
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!ALLOWED_EXT.has(path.extname(entry.name))) continue;
    out.push(full);
  }
}

function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function findImplicitSchemaSql(file: string): Finding[] {
  const text = fs.readFileSync(file, "utf8");
  const findings: Finding[] = [];
  for (const match of text.matchAll(CLAUSE_RE)) {
    const clause = (match[1] ?? "").toUpperCase();
    const table = (match[2] ?? "").trim();
    const hasPublicPrefix = Boolean(match[3]);
    if (!table || hasPublicPrefix) continue;
    const idx = match.index ?? 0;
    const line = lineForIndex(text, idx);
    const snippet = text.split("\n")[line - 1]?.trim() ?? "";
    findings.push({
      file: path.relative(ROOT, file).replaceAll("\\", "/"),
      line,
      sqlClause: clause,
      table,
      snippet,
    });
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const dir of TARGET_DIRS) {
    if (fs.existsSync(dir)) walk(dir, files);
  }
  const findings = files.flatMap(findImplicitSchemaSql);
  if (findings.length === 0) {
    console.log("[check-implicit-schema] OK: no implicit schema usage found.");
    return;
  }

  console.error(`[check-implicit-schema] FAILED: ${findings.length} implicit SQL references found.`);
  for (const f of findings.slice(0, 200)) {
    console.error(`- ${f.file}:${f.line} ${f.sqlClause} ${f.table}`);
    console.error(`  ${f.snippet}`);
  }
  if (findings.length > 200) {
    console.error(`... and ${findings.length - 200} more`);
  }
  process.exit(1);
}

main();
