import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { getPool } from "../db/pool";

const questionBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(500)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  difficulty: z.string().trim().max(32).optional(),
});

function timingSafeEqualString(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function adminTemplatePath(): string {
  return path.join(process.cwd(), "server", "templates", "admin.html");
}

async function countQuestions(): Promise<number | null> {
  try {
    const pool = getPool();
    const r = await pool.query<{ c: string }>(
      "SELECT COUNT(*)::text AS c FROM questions",
    );
    return Number(r.rows[0]?.c ?? 0);
  } catch {
    return null;
  }
}

function readAdminHtml(questionCount: number | null): string {
  const raw = fs.readFileSync(adminTemplatePath(), "utf8");
  const display = questionCount === null ? "—" : String(questionCount);
  return raw.replace(/\{\{QUESTION_COUNT\}\}/g, display);
}

export function registerAdminRoutes(app: Express): void {
  app.get("/admin", async (_req: Request, res: Response) => {
    try {
      const total = await countQuestions();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(readAdminHtml(total));
    } catch {
      res.status(500).send("تعذر تحميل صفحة الإدارة.");
    }
  });

  app.get("/api/admin/question-count", async (_req: Request, res: Response) => {
    const total = await countQuestions();
    if (total === null) {
      res.status(503).json({ ok: false, error: "db_unavailable" });
      return;
    }
    res.json({ ok: true, totalQuestions: total });
  });

  app.post("/api/admin/questions", async (req: Request, res: Response) => {
    if (!config.adminSecret) {
      res
        .status(503)
        .json({ ok: false, error: "admin_secret_not_configured" });
      return;
    }

    const provided = String(req.header("x-admin-secret") ?? "").trim();
    if (!timingSafeEqualString(provided, config.adminSecret)) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const parsed = questionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }

    const { prompt, options, correctIndex, difficulty } = parsed.data;

    try {
      const pool = getPool();
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO questions (prompt, options, correct_index, difficulty)
         VALUES ($1, $2::jsonb, $3, $4)
         RETURNING id`,
        [
          prompt,
          JSON.stringify(options),
          correctIndex,
          difficulty ?? null,
        ],
      );
      const id = ins.rows[0]?.id;
      const total = await countQuestions();
      res.status(201).json({
        ok: true,
        id,
        totalQuestions: total ?? undefined,
      });
    } catch {
      res.status(500).json({ ok: false, error: "insert_failed" });
    }
  });
}
