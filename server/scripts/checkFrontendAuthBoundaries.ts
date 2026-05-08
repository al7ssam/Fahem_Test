import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CLIENT_DIR = path.join(ROOT, "client", "src");
const AUTH_DIR = path.join(CLIENT_DIR, "auth");
const INCLUDE_EXT = new Set([".ts"]);

type Issue = { file: string; line: number; message: string; snippet: string };

function walk(dir: string, out: string[]): void {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (full.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (item.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!INCLUDE_EXT.has(path.extname(item.name))) continue;
    out.push(full);
  }
}

function scanFile(filePath: string): Issue[] {
  if (filePath.startsWith(AUTH_DIR)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const issues: Issue[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const normalized = line.toLowerCase();
    if (normalized.includes("from \"firebase/") || normalized.includes("from 'firebase/")) {
      issues.push({
        file: path.relative(ROOT, filePath).replaceAll("\\", "/"),
        line: i + 1,
        message: "Firebase imports are allowed only inside client/src/auth/*",
        snippet: line.trim(),
      });
    }
  }
  return issues;
}

function main(): void {
  const files: string[] = [];
  walk(CLIENT_DIR, files);
  const issues = files.flatMap(scanFile);
  if (issues.length === 0) {
    console.log("[auth:check-client-boundaries] OK");
    return;
  }
  console.error(`[auth:check-client-boundaries] FAILED (${issues.length})`);
  for (const issue of issues) {
    console.error(`- ${issue.file}:${issue.line} ${issue.message}`);
    console.error(`  ${issue.snippet}`);
  }
  process.exit(1);
}

main();
