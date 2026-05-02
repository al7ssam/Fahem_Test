import type { Express, Request, Response } from "express";
import type { ZodError } from "zod";
import { buildPlaybackFromImportDraft } from "../db/lessons";
import { putCustomLessonPlayback } from "../customLessonSessions";
import { lessonImportBodySchema, normalizeLessonImportPayload } from "../lessonImportPayload";

function zodIssuesSummary(err: ZodError, limit = 5): Array<{ path: string; message: string }> {
  return err.errors.slice(0, limit).map((e) => ({
    path: e.path.join("."),
    message: e.message,
  }));
}

export function registerCustomLessonRoutes(app: Express): void {
  app.post("/api/custom-lessons/preview", (req: Request, res: Response) => {
    const parsed = lessonImportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    try {
      const normalized = normalizeLessonImportPayload(parsed.data);
      const lesson = buildPlaybackFromImportDraft(normalized.meta, normalized.sections);
      res.json({ ok: true, lesson });
    } catch {
      res.status(500).json({ ok: false, error: "preview_failed" });
    }
  });

  app.post("/api/custom-lessons/session", (req: Request, res: Response) => {
    const parsed = lessonImportBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: zodIssuesSummary(parsed.error) });
      return;
    }
    try {
      const full = { lesson: parsed.data.lesson, sections: parsed.data.sections };
      const normalized = normalizeLessonImportPayload(full);
      const lesson = buildPlaybackFromImportDraft(normalized.meta, normalized.sections);
      const token = putCustomLessonPlayback(lesson);
      res.json({ ok: true, token, lesson });
    } catch {
      res.status(500).json({ ok: false, error: "session_failed" });
    }
  });
}
