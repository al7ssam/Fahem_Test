import type { Express, Request, Response } from "express";
import { z } from "zod";
import { authService } from "../auth/AuthService";
import { getPool } from "../db/pool";
import { requireAuth } from "../auth/middleware";
import { logAuthEvent } from "../auth/repository";

const exchangeBodySchema = z.object({
  provider: z.enum(["firebase"]).default("firebase"),
  externalToken: z.string().min(10),
  clientType: z.enum(["web", "mobile"]).default("web"),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

function cookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
  };
}

function readCsrfHeader(req: Request): string {
  return String(req.header("x-csrf-token") ?? "").trim();
}

export function registerAuthRoutes(app: Express): void {
  app.post("/api/auth/exchange", async (req: Request, res: Response) => {
    const parsed = exchangeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const result = await authService.exchangeExternalToken({
        provider: parsed.data.provider,
        externalToken: parsed.data.externalToken,
        clientType: parsed.data.clientType,
        userAgent: req.headers["user-agent"] ?? null,
        ipAddress: req.ip ?? null,
      });
      if (parsed.data.clientType === "web") {
        res.cookie("fahem_access_token", result.accessToken, {
          ...cookieOptions(process.env.NODE_ENV === "production"),
          maxAge: result.accessTtlSeconds * 1000,
        });
        res.cookie("fahem_refresh_token", result.refreshToken, {
          ...cookieOptions(process.env.NODE_ENV === "production"),
          maxAge: result.webSessionTtlSeconds * 1000,
        });
        res.cookie("fahem_csrf_token", result.csrfToken ?? "", {
          httpOnly: false,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: result.webSessionTtlSeconds * 1000,
        });
      }
      res.json({
        ok: true,
        user: {
          id: result.userId,
          roles: result.roles,
        },
        tokens:
          parsed.data.clientType === "mobile"
            ? {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
                expiresIn: result.accessTtlSeconds,
              }
            : undefined,
      });
    } catch (error) {
      await logAuthEvent({
        userId: null,
        eventType: "auth.exchange.failed",
        provider: parsed.data.provider,
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { reason: error instanceof Error ? error.message : "unknown_error" },
      }).catch(() => {});
      res.status(401).json({
        ok: false,
        error: "auth_exchange_failed",
        reason: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  app.post("/api/auth/refresh", async (req: Request, res: Response) => {
    const parsed = refreshBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_body" });
      return;
    }
    try {
      const refreshToken = String(parsed.data.refreshToken ?? req.cookies?.fahem_refresh_token ?? "").trim();
      if (!refreshToken) {
        res.status(401).json({ ok: false, error: "missing_refresh_token" });
        return;
      }
      const csrfHeader = readCsrfHeader(req);
      const csrfCookie = String(req.cookies?.fahem_csrf_token ?? "").trim();
      if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
        await logAuthEvent({
          userId: req.auth?.userId ?? null,
          sessionId: req.auth?.sessionId ?? null,
          eventType: "auth.refresh.csrf_mismatch",
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        }).catch(() => {});
        res.status(403).json({ ok: false, error: "csrf_mismatch" });
        return;
      }
      await authService.validateRefreshCsrf(refreshToken, csrfHeader);
      const result = await authService.refreshSession(refreshToken);
      res.cookie("fahem_access_token", result.accessToken, {
        ...cookieOptions(process.env.NODE_ENV === "production"),
        maxAge: result.accessTtlSeconds * 1000,
      });
      res.cookie("fahem_refresh_token", result.refreshToken, {
        ...cookieOptions(process.env.NODE_ENV === "production"),
        maxAge: result.webSessionTtlSeconds * 1000,
      });
      res.json({
        ok: true,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.accessTtlSeconds,
      });
    } catch (error) {
      await logAuthEvent({
        userId: req.auth?.userId ?? null,
        sessionId: req.auth?.sessionId ?? null,
        eventType: "auth.refresh.failed",
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: { reason: error instanceof Error ? error.message : "unknown_error" },
      }).catch(() => {});
      res.status(401).json({
        ok: false,
        error: "refresh_failed",
        reason: error instanceof Error ? error.message : "unknown_error",
      });
    }
  });

  app.post("/api/auth/logout", requireAuth, async (req: Request, res: Response) => {
    try {
      const refreshToken = String(req.cookies?.fahem_refresh_token ?? req.body?.refreshToken ?? "").trim();
      const csrfHeader = readCsrfHeader(req);
      const csrfCookie = String(req.cookies?.fahem_csrf_token ?? "").trim();
      if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
        await logAuthEvent({
          userId: req.auth?.userId ?? null,
          sessionId: req.auth?.sessionId ?? null,
          eventType: "auth.logout.csrf_mismatch",
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
        }).catch(() => {});
        res.status(403).json({ ok: false, error: "csrf_mismatch" });
        return;
      }
      if (refreshToken) {
        await authService.validateRefreshCsrf(refreshToken, csrfHeader);
        await authService.revokeByRefreshToken(refreshToken);
      } else if (req.auth?.sessionId) {
        const pool = getPool();
        await pool.query(
          `UPDATE public.user_sessions
           SET revoked_at = NOW(), revoked_reason = 'manual_logout'
           WHERE id = $1::uuid AND revoked_at IS NULL`,
          [req.auth.sessionId],
        );
      }
      res.clearCookie("fahem_access_token", { path: "/" });
      res.clearCookie("fahem_refresh_token", { path: "/" });
      res.clearCookie("fahem_csrf_token", { path: "/" });
      res.status(200).json({ ok: true });
    } catch {
      await logAuthEvent({
        userId: req.auth?.userId ?? null,
        sessionId: req.auth?.sessionId ?? null,
        eventType: "auth.logout.failed",
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
      }).catch(() => {});
      res.status(500).json({ ok: false, error: "logout_failed" });
    }
  });

  app.get("/api/auth/me", requireAuth, async (req: Request, res: Response) => {
    const pool = getPool();
    const r = await pool.query<{ id: string; primary_email: string | null; display_name: string | null }>(
      `SELECT id::text, primary_email, display_name
       FROM public.users
       WHERE id = $1::uuid
       LIMIT 1`,
      [req.auth?.userId],
    );
    const user = r.rows[0];
    if (!user) {
      res.status(404).json({ ok: false, error: "user_not_found" });
      return;
    }
    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.primary_email,
        displayName: user.display_name,
        roles: req.auth?.roles ?? [],
      },
    });
  });
}
