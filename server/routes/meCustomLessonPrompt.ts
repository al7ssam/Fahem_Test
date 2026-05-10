import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import {
  clearCustomLessonPromptParamsForUser,
  getCustomLessonPromptParamsForUser,
  setCustomLessonPromptParamsForUser,
} from "../customLessonPromptPrefs/repository";
import type { LessonAiPromptParams } from "../../shared/lessonAiPrompt";
import { clampCustomLessonFlowParams } from "../../shared/lessonAiPrompt";

const lessonAiPromptParamsBodySchema = z.object({
  nSec: z.number(),
  qSame: z.number(),
  ansSec: z.number(),
  studySec: z.number(),
  topic: z.string().optional(),
  audience: z.string(),
  minSentences: z.number(),
  maxSentences: z.number(),
});

function parseBodyToParams(body: unknown): LessonAiPromptParams | null {
  const parsed = lessonAiPromptParamsBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const d = parsed.data;
  return clampCustomLessonFlowParams({
    nSec: d.nSec,
    qSame: d.qSame,
    ansSec: d.ansSec,
    studySec: d.studySec,
    topic: "",
    audience: d.audience,
    minSentences: d.minSentences,
    maxSentences: d.maxSentences,
  });
}

export function registerMeCustomLessonPromptRoutes(app: Express): void {
  app.get("/api/me/custom-lesson-prompt-params", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    try {
      const params = await getCustomLessonPromptParamsForUser(userId);
      res.json({ ok: true, params });
    } catch {
      res.status(500).json({ ok: false, error: "load_failed" });
    }
  });

  app.put("/api/me/custom-lesson-prompt-params", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const params = parseBodyToParams(req.body ?? {});
    if (!params) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const saved = await setCustomLessonPromptParamsForUser(userId, params);
      res.json({ ok: true, params: saved });
    } catch {
      res.status(500).json({ ok: false, error: "save_failed" });
    }
  });

  app.delete("/api/me/custom-lesson-prompt-params", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    try {
      await clearCustomLessonPromptParamsForUser(userId);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "clear_failed" });
    }
  });
}
