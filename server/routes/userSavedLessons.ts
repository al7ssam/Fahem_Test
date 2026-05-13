import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { getPool } from "../db/pool";
import { lessonImportBodySchema } from "../lessonImportPayload";
import {
  getUserSavedLessonsPolicyStored,
  mergeUserSavedLessonsPolicy,
  saveUserSavedLessonsPolicyStored,
} from "../services/userSavedLessonsPolicy";
import {
  countActiveSavedLessonsForUser,
  deleteExpiredUserSavedLessonsForUser,
  deleteSavedLesson,
  getActiveSavedLessonForUser,
  insertSavedLesson,
  listActiveSavedLessonsForUserWithExpiryCleanup,
  updateSavedLesson,
} from "../userSavedLessons/repository";

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

const uuidParamSchema = z.string().uuid();

const createSavedLessonBodySchema = lessonImportBodySchema.extend({
  libraryIcon: z.string().trim().max(32).optional(),
});

const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    payload: lessonImportBodySchema.optional(),
    libraryIcon: z.union([z.string().trim().max(32), z.literal("")]).optional(),
  })
  .refine((d) => d.title !== undefined || d.payload !== undefined || d.libraryIcon !== undefined, {
    message: "at_least_one_field",
  });

export function registerUserSavedLessonsRoutes(app: Express): void {
  app.get("/api/public/user-saved-lessons-policy", async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const stored = await getUserSavedLessonsPolicyStored(pool);
      const policy = mergeUserSavedLessonsPolicy(stored);
      res.json({
        ok: true,
        policy: {
          retentionDays: policy.retentionDays,
          maxLessonsPerUser: policy.maxLessonsPerUser,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "policy_load_failed" });
    }
  });

  app.get("/api/me/saved-lessons", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    try {
      const pool = getPool();
      const items = await listActiveSavedLessonsForUserWithExpiryCleanup(pool, userId);
      res.json({ ok: true, lessons: items });
    } catch {
      res.status(500).json({ ok: false, error: "list_failed" });
    }
  });

  app.post("/api/me/saved-lessons", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const parsed = createSavedLessonBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", issues: parsed.error.flatten() });
      return;
    }
    try {
      const pool = getPool();
      await deleteExpiredUserSavedLessonsForUser(pool, userId);
      const storedPolicy = await getUserSavedLessonsPolicyStored(pool);
      const policy = mergeUserSavedLessonsPolicy(storedPolicy);
      const count = await countActiveSavedLessonsForUser(pool, userId);
      if (count >= policy.maxLessonsPerUser) {
        res.status(409).json({ ok: false, error: "max_lessons_reached", max: policy.maxLessonsPerUser });
        return;
      }
      const d = parsed.data;
      const title = d.lesson.title.trim();
      const payloadBody = { lesson: d.lesson, sections: d.sections };
      const row = await insertSavedLesson(pool, {
        userId,
        title,
        payload: payloadBody,
        retentionDays: policy.retentionDays,
        libraryIcon: d.libraryIcon,
      });
      res.status(201).json({
        ok: true,
        lesson: {
          id: row.id,
          title: row.title,
          libraryIcon: row.libraryIcon,
          payload: row.payload,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "save_failed" });
    }
  });

  app.get("/api/me/saved-lessons/:id", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    try {
      const pool = getPool();
      await deleteExpiredUserSavedLessonsForUser(pool, userId);
      const row = await getActiveSavedLessonForUser(pool, userId, idParsed.data);
      if (!row) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      res.json({
        ok: true,
        lesson: {
          id: row.id,
          title: row.title,
          libraryIcon: row.libraryIcon,
          payload: row.payload,
          expiresAt: row.expiresAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "load_failed" });
    }
  });

  app.patch("/api/me/saved-lessons/:id", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    const bodyParsed = patchBodySchema.safeParse(req.body ?? {});
    if (!bodyParsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const pool = getPool();
      await deleteExpiredUserSavedLessonsForUser(pool, userId);
      const existing = await getActiveSavedLessonForUser(pool, userId, idParsed.data);
      if (!existing) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      const payloadParsed = lessonImportBodySchema.safeParse(existing.payload);
      if (!payloadParsed.success) {
        res.status(500).json({ ok: false, error: "stored_payload_corrupt" });
        return;
      }
      const payloadFinal = bodyParsed.data.payload ?? payloadParsed.data;
      let titleFinal: string;
      if (bodyParsed.data.title !== undefined) {
        titleFinal = bodyParsed.data.title.trim();
      } else if (bodyParsed.data.payload !== undefined) {
        titleFinal = bodyParsed.data.payload.lesson.title.trim();
      } else {
        titleFinal = existing.title;
      }
      const titleCheck = z.string().trim().min(1).max(300).safeParse(titleFinal);
      if (!titleCheck.success) {
        res.status(400).json({ ok: false, error: "invalid_title" });
        return;
      }
      let iconFinal: string | null;
      if (bodyParsed.data.libraryIcon !== undefined) {
        const t = bodyParsed.data.libraryIcon.trim();
        iconFinal = t === "" ? null : t.slice(0, 32);
      } else {
        iconFinal = existing.libraryIcon ?? null;
      }
      const storedPolicy = await getUserSavedLessonsPolicyStored(pool);
      const policy = mergeUserSavedLessonsPolicy(storedPolicy);
      const updated = await updateSavedLesson(pool, {
        userId,
        lessonId: idParsed.data,
        title: titleCheck.data,
        payload: payloadFinal,
        retentionDays: policy.retentionDays,
        libraryIcon: iconFinal,
      });
      if (!updated) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      res.json({
        ok: true,
        lesson: {
          id: updated.id,
          title: updated.title,
          libraryIcon: updated.libraryIcon,
          payload: updated.payload,
          expiresAt: updated.expiresAt,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.delete("/api/me/saved-lessons/:id", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth!.userId;
    const idParsed = uuidParamSchema.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ ok: false, error: "invalid_id" });
      return;
    }
    try {
      const pool = getPool();
      const deleted = await deleteSavedLesson(pool, userId, idParsed.data);
      if (!deleted) {
        res.status(404).json({ ok: false, error: "not_found" });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
  });

  app.get("/api/admin/user-saved-lessons-policy", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    try {
      const pool = getPool();
      const stored = await getUserSavedLessonsPolicyStored(pool);
      const resolved = mergeUserSavedLessonsPolicy(stored);
      res.json({ ok: true, stored, resolved });
    } catch {
      res.status(500).json({ ok: false, error: "policy_load_failed" });
    }
  });

  app.put("/api/admin/user-saved-lessons-policy", async (req: Request, res: Response) => {
    if (!verifyAdmin(req, res)) return;
    const body = req.body?.policy ?? req.body;
    try {
      const pool = getPool();
      const result = await saveUserSavedLessonsPolicyStored(pool, body);
      if (!result.ok) {
        res.status(400).json({ ok: false, error: result.error });
        return;
      }
      const stored = await getUserSavedLessonsPolicyStored(pool);
      res.json({ ok: true, stored });
    } catch {
      res.status(500).json({ ok: false, error: "policy_save_failed" });
    }
  });
}
