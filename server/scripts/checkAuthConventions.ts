import fs from "fs";
import path from "path";

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
  if (issues.length === 0) {
    console.log("[auth:check-conventions] OK");
    return;
  }
  console.error(`[auth:check-conventions] FAILED (${issues.length})`);
  for (const issue of issues.slice(0, 200)) {
    console.error(`- ${issue.file}:${issue.line} ${issue.message}`);
    console.error(`  ${issue.snippet}`);
  }
  process.exit(1);
}

main();
