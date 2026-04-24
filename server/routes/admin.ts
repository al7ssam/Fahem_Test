import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { config } from "../config";
import { getPool } from "../db/pool";

const studyCardBodySchema = z.object({
  body: z.string().trim().min(1).max(50_000),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
});

const questionBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(500)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  difficulty: z.string().trim().max(32).optional(),
  studyCards: z.array(studyCardBodySchema).max(100).optional(),
});

const studyCardImportRowSchema = z.object({
  body: z.string().trim().min(1).max(50_000),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const importItemSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    options: z.array(z.string().trim().min(1).max(500)).length(4),
    correctIndex: z.number().int().min(0).max(3).optional(),
    correct_index: z.number().int().min(0).max(3).optional(),
    difficulty: z.string().trim().max(32).optional(),
    studyCards: z.array(studyCardImportRowSchema).max(100).optional(),
  })
  .refine((d) => d.correctIndex !== undefined || d.correct_index !== undefined, {
    message: "correctIndex or correct_index required",
  })
  .transform((d) => ({
    prompt: d.prompt,
    options: d.options,
    correctIndex: (d.correctIndex ?? d.correct_index) as number,
    difficulty: d.difficulty,
    studyCards: (d.studyCards ?? []).map((c, idx) => ({
      body: c.body,
      sortOrder: c.sort_order ?? c.sortOrder ?? idx,
    })),
  }));

const importArraySchema = z.array(importItemSchema).min(1).max(200);

async function insertStudyCardsForQuestion(
  client: PoolClient,
  questionId: number,
  cards: Array<{ body: string; sortOrder: number }>,
): Promise<void> {
  for (const c of cards) {
    await client.query(
      `INSERT INTO question_study_cards (question_id, body, sort_order)
       VALUES ($1, $2, $3)`,
      [questionId, c.body, c.sortOrder],
    );
  }
}

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

function verifyAdmin(req: Request, res: Response): boolean {
  if (!config.adminSecret) {
    res
      .status(503)
      .json({ ok: false, error: "admin_secret_not_configured" });
    return false;
  }
  const provided = String(req.header("x-admin-secret") ?? "").trim();
  if (!timingSafeEqualString(provided, config.adminSecret)) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return false;
  }
  return true;
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

function extractQuestionsArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.questions)) return o.questions;
    if (Array.isArray(o.items)) return o.items;
    if (typeof o.prompt === "string" && Array.isArray(o.options)) {
      return [body];
    }
  }
  return null;
}

function zodIssuesSummary(err: z.ZodError, limit = 5): Array<{ path: string; message: string }> {
  return err.errors.slice(0, limit).map((e) => ({
    path: e.path.join("."),
    message: e.message,
  }));
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
    if (!verifyAdmin(req, res)) return;

    const parsed = questionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }

    const { prompt, options, correctIndex, difficulty, studyCards } = parsed.data;

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ins = await client.query<{ id: number }>(
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
      if (id != null && studyCards && studyCards.length > 0) {
        const normalized = studyCards.map((c, idx) => ({
          body: c.body,
          sortOrder: c.sortOrder ?? c.sort_order ?? idx,
        }));
        await insertStudyCardsForQuestion(client, id, normalized);
      }
      await client.query("COMMIT");
      const total = await countQuestions();
      res.status(201).json({
        ok: true,
        id,
        totalQuestions: total ?? undefined,
      });
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      res.status(500).json({ ok: false, error: "insert_failed" });
    } finally {
      client.release();
    }
  });

  app.post("/api/admin/questions/import", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;

    const rawList = extractQuestionsArray(req.body);
    if (!rawList) {
      res.status(400).json({
        ok: false,
        error: "invalid_shape",
        message:
          "Body must be a JSON array, { \"questions\": [...] }, { \"items\": [...] }, or one question object with prompt + options",
      });
      return;
    }

    const parsed = importArraySchema.safeParse(rawList);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_questions",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }

    const rows = parsed.data;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO questions (prompt, options, correct_index, difficulty)
           VALUES ($1, $2::jsonb, $3, $4)
           RETURNING id`,
          [
            row.prompt,
            JSON.stringify(row.options),
            row.correctIndex,
            row.difficulty ?? null,
          ],
        );
        const qid = ins.rows[0]?.id;
        if (qid != null && row.studyCards.length > 0) {
          await insertStudyCardsForQuestion(client, qid, row.studyCards);
        }
      }
      await client.query("COMMIT");
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      res.status(500).json({ ok: false, error: "import_failed" });
      return;
    } finally {
      client.release();
    }

    const total = await countQuestions();
    res.status(201).json({
      ok: true,
      inserted: rows.length,
      totalQuestions: total ?? undefined,
    });
  });
}
