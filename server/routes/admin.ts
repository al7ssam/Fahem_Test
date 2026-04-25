import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { getPool } from "../db/pool";
import { getResultMessages } from "../db/resultCopy";

const questionBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(500)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  difficulty: z.string().trim().max(32).optional(),
  studyBody: z.string().max(50_000).optional(),
  study_body: z.string().max(50_000).optional(),
});

const importItemSchema = z
  .object({
    prompt: z.string().trim().min(1).max(2000),
    options: z.array(z.string().trim().min(1).max(500)).length(4),
    correctIndex: z.number().int().min(0).max(3).optional(),
    correct_index: z.number().int().min(0).max(3).optional(),
    difficulty: z.string().trim().max(32).optional(),
    studyBody: z.string().max(50_000).optional(),
    study_body: z.string().max(50_000).optional(),
  })
  .refine((d) => d.correctIndex !== undefined || d.correct_index !== undefined, {
    message: "correctIndex or correct_index required",
  })
  .transform((d) => ({
    prompt: d.prompt,
    options: d.options,
    correctIndex: (d.correctIndex ?? d.correct_index) as number,
    difficulty: d.difficulty,
    studyBody: (d.studyBody ?? d.study_body)?.trim() || null,
  }));

const importArraySchema = z.array(importItemSchema).min(1).max(200);

const resultMessagesPatchSchema = z.object({
  winnerText: z.string().trim().min(1).max(500),
  loserText: z.string().trim().min(1).max(500),
  tieText: z.string().trim().min(1).max(500),
});

const aiPromptsPatchSchema = z.object({
  promptDirect: z.string().trim().min(20).max(12_000),
  promptStudy: z.string().trim().min(20).max(12_000),
});

const gameSettingsPatchSchema = z.object({
  maxStudyRounds: z.number().int().min(1).max(10),
  studyRoundQuestionCount: z.number().int().min(1).max(30),
  studyPhaseMs: z.number().int().min(5000).max(300000),
  maxPlayersPerMatch: z.number().int().min(2).max(100),
  matchFillWindowSeconds: z.number().int().min(1).max(120),
});

const keysSettingsPatchSchema = z.object({
  keysStreakPerKey: z.number().int().min(1).max(50),
  keysSmallStreakReward: z.number().int().min(0).max(50),
  keysMegaStreak: z.number().int().min(1).max(50),
  keysMegaReward: z.number().int().min(0).max(50),
  keysMaxPerPlayer: z.number().int().min(1).max(100),
  keysSkillBoostPercent: z.number().int().min(1).max(200),
  keysSkillBoostMaxMultiplier: z.number().min(1).max(5),
  keysHeartAttackCost: z.number().int().min(1).max(20),
  keysShieldCost: z.number().int().min(1).max(20),
  keysRevealCost: z.number().int().min(1).max(20),
  keysRevealQuestionsDirect: z.number().int().min(0).max(30),
  keysRevealQuestionsStudy: z.number().int().min(0).max(30),
  keysDropRate: z.number().min(0).max(5),
  abilitySkillBoostDirectEnabled: z.boolean(),
  abilitySkillBoostStudyEnabled: z.boolean(),
  abilitySkipDirectEnabled: z.boolean(),
  abilitySkipStudyEnabled: z.boolean(),
  abilityAttackDirectEnabled: z.boolean(),
  abilityAttackStudyEnabled: z.boolean(),
  abilityRevealDirectEnabled: z.boolean(),
  abilityRevealStudyEnabled: z.boolean(),
});

const questionPatchSchema = z.object({
  prompt: z.string().trim().min(1).max(2000).optional(),
  options: z.array(z.string().trim().min(1).max(500)).length(4).optional(),
  correctIndex: z.number().int().min(0).max(3).optional(),
  correct_index: z.number().int().min(0).max(3).optional(),
  difficulty: z.string().trim().max(32).nullable().optional(),
  studyBody: z.string().max(50_000).nullable().optional(),
  study_body: z.string().max(50_000).nullable().optional(),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
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

function mergedStudyBody(data: {
  studyBody?: string | null;
  study_body?: string | null;
}): string | null {
  const v = data.studyBody ?? data.study_body;
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length === 0 ? null : t;
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

  app.get("/api/admin/questions/stats", async (_req: Request, res: Response) => {
    if (!verifyAdmin(_req, res)) return;
    try {
      const pool = getPool();
      const r = await pool.query<{
        total: string;
        with_study: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM questions) AS total,
           (SELECT COUNT(*)::text FROM questions
            WHERE study_body IS NOT NULL AND btrim(study_body) <> '') AS with_study`,
      );
      const total = Number(r.rows[0]?.total ?? 0);
      const withStudy = Number(r.rows[0]?.with_study ?? 0);
      res.json({
        ok: true,
        totalQuestions: total,
        withStudyCards: withStudy,
        withoutStudyCards: Math.max(0, total - withStudy),
      });
    } catch {
      res.status(500).json({ ok: false, error: "stats_failed" });
    }
  });

  app.get("/api/admin/result-messages", async (_req: Request, res: Response) => {
    if (!verifyAdmin(_req, res)) return;
    try {
      const pool = getPool();
      const m = await getResultMessages(pool);
      res.json({
        ok: true,
        winnerText: m.winner,
        loserText: m.loser,
        tieText: m.tie,
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.patch("/api/admin/result-messages", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = resultMessagesPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    const { winnerText, loserText, tieText } = parsed.data;
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE game_result_copy
         SET winner_text = $1, loser_text = $2, tie_text = $3
         WHERE id = 1`,
        [winnerText, loserText, tieText],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.get("/api/admin/ai-prompts", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const rows = await pool.query<{ key: string; value: string }>(
        `SELECT key, value
         FROM app_settings
         WHERE key IN ('prompt_direct', 'prompt_study')`,
      );
      const map = new Map(rows.rows.map((r) => [r.key, r.value]));
      res.json({
        ok: true,
        promptDirect: map.get("prompt_direct") ?? "",
        promptStudy: map.get("prompt_study") ?? "",
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.patch("/api/admin/ai-prompts", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = aiPromptsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO app_settings (key, value)
         VALUES ('prompt_direct', $1), ('prompt_study', $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [parsed.data.promptDirect, parsed.data.promptStudy],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.get("/api/admin/game-settings", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const rows = await pool.query<{ key: string; value: string }>(
        `SELECT key, value
         FROM app_settings
         WHERE key IN ('game_max_study_rounds', 'game_study_round_size', 'game_study_phase_ms', 'max_players_per_match', 'match_fill_window_seconds')`,
      );
      const map = new Map(rows.rows.map((r) => [r.key, r.value]));
      const maxStudyRounds = Number(map.get("game_max_study_rounds") ?? "3");
      const studyRoundQuestionCount = Number(map.get("game_study_round_size") ?? "8");
      const studyPhaseMs = Number(map.get("game_study_phase_ms") ?? "60000");
      const maxPlayersRaw = Number(map.get("max_players_per_match") ?? "10");
      const maxPlayersPerMatch = Math.min(
        100,
        Math.max(2, Number.isFinite(maxPlayersRaw) ? maxPlayersRaw : 10),
      );
      const fillRaw = Number(map.get("match_fill_window_seconds") ?? "5");
      const matchFillWindowSeconds = Math.min(
        120,
        Math.max(1, Number.isFinite(fillRaw) ? fillRaw : 5),
      );
      res.json({
        ok: true,
        maxStudyRounds,
        studyRoundQuestionCount,
        studyPhaseMs,
        maxPlayersPerMatch,
        matchFillWindowSeconds,
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.patch("/api/admin/game-settings", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = gameSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO app_settings (key, value)
         VALUES
           ('game_max_study_rounds', $1),
           ('game_study_round_size', $2),
           ('game_study_phase_ms', $3),
           ('max_players_per_match', $4),
           ('match_fill_window_seconds', $5)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          String(parsed.data.maxStudyRounds),
          String(parsed.data.studyRoundQuestionCount),
          String(parsed.data.studyPhaseMs),
          String(parsed.data.maxPlayersPerMatch),
          String(parsed.data.matchFillWindowSeconds),
        ],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.get("/api/admin/keys-settings", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const keys = [
      "keys_streak_per_key",
      "keys_small_streak_reward",
      "keys_mega_streak",
      "keys_mega_reward",
      "keys_max_per_player",
      "keys_skill_boost_percent",
      "keys_skill_boost_max_multiplier",
      "keys_heart_attack_cost",
      "keys_shield_cost",
      "keys_reveal_cost",
      "keys_reveal_questions_direct",
      "keys_reveal_questions_study",
      "keys_drop_rate",
      "ability_skill_boost_direct_enabled",
      "ability_skill_boost_study_enabled",
      "ability_skip_direct_enabled",
      "ability_skip_study_enabled",
      "ability_attack_direct_enabled",
      "ability_attack_study_enabled",
      "ability_reveal_direct_enabled",
      "ability_reveal_study_enabled",
    ] as const;
    try {
      const pool = getPool();
      const rows = await pool.query<{ key: string; value: string }>(
        `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
        [keys],
      );
      const map = new Map(rows.rows.map((r) => [r.key, r.value]));
      const num = (k: string, d: string) => Number(map.get(k) ?? d);
      res.json({
        ok: true,
        keysStreakPerKey: Math.min(50, Math.max(1, num("keys_streak_per_key", "5"))),
        keysSmallStreakReward: Math.min(50, Math.max(0, num("keys_small_streak_reward", "1"))),
        keysMegaStreak: Math.min(50, Math.max(1, num("keys_mega_streak", "8"))),
        keysMegaReward: Math.min(50, Math.max(0, num("keys_mega_reward", "5"))),
        keysMaxPerPlayer: Math.min(100, Math.max(1, num("keys_max_per_player", "20"))),
        keysSkillBoostPercent: Math.min(200, Math.max(1, num("keys_skill_boost_percent", "30"))),
        keysSkillBoostMaxMultiplier: Math.min(5, Math.max(1, num("keys_skill_boost_max_multiplier", "3"))),
        keysHeartAttackCost: Math.min(20, Math.max(1, num("keys_heart_attack_cost", "2"))),
        keysShieldCost: Math.min(20, Math.max(1, num("keys_shield_cost", "2"))),
        keysRevealCost: Math.min(20, Math.max(1, num("keys_reveal_cost", "2"))),
        keysRevealQuestionsDirect: Math.min(30, Math.max(0, Math.floor(num("keys_reveal_questions_direct", "4")))),
        keysRevealQuestionsStudy: Math.min(30, Math.max(0, Math.floor(num("keys_reveal_questions_study", "4")))),
        keysDropRate: Math.min(5, Math.max(0, num("keys_drop_rate", "1"))),
        abilitySkillBoostDirectEnabled: String(map.get("ability_skill_boost_direct_enabled") ?? "1").trim() !== "0",
        abilitySkillBoostStudyEnabled: String(map.get("ability_skill_boost_study_enabled") ?? "1").trim() !== "0",
        abilitySkipDirectEnabled: String(map.get("ability_skip_direct_enabled") ?? "1").trim() !== "0",
        abilitySkipStudyEnabled: String(map.get("ability_skip_study_enabled") ?? "1").trim() !== "0",
        abilityAttackDirectEnabled: String(map.get("ability_attack_direct_enabled") ?? "1").trim() !== "0",
        abilityAttackStudyEnabled: String(map.get("ability_attack_study_enabled") ?? "1").trim() !== "0",
        abilityRevealDirectEnabled: String(map.get("ability_reveal_direct_enabled") ?? "1").trim() !== "0",
        abilityRevealStudyEnabled: String(map.get("ability_reveal_study_enabled") ?? "1").trim() !== "0",
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.patch("/api/admin/keys-settings", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = keysSettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    const d = parsed.data;
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES
           ('keys_streak_per_key', $1),
           ('keys_small_streak_reward', $2),
           ('keys_mega_streak', $3),
           ('keys_mega_reward', $4),
           ('keys_max_per_player', $5),
           ('keys_skill_boost_percent', $6),
           ('keys_skill_boost_max_multiplier', $7),
           ('keys_heart_attack_cost', $8),
           ('keys_shield_cost', $9),
           ('keys_reveal_cost', $10),
           ('keys_reveal_questions_direct', $11),
           ('keys_reveal_questions_study', $12),
           ('keys_drop_rate', $13),
           ('ability_skill_boost_direct_enabled', $14),
           ('ability_skill_boost_study_enabled', $15),
           ('ability_skip_direct_enabled', $16),
           ('ability_skip_study_enabled', $17),
           ('ability_attack_direct_enabled', $18),
           ('ability_attack_study_enabled', $19),
           ('ability_reveal_direct_enabled', $20),
           ('ability_reveal_study_enabled', $21)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [
          String(d.keysStreakPerKey),
          String(d.keysSmallStreakReward),
          String(d.keysMegaStreak),
          String(d.keysMegaReward),
          String(d.keysMaxPerPlayer),
          String(d.keysSkillBoostPercent),
          String(d.keysSkillBoostMaxMultiplier),
          String(d.keysHeartAttackCost),
          String(d.keysShieldCost),
          String(d.keysRevealCost),
          String(d.keysRevealQuestionsDirect),
          String(d.keysRevealQuestionsStudy),
          String(d.keysDropRate),
          d.abilitySkillBoostDirectEnabled ? "1" : "0",
          d.abilitySkillBoostStudyEnabled ? "1" : "0",
          d.abilitySkipDirectEnabled ? "1" : "0",
          d.abilitySkipStudyEnabled ? "1" : "0",
          d.abilityAttackDirectEnabled ? "1" : "0",
          d.abilityAttackStudyEnabled ? "1" : "0",
          d.abilityRevealDirectEnabled ? "1" : "0",
          d.abilityRevealStudyEnabled ? "1" : "0",
        ],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.get("/api/admin/questions", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const modeRaw = typeof req.query.mode === "string" ? req.query.mode.trim() : "all";
    const mode = modeRaw === "study" || modeRaw === "direct" ? modeRaw : "all";
    try {
      const pool = getPool();
      const params: unknown[] = [];
      const whereParts: string[] = [];
      if (q.length > 0) {
        params.push(`%${q}%`);
        whereParts.push(`prompt ILIKE $${params.length}`);
      }
      if (mode === "study") {
        whereParts.push(`study_body IS NOT NULL AND btrim(study_body) <> ''`);
      } else if (mode === "direct") {
        whereParts.push(`(study_body IS NULL OR btrim(study_body) = '')`);
      }
      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
      params.push(limit, offset);
      const limIdx = params.length - 1;
      const offIdx = params.length;
      const listSql = `
        SELECT id,
               LEFT(prompt, 160) AS prompt_preview,
               (study_body IS NOT NULL AND btrim(study_body) <> '') AS has_study
        FROM questions
        ${where}
        ORDER BY id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}
      `;
      const list = await pool.query<{
        id: number;
        prompt_preview: string;
        has_study: boolean;
      }>(listSql, params);

      const countSql = `SELECT COUNT(*)::text AS c FROM questions ${where}`;
      const countParams = q.length > 0 ? [`%${q}%`] : [];
      const c = await pool.query<{ c: string }>(countSql, countParams);
      const total = Number(c.rows[0]?.c ?? 0);

      res.json({
        ok: true,
        items: list.rows.map((row) => ({
          id: row.id,
          promptPreview: row.prompt_preview,
          hasStudyCards: row.has_study,
        })),
        total,
        offset,
        limit,
      });
    } catch {
      res.status(500).json({ ok: false, error: "list_failed" });
    }
  });

  app.post("/api/admin/questions/bulk-delete", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM questions WHERE id = ANY($1::int[])`, [
        parsed.data.ids,
      ]);
      await client.query("COMMIT");
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      res.status(500).json({ ok: false, error: "bulk_delete_failed" });
      return;
    } finally {
      client.release();
    }
    const total = await countQuestions();
    res.json({ ok: true, deleted: parsed.data.ids.length, totalQuestions: total ?? undefined });
  });

  app.get("/api/admin/questions/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    try {
      const pool = getPool();
      const r = await pool.query<{
        id: number;
        prompt: string;
        options: unknown;
        correct_index: number;
        difficulty: string | null;
        study_body: string | null;
      }>(
        `SELECT id, prompt, options, correct_index, difficulty, study_body
         FROM questions WHERE id = $1`,
        [id],
      );
      const row = r.rows[0];
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const options = Array.isArray(row.options)
        ? (row.options as string[])
        : (JSON.parse(String(row.options)) as string[]);
      res.json({
        ok: true,
        question: {
          id: row.id,
          prompt: row.prompt,
          options,
          correctIndex: row.correct_index,
          difficulty: row.difficulty,
          studyBody: row.study_body ?? "",
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.patch("/api/admin/questions/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const parsed = questionPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: zodIssuesSummary(parsed.error),
      });
      return;
    }
    const d = parsed.data;
    const correctIdx = d.correctIndex ?? d.correct_index;
    try {
      const pool = getPool();
      const cur = await pool.query<{
        prompt: string;
        options: unknown;
        correct_index: number;
        difficulty: string | null;
        study_body: string | null;
      }>(
        `SELECT prompt, options, correct_index, difficulty, study_body FROM questions WHERE id = $1`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const nextPrompt = d.prompt ?? row.prompt;
      let nextOptions: string[];
      if (d.options) {
        nextOptions = d.options;
      } else {
        nextOptions = Array.isArray(row.options)
          ? (row.options as string[])
          : (JSON.parse(String(row.options)) as string[]);
      }
      const nextCorrect =
        correctIdx !== undefined ? correctIdx : row.correct_index;
      const nextDiff =
        d.difficulty !== undefined ? d.difficulty : row.difficulty;

      const rawBody = req.body as Record<string, unknown>;
      const studyPatchProvided =
        Object.prototype.hasOwnProperty.call(rawBody, "studyBody") ||
        Object.prototype.hasOwnProperty.call(rawBody, "study_body");
      let nextStudy = row.study_body;
      if (studyPatchProvided) {
        const raw = d.studyBody !== undefined ? d.studyBody : d.study_body;
        if (raw === null || raw === undefined) {
          nextStudy = null;
        } else {
          const t = String(raw).trim();
          nextStudy = t.length === 0 ? null : t;
        }
      }

      await pool.query(
        `UPDATE questions
         SET prompt = $1, options = $2::jsonb, correct_index = $3,
             difficulty = $4, study_body = $5
         WHERE id = $6`,
        [
          nextPrompt,
          JSON.stringify(nextOptions),
          nextCorrect,
          nextDiff,
          nextStudy,
          id,
        ],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.delete("/api/admin/questions/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    try {
      const pool = getPool();
      const r = await pool.query(`DELETE FROM questions WHERE id = $1`, [id]);
      if (r.rowCount === 0) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const total = await countQuestions();
      res.json({ ok: true, totalQuestions: total ?? undefined });
    } catch {
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
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

    const { prompt, options, correctIndex, difficulty } = parsed.data;
    const studyBody = mergedStudyBody(parsed.data as {
      studyBody?: string | null;
      study_body?: string | null;
    });

    try {
      const pool = getPool();
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body)
         VALUES ($1, $2::jsonb, $3, $4, $5)
         RETURNING id`,
        [
          prompt,
          JSON.stringify(options),
          correctIndex,
          difficulty ?? null,
          studyBody,
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
        await client.query(
          `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body)
           VALUES ($1, $2::jsonb, $3, $4, $5)`,
          [
            row.prompt,
            JSON.stringify(row.options),
            row.correctIndex,
            row.difficulty ?? null,
            row.studyBody,
          ],
        );
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
