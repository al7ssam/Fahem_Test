import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { getPool } from "../db/pool";
import { getResultMessages } from "../db/resultCopy";
import { Match } from "../game/Match";

const questionBodySchema = z.object({
  prompt: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(500)).length(4),
  correctIndex: z.number().int().min(0).max(3),
  difficulty: z.string().trim().max(32).optional(),
  studyBody: z.string().max(50_000).optional(),
  study_body: z.string().max(50_000).optional(),
  subcategoryKey: z.string().trim().min(1).max(120).optional(),
  subcategory_key: z.string().trim().min(1).max(120).optional(),
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
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    subcategory_key: z.string().trim().min(1).max(120).optional(),
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
    subcategoryKey: (d.subcategoryKey ?? d.subcategory_key)?.trim() || null,
  }));

const importArraySchema = z.array(importItemSchema).min(1).max(200);

const resultMessagesPatchSchema = z.object({
  winnerTitle: z.string().trim().min(1).max(200),
  loserTitle: z.string().trim().min(1).max(200),
  tieTitle: z.string().trim().min(1).max(200),
  winnerText: z.string().trim().min(1).max(500),
  loserText: z.string().trim().min(1).max(500),
  tieText: z.string().trim().min(1).max(500),
});

const aiPromptsPatchSchema = z.object({
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
  subcategoryKey: z.string().trim().min(1).max(120).optional(),
  subcategory_key: z.string().trim().min(1).max(120).optional(),
});

const mainCategorySchema = z.object({
  mainKey: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(16).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

const subCategorySchema = z.object({
  mainCategoryId: z.number().int().positive(),
  subcategoryKey: z.string().trim().min(1).max(120),
  nameAr: z.string().trim().min(1).max(120),
  icon: z.string().trim().min(1).max(16).optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});

const categoriesBulkSchema = z.object({
  target: z.enum(["main", "sub"]),
  action: z.enum(["activate", "deactivate", "delete"]),
  ids: z.array(z.number().int().positive()).min(1).max(500),
  dryRun: z.boolean().optional(),
});

const categoriesReorderSchema = z.object({
  target: z.enum(["main", "sub"]),
  items: z.array(
    z.object({
      id: z.number().int().positive(),
      sortOrder: z.number().int().min(0).max(100000),
    }),
  ).min(1).max(1000),
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

async function readCategoriesTree(pool: ReturnType<typeof getPool>): Promise<Array<{
  id: number;
  mainKey: string;
  nameAr: string;
  icon: string;
  sortOrder: number;
  isActive: boolean;
  subcategories: Array<{
    id: number;
    subcategoryKey: string;
    nameAr: string;
    icon: string;
    sortOrder: number;
    isActive: boolean;
  }>;
}>> {
  const mains = await pool.query<{
    id: number;
    main_key: string;
    name_ar: string;
    icon: string;
    sort_order: number;
    is_active: boolean;
  }>(
    `SELECT id, main_key, name_ar, icon, sort_order, is_active
     FROM question_main_categories
     ORDER BY sort_order ASC, id ASC`,
  );
  const subs = await pool.query<{
    id: number;
    main_category_id: number;
    subcategory_key: string;
    name_ar: string;
    icon: string;
    sort_order: number;
    is_active: boolean;
  }>(
    `SELECT id, main_category_id, subcategory_key, name_ar, icon, sort_order, is_active
     FROM question_subcategories
     ORDER BY sort_order ASC, id ASC`,
  );
  const subsByMain = new Map<number, typeof subs.rows>();
  for (const s of subs.rows) {
    const arr = subsByMain.get(s.main_category_id) ?? [];
    arr.push(s);
    subsByMain.set(s.main_category_id, arr);
  }
  return mains.rows.map((m) => ({
    id: m.id,
    mainKey: m.main_key,
    nameAr: m.name_ar,
    icon: m.icon,
    sortOrder: m.sort_order,
    isActive: m.is_active,
    subcategories: (subsByMain.get(m.id) ?? []).map((s) => ({
      id: s.id,
      subcategoryKey: s.subcategory_key,
      nameAr: s.name_ar,
      icon: s.icon,
      sortOrder: s.sort_order,
      isActive: s.is_active,
    })),
  }));
}

async function readCategoriesTreeFiltered(
  pool: ReturnType<typeof getPool>,
  opts?: { q?: string; isActive?: boolean | null; mainKey?: string },
): Promise<Awaited<ReturnType<typeof readCategoriesTree>>> {
  const q = opts?.q?.trim().toLowerCase() ?? "";
  const mainKey = opts?.mainKey?.trim() ?? "";
  const activeFilter = opts?.isActive;
  const tree = await readCategoriesTree(pool);
  return tree
    .filter((m) => !mainKey || m.mainKey === mainKey)
    .map((m) => ({
      ...m,
      subcategories: m.subcategories.filter((s) =>
        q.length === 0
          ? true
          : m.nameAr.toLowerCase().includes(q) ||
            m.mainKey.toLowerCase().includes(q) ||
            s.nameAr.toLowerCase().includes(q) ||
            s.subcategoryKey.toLowerCase().includes(q),
      ),
    }))
    .filter((m) => {
      if (activeFilter === null || activeFilter === undefined) return true;
      const mainOk = m.isActive === activeFilter;
      const hasSubMatch = m.subcategories.some((s) => s.isActive === activeFilter);
      return mainOk || hasSubMatch;
    })
    .map((m) => ({
      ...m,
      subcategories:
        activeFilter === null || activeFilter === undefined
          ? m.subcategories
          : m.subcategories.filter((s) => s.isActive === activeFilter),
    }));
}

async function countAffectedForMainDelete(
  pool: ReturnType<typeof getPool>,
  mainId: number,
): Promise<{ subcategories: number; questions: number }> {
  const s = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM question_subcategories WHERE main_category_id = $1`,
    [mainId],
  );
  const q = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM questions
     WHERE subcategory_key IN (
       SELECT subcategory_key FROM question_subcategories WHERE main_category_id = $1
     )`,
    [mainId],
  );
  return {
    subcategories: Number(s.rows[0]?.c ?? 0),
    questions: Number(q.rows[0]?.c ?? 0),
  };
}

async function countAffectedForSubDelete(
  pool: ReturnType<typeof getPool>,
  subId: number,
): Promise<{ questions: number }> {
  const q = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM questions
     WHERE subcategory_key = (
       SELECT subcategory_key FROM question_subcategories WHERE id = $1
     )`,
    [subId],
  );
  return { questions: Number(q.rows[0]?.c ?? 0) };
}

export function registerAdminRoutes(app: Express): void {
  app.get("/api/categories", async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const tree = await readCategoriesTree(pool);
      res.json({
        ok: true,
        categories: tree
          .filter((m) => m.isActive)
          .map((m) => ({
            ...m,
            subcategories: m.subcategories.filter((s) => s.isActive),
          })),
      });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });
  app.get("/api/release-version", async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const r = await pool.query<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'release_version' LIMIT 1`,
      );
      const releaseVersion = String(r.rows[0]?.value ?? "1").trim() || "1";
      res.json({ ok: true, releaseVersion });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

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
        winnerTitle: m.winnerTitle,
        loserTitle: m.loserTitle,
        tieTitle: m.tieTitle,
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
    const { winnerTitle, loserTitle, tieTitle, winnerText, loserText, tieText } = parsed.data;
    try {
      const pool = getPool();
      await pool.query(
        `UPDATE game_result_copy
         SET winner_title = $1, loser_title = $2, tie_title = $3,
             winner_text = $4, loser_text = $5, tie_text = $6
         WHERE id = 1`,
        [winnerTitle, loserTitle, tieTitle, winnerText, loserText, tieText],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.post("/api/admin/cache-bust", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const releaseVersion = String(Date.now());
      await pool.query(
        `INSERT INTO app_settings (key, value)
         VALUES ('release_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [releaseVersion],
      );
      res.json({ ok: true, releaseVersion });
    } catch {
      res.status(500).json({ ok: false, error: "cache_bust_failed" });
    }
  });

  app.get("/api/admin/ai-prompts", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const rows = await pool.query<{ key: string; value: string }>(
        `SELECT key, value
         FROM app_settings
         WHERE key IN ('prompt_study')`,
      );
      const map = new Map(rows.rows.map((r) => [r.key, r.value]));
      res.json({
        ok: true,
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
         VALUES ('prompt_study', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [parsed.data.promptStudy],
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
      Match.invalidateRuntimeSettingsCache();
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
      Match.invalidateRuntimeSettingsCache();
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.get("/api/admin/categories", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const mainKey = typeof req.query.mainKey === "string" ? req.query.mainKey : "";
      const isActiveRaw = typeof req.query.isActive === "string" ? req.query.isActive : "";
      const isActive =
        isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : null;
      const categories = await readCategoriesTreeFiltered(pool, {
        q,
        mainKey,
        isActive,
      });
      res.json({ ok: true, categories });
    } catch {
      res.status(500).json({ ok: false, error: "read_failed" });
    }
  });

  app.post("/api/admin/categories/main", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = mainCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    try {
      const pool = getPool();
      const d = parsed.data;
      await pool.query(
        `INSERT INTO question_main_categories (main_key, name_ar, icon, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (main_key) DO UPDATE
         SET name_ar = EXCLUDED.name_ar, icon = EXCLUDED.icon,
             sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active`,
        [d.mainKey, d.nameAr, d.icon ?? "📚", d.sortOrder ?? 0, d.isActive ?? true],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.post("/api/admin/categories/sub", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = subCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    try {
      const pool = getPool();
      const d = parsed.data;
      await pool.query(
        `INSERT INTO question_subcategories (main_category_id, subcategory_key, name_ar, icon, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (subcategory_key) DO UPDATE
         SET main_category_id = EXCLUDED.main_category_id, name_ar = EXCLUDED.name_ar,
             icon = EXCLUDED.icon, sort_order = EXCLUDED.sort_order, is_active = EXCLUDED.is_active`,
        [d.mainCategoryId, d.subcategoryKey, d.nameAr, d.icon ?? "📘", d.sortOrder ?? 0, d.isActive ?? true],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.patch("/api/admin/categories/main/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const parsed = mainCategorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    const d = parsed.data;
    try {
      const pool = getPool();
      const cur = await pool.query<{
        main_key: string; name_ar: string; icon: string; sort_order: number; is_active: boolean;
      }>(`SELECT main_key, name_ar, icon, sort_order, is_active FROM question_main_categories WHERE id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      await pool.query(
        `UPDATE question_main_categories
         SET main_key = $1, name_ar = $2, icon = $3, sort_order = $4, is_active = $5
         WHERE id = $6`,
        [
          d.mainKey ?? row.main_key,
          d.nameAr ?? row.name_ar,
          d.icon ?? row.icon,
          d.sortOrder ?? row.sort_order,
          d.isActive ?? row.is_active,
          id,
        ],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.patch("/api/admin/categories/sub/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const parsed = subCategorySchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    const d = parsed.data;
    try {
      const pool = getPool();
      const cur = await pool.query<{
        main_category_id: number; subcategory_key: string; name_ar: string; icon: string; sort_order: number; is_active: boolean;
      }>(`SELECT main_category_id, subcategory_key, name_ar, icon, sort_order, is_active FROM question_subcategories WHERE id = $1`, [id]);
      const row = cur.rows[0];
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      await pool.query(
        `UPDATE question_subcategories
         SET main_category_id = $1, subcategory_key = $2, name_ar = $3, icon = $4, sort_order = $5, is_active = $6
         WHERE id = $7`,
        [
          d.mainCategoryId ?? row.main_category_id,
          d.subcategoryKey ?? row.subcategory_key,
          d.nameAr ?? row.name_ar,
          d.icon ?? row.icon,
          d.sortOrder ?? row.sort_order,
          d.isActive ?? row.is_active,
          id,
        ],
      );
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.delete("/api/admin/categories/main/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const dryRun = String(req.query.dryRun ?? "").trim() === "true";
    try {
      const pool = getPool();
      const affected = await countAffectedForMainDelete(pool, id);
      if (dryRun) {
        res.json({ ok: true, dryRun: true, affectedCounts: affected });
        return;
      }
      const del = await pool.query(`DELETE FROM question_main_categories WHERE id = $1`, [id]);
      if ((del.rowCount ?? 0) === 0) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      res.json({ ok: true, affectedCounts: affected });
    } catch {
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
  });

  app.delete("/api/admin/categories/sub/:id", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const dryRun = String(req.query.dryRun ?? "").trim() === "true";
    try {
      const pool = getPool();
      const affected = await countAffectedForSubDelete(pool, id);
      if (dryRun) {
        res.json({ ok: true, dryRun: true, affectedCounts: affected });
        return;
      }
      const del = await pool.query(`DELETE FROM question_subcategories WHERE id = $1`, [id]);
      if ((del.rowCount ?? 0) === 0) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      res.json({ ok: true, affectedCounts: affected });
    } catch {
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
  });

  app.post("/api/admin/categories/bulk", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = categoriesBulkSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    const { target, action, ids, dryRun } = parsed.data;
    try {
      const pool = getPool();
      if (action === "delete") {
        if (dryRun) {
          if (target === "main") {
            let subcategories = 0;
            let questions = 0;
            for (const id of ids) {
              const c = await countAffectedForMainDelete(pool, id);
              subcategories += c.subcategories;
              questions += c.questions;
            }
            res.json({ ok: true, dryRun: true, affectedCounts: { categories: ids.length, subcategories, questions } });
            return;
          }
          let questions = 0;
          for (const id of ids) {
            const c = await countAffectedForSubDelete(pool, id);
            questions += c.questions;
          }
          res.json({ ok: true, dryRun: true, affectedCounts: { categories: ids.length, questions } });
          return;
        }
        if (target === "main") {
          await pool.query(`DELETE FROM question_main_categories WHERE id = ANY($1::int[])`, [ids]);
          res.json({ ok: true, affectedCounts: { categories: ids.length } });
          return;
        }
        await pool.query(`DELETE FROM question_subcategories WHERE id = ANY($1::int[])`, [ids]);
        res.json({ ok: true, affectedCounts: { categories: ids.length } });
        return;
      }
      const next = action === "activate";
      if (target === "main") {
        await pool.query(`UPDATE question_main_categories SET is_active = $1 WHERE id = ANY($2::int[])`, [next, ids]);
      } else {
        await pool.query(`UPDATE question_subcategories SET is_active = $1 WHERE id = ANY($2::int[])`, [next, ids]);
      }
      res.json({ ok: true, affectedCounts: { categories: ids.length } });
    } catch {
      res.status(500).json({ ok: false, error: "bulk_failed" });
    }
  });

  app.patch("/api/admin/categories/reorder", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = categoriesReorderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    const { target, items } = parsed.data;
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const item of items) {
        if (target === "main") {
          await client.query(`UPDATE question_main_categories SET sort_order = $1 WHERE id = $2`, [item.sortOrder, item.id]);
        } else {
          await client.query(`UPDATE question_subcategories SET sort_order = $1 WHERE id = $2`, [item.sortOrder, item.id]);
        }
      }
      await client.query("COMMIT");
      res.json({ ok: true, affectedCounts: { categories: items.length } });
    } catch {
      try { await client.query("ROLLBACK"); } catch {}
      res.status(500).json({ ok: false, error: "reorder_failed" });
    } finally {
      client.release();
    }
  });

  app.get("/api/admin/questions", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const modeRaw = typeof req.query.mode === "string" ? req.query.mode.trim() : "all";
    const mode = modeRaw === "study" ? "study" : "all";
    const mainCategoryKey =
      typeof req.query.mainCategoryKey === "string" ? req.query.mainCategoryKey.trim() : "";
    const subcategoryKey =
      typeof req.query.subcategoryKey === "string" ? req.query.subcategoryKey.trim() : "";
    try {
      const pool = getPool();
      const params: unknown[] = [];
      const whereParts: string[] = [];
      if (q.length > 0) {
        params.push(`%${q}%`);
        whereParts.push(`q.prompt ILIKE $${params.length}`);
      }
      if (mode === "study") {
        whereParts.push(`q.study_body IS NOT NULL AND btrim(q.study_body) <> ''`);
      }
      if (subcategoryKey) {
        params.push(subcategoryKey);
        whereParts.push(`q.subcategory_key = $${params.length}`);
      } else if (mainCategoryKey) {
        params.push(mainCategoryKey);
        whereParts.push(`mc.main_key = $${params.length}`);
      }
      const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
      params.push(limit, offset);
      const limIdx = params.length - 1;
      const offIdx = params.length;
      const listSql = `
        SELECT q.id,
               LEFT(q.prompt, 160) AS prompt_preview,
               (q.study_body IS NOT NULL AND btrim(q.study_body) <> '') AS has_study,
               COALESCE(mc.name_ar, '') AS main_name_ar,
               COALESCE(sc.name_ar, '') AS sub_name_ar,
               COALESCE(q.subcategory_key, '') AS subcategory_key
        FROM questions q
        LEFT JOIN question_subcategories sc ON sc.subcategory_key = q.subcategory_key
        LEFT JOIN question_main_categories mc ON mc.id = sc.main_category_id
        ${where}
        ORDER BY q.id DESC
        LIMIT $${limIdx} OFFSET $${offIdx}
      `;
      const list = await pool.query<{
        id: number;
        prompt_preview: string;
        has_study: boolean;
        main_name_ar: string;
        sub_name_ar: string;
        subcategory_key: string;
      }>(listSql, params);

      const countSql = `SELECT COUNT(*)::text AS c
        FROM questions q
        LEFT JOIN question_subcategories sc ON sc.subcategory_key = q.subcategory_key
        LEFT JOIN question_main_categories mc ON mc.id = sc.main_category_id
        ${where}`;
      const countParams = [...params.slice(0, -2)];
      const c = await pool.query<{ c: string }>(countSql, countParams);
      const total = Number(c.rows[0]?.c ?? 0);

      res.json({
        ok: true,
        items: list.rows.map((row) => ({
          id: row.id,
          promptPreview: row.prompt_preview,
          hasStudyCards: row.has_study,
          mainCategoryName: row.main_name_ar,
          subcategoryName: row.sub_name_ar,
          subcategoryKey: row.subcategory_key,
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
        subcategory_key: string;
      }>(
        `SELECT id, prompt, options, correct_index, difficulty, study_body, subcategory_key
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
          subcategoryKey: row.subcategory_key,
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
        subcategory_key: string;
      }>(
        `SELECT prompt, options, correct_index, difficulty, study_body, subcategory_key FROM questions WHERE id = $1`,
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
      const nextSubcategoryKey = String(
        d.subcategoryKey ?? d.subcategory_key ?? row.subcategory_key,
      ).trim();

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
             difficulty = $4, study_body = $5, subcategory_key = $6
         WHERE id = $7`,
        [
          nextPrompt,
          JSON.stringify(nextOptions),
          nextCorrect,
          nextDiff,
          nextStudy,
          nextSubcategoryKey || "general_default",
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
    const subcategoryKey = String(
      parsed.data.subcategoryKey ?? parsed.data.subcategory_key ?? "general_default",
    ).trim();

    try {
      const pool = getPool();
      const ins = await pool.query<{ id: number }>(
        `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key)
         VALUES ($1, $2::jsonb, $3, $4, $5, $6)
         RETURNING id`,
        [
          prompt,
          JSON.stringify(options),
          correctIndex,
          difficulty ?? null,
          studyBody,
          subcategoryKey || "general_default",
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
          `INSERT INTO questions (prompt, options, correct_index, difficulty, study_body, subcategory_key)
           VALUES ($1, $2::jsonb, $3, $4, $5, $6)`,
          [
            row.prompt,
            JSON.stringify(row.options),
            row.correctIndex,
            row.difficulty ?? null,
            row.studyBody,
            String(
              (row as { subcategoryKey?: string | null }).subcategoryKey ?? "general_default",
            ).trim() || "general_default",
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
