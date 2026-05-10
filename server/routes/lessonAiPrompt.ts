import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getPool } from "../db/pool";
import { buildPlaybackFromImportDraft } from "../db/lessons";
import {
  buildCustomLessonAiPromptText,
  buildLessonAiPromptText,
  clampLessonPromptParams,
  type LessonAiPromptParams,
} from "../../shared/lessonAiPrompt";
import { lessonImportBodySchema, normalizeLessonImportPayload } from "../lessonImportPayload";
import {
  getLessonAiPromptStored,
  mergeLessonAiPromptStored,
  saveLessonAiPromptStored,
  listLessonAiPromptVersions,
  restoreLessonAiPromptVersion,
} from "../services/lessonAiPromptConfig";

function verifyAdmin(req: Request, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  if (!req.auth.roles.includes("admin")) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return false;
  }
  return true;
}

const lessonParamsBodySchema = z.object({
  nSec: z.number().optional(),
  qSame: z.number().optional(),
  ansSec: z.number().optional(),
  studySec: z.number().optional(),
  topic: z.string().optional(),
  audience: z.string().optional(),
  minSentences: z.number().optional(),
  maxSentences: z.number().optional(),
});

const previewBodySchema = z.object({
  kind: z.enum(["admin_import", "custom_lesson"]),
  params: lessonParamsBodySchema,
  learningIntent: z.string().optional(),
});

export function registerLessonAiPromptRoutes(app: Express): void {
  app.get("/api/public/lesson-ai-prompt-config", async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const stored = await getLessonAiPromptStored(pool);
      const merged = mergeLessonAiPromptStored(stored);
      res.json({
        ok: true,
        config: {
          defaults: merged.defaults,
          audienceOptions: merged.audienceOptions,
          fragmentEnabled: merged.fragmentEnabled,
          fragmentOverrides: merged.fragmentOverrides,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "config_load_failed" });
    }
  });

  app.get("/api/admin/lesson-ai-prompt-config", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const stored = await getLessonAiPromptStored(pool);
      const merged = mergeLessonAiPromptStored(stored);
      res.json({
        ok: true,
        stored: stored ?? { version: 1 as const },
        resolved: merged,
      });
    } catch {
      res.status(500).json({ ok: false, error: "config_load_failed" });
    }
  });

  app.put("/api/admin/lesson-ai-prompt-config", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const note = typeof req.body?.note === "string" ? req.body.note : null;
    const payload = req.body?.config ?? req.body;
    try {
      const pool = getPool();
      const result = await saveLessonAiPromptStored(pool, payload, note);
      if (!result.ok) {
        res.status(400).json({ ok: false, error: result.error });
        return;
      }
      const stored = await getLessonAiPromptStored(pool);
      res.json({ ok: true, stored });
    } catch {
      res.status(500).json({ ok: false, error: "config_save_failed" });
    }
  });

  app.get("/api/admin/lesson-ai-prompt-config/versions", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const limit = Number(req.query.limit);
      const rows = await listLessonAiPromptVersions(pool, Number.isFinite(limit) ? limit : 30);
      res.json({ ok: true, versions: rows });
    } catch {
      res.status(500).json({ ok: false, error: "versions_failed" });
    }
  });

  app.post("/api/admin/lesson-ai-prompt-config/restore", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = z.object({ versionId: z.number().int().positive() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const pool = getPool();
      const ok = await restoreLessonAiPromptVersion(pool, parsed.data.versionId);
      if (!ok) {
        res.status(404).json({ ok: false, error: "version_not_found" });
        return;
      }
      const stored = await getLessonAiPromptStored(pool);
      res.json({ ok: true, stored });
    } catch {
      res.status(500).json({ ok: false, error: "restore_failed" });
    }
  });

  app.post("/api/admin/lesson-ai-prompt/preview-text", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = previewBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const pool = getPool();
      const stored = await getLessonAiPromptStored(pool);
      const resolved = mergeLessonAiPromptStored(stored);
      const { runtimeOptions } = resolved;
      const mergedIn: LessonAiPromptParams = {
        ...resolved.defaults,
        nSec: parsed.data.params.nSec ?? resolved.defaults.nSec,
        qSame: parsed.data.params.qSame ?? resolved.defaults.qSame,
        ansSec: parsed.data.params.ansSec ?? resolved.defaults.ansSec,
        studySec: parsed.data.params.studySec ?? resolved.defaults.studySec,
        topic: parsed.data.params.topic ?? resolved.defaults.topic,
        audience: parsed.data.params.audience ?? resolved.defaults.audience,
        minSentences: parsed.data.params.minSentences ?? resolved.defaults.minSentences,
        maxSentences: parsed.data.params.maxSentences ?? resolved.defaults.maxSentences,
      };
      const base = clampLessonPromptParams(mergedIn);
      let text: string;
      if (parsed.data.kind === "custom_lesson") {
        text = buildCustomLessonAiPromptText(
          {
            ...base,
            learningIntent: parsed.data.learningIntent ?? "",
          },
          runtimeOptions,
        );
      } else {
        text = buildLessonAiPromptText(base, runtimeOptions);
      }
      res.json({ ok: true, text });
    } catch {
      res.status(500).json({ ok: false, error: "preview_failed" });
    }
  });

  app.post("/api/admin/lesson-ai-prompt/test-json", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const parsed = lessonImportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        ok: false,
        error: "invalid_body",
        issues: parsed.error.errors.slice(0, 12).map((e) => ({ path: e.path.join("."), message: e.message })),
      });
      return;
    }
    try {
      const normalized = normalizeLessonImportPayload(parsed.data);
      const lesson = buildPlaybackFromImportDraft(normalized.meta, normalized.sections);
      res.json({
        ok: true,
        steps: lesson.steps.length,
        lessonTitle: lesson.title ?? "",
      });
    } catch {
      res.status(500).json({ ok: false, error: "playback_failed" });
    }
  });
}
