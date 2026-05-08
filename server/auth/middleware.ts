import type { NextFunction, Request, Response } from "express";
import { authService } from "./AuthService";
import { logAuthEvent } from "./repository";
import { toAuthErrorCode } from "./errors";

export type RequestAuthContext = {
  userId: string;
  sessionId: string;
  roles: string[];
};

declare module "express-serve-static-core" {
  interface Request {
    auth?: RequestAuthContext;
  }
}

function readBearerToken(req: Request): string | null {
  const header = String(req.headers.authorization ?? "").trim();
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const cookieToken = String((req as Request & { cookies?: Record<string, unknown> }).cookies?.fahem_access_token ?? "").trim();
  return cookieToken || null;
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readBearerToken(req);
    if (!token) {
      next();
      return;
    }
    const user = await authService.verifyAccessToken(token);
    req.auth = { userId: user.userId, sessionId: user.sessionId, roles: user.roles };
    next();
  } catch {
    next();
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readBearerToken(req);
    if (!token) {
      await logAuthEvent({
        userId: null,
        eventType: "auth.access.unauthorized",
        ipAddress: req.ip ?? null,
        userAgent: req.headers["user-agent"] ?? null,
        metadata: {
          reason_code: "missing_access_token",
          path: req.path,
          method: req.method,
          request_id: String(req.header("x-request-id") ?? "").trim() || null,
        },
      }).catch(() => {});
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    const user = await authService.verifyAccessToken(token);
    req.auth = { userId: user.userId, sessionId: user.sessionId, roles: user.roles };
    next();
  } catch (error) {
    await logAuthEvent({
      userId: null,
      eventType: "auth.access.unauthorized",
      ipAddress: req.ip ?? null,
      userAgent: req.headers["user-agent"] ?? null,
      metadata: {
        reason_code: toAuthErrorCode(error),
        path: req.path,
        method: req.method,
        request_id: String(req.header("x-request-id") ?? "").trim() || null,
      },
    }).catch(() => {});
    res.status(401).json({ ok: false, error: "unauthorized" });
  }
}

export function requireRole(roleKey: string) {
  return async function roleMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    await requireAuth(req, res, async () => {
      if (!req.auth?.roles.includes(roleKey)) {
        await logAuthEvent({
          userId: req.auth?.userId ?? null,
          sessionId: req.auth?.sessionId ?? null,
          eventType: "auth.access.forbidden",
          ipAddress: req.ip ?? null,
          userAgent: req.headers["user-agent"] ?? null,
          metadata: {
            required_role: roleKey,
            path: req.path,
            method: req.method,
            request_id: String(req.header("x-request-id") ?? "").trim() || null,
          },
        }).catch(() => {});
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }
      next();
    });
  };
}
