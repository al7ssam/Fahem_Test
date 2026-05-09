import type { Express, Request, Response } from "express";
import { requireAuth } from "../auth/middleware";
import { getProfileByUserId, patchProfileByUserId } from "../profile/repository";
import { patchProfileBodySchema } from "../profile/schemas";

export function registerProfileRoutes(app: Express): void {
  app.get("/api/profile/me", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    try {
      const profile = await getProfileByUserId(userId);
      if (!profile) {
        res.status(404).json({ ok: false, error: "profile_not_found" });
        return;
      }
      res.json({
        ok: true,
        profile: {
          firstName: profile.firstName,
          lastName: profile.lastName,
          birthDate: profile.birthDate,
          countryCode: profile.countryCode,
          profileCompletedAt: profile.profileCompletedAt,
        },
      });
    } catch {
      res.status(500).json({ ok: false, error: "profile_fetch_failed" });
    }
  });

  app.patch("/api/profile/me", requireAuth, async (req: Request, res: Response) => {
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const parsed = patchProfileBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body", details: parsed.error.flatten() });
      return;
    }
    if (Object.keys(parsed.data).length === 0) {
      res.status(400).json({ ok: false, error: "empty_patch" });
      return;
    }
    try {
      const updated = await patchProfileByUserId(userId, parsed.data);
      if (!updated) {
        res.status(404).json({ ok: false, error: "profile_not_found" });
        return;
      }
      res.json({
        ok: true,
        profile: {
          firstName: updated.firstName,
          lastName: updated.lastName,
          birthDate: updated.birthDate,
          countryCode: updated.countryCode,
          profileCompletedAt: updated.profileCompletedAt,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "unknown_error";
      const map: Record<string, number> = {
        invalid_birth_date: 400,
        birth_date_future: 400,
        birth_date_too_old: 400,
        invalid_country_code: 400,
      };
      const status = map[msg] ?? 500;
      const body =
        status === 500
          ? { ok: false as const, error: "profile_update_failed" }
          : { ok: false as const, error: msg };
      res.status(status).json(body);
    }
  });
}
