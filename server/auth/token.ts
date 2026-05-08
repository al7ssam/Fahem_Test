import crypto from "crypto";
import jwt from "jsonwebtoken";
import { config } from "../config";
import type { AccessTokenPayload, RefreshTokenPayload } from "./types";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const WEB_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

function requireJwtSecret(): string {
  const secret = config.authJwtSecret.trim();
  if (!secret) {
    throw new Error("AUTH_JWT_SECRET is required");
  }
  return secret;
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function randomToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const secret = requireJwtSecret();
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: ACCESS_TTL_SECONDS,
    issuer: "fahem-auth",
    audience: "fahem-api",
  });
}

export function signRefreshToken(payload: RefreshTokenPayload): string {
  const secret = requireJwtSecret();
  return jwt.sign(payload, secret, {
    algorithm: "HS256",
    expiresIn: REFRESH_TTL_SECONDS,
    issuer: "fahem-auth",
    audience: "fahem-api",
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const secret = requireJwtSecret();
  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "fahem-auth",
    audience: "fahem-api",
  }) as Partial<AccessTokenPayload>;
  if (payload.typ !== "access") {
    throw new Error("token_invalid_type");
  }
  if (!payload.sub || !payload.sid || !Array.isArray(payload.roles)) {
    throw new Error("token_invalid_payload");
  }
  return {
    sub: payload.sub,
    sid: payload.sid,
    typ: "access",
    roles: payload.roles.map((x) => String(x)),
  };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const secret = requireJwtSecret();
  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    issuer: "fahem-auth",
    audience: "fahem-api",
  }) as Partial<RefreshTokenPayload>;
  if (payload.typ !== "refresh") {
    throw new Error("token_invalid_type");
  }
  if (!payload.sub || !payload.sid) {
    throw new Error("token_invalid_payload");
  }
  return {
    sub: payload.sub,
    sid: payload.sid,
    typ: "refresh",
  };
}

export function getAccessTtlSeconds(): number {
  return ACCESS_TTL_SECONDS;
}

export function getRefreshTtlSeconds(): number {
  return REFRESH_TTL_SECONDS;
}

export function getWebSessionTtlSeconds(): number {
  return WEB_SESSION_TTL_SECONDS;
}
