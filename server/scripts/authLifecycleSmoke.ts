import crypto from "crypto";
import { getPool } from "../db/pool";
import { createSession, updateSessionRefreshTokenHash } from "../auth/repository";
import { hashToken, randomToken, signAccessToken, signRefreshToken } from "../auth/token";

const baseUrl = String(process.env.AUTH_SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");

type Json = Record<string, unknown>;

async function expectJson(path: string, init: RequestInit, expectedStatus: number): Promise<Json> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = (await response.json().catch(() => ({}))) as Json;
  if (response.status !== expectedStatus) {
    throw new Error(`Unexpected status for ${path}: ${response.status} (expected ${expectedStatus}) body=${JSON.stringify(body)}`);
  }
  return body;
}

async function createSmokeUser(): Promise<{ userId: string }> {
  const pool = getPool();
  const marker = crypto.randomUUID().slice(0, 8);
  const email = `auth-smoke-${marker}@local.fahem`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO public.users (display_name, primary_email, is_email_verified, status)
     VALUES ($1, $2, TRUE, 'active')
     RETURNING id::text AS id`,
    ["Auth Smoke User", email],
  );
  return { userId: result.rows[0].id };
}

async function createSignedSession(input: {
  userId: string;
  clientType: "web" | "mobile";
  csrfTokenRaw?: string | null;
}): Promise<{ accessToken: string; refreshToken: string; csrfTokenRaw: string | null }> {
  const csrfRaw = input.csrfTokenRaw ?? null;
  const { sessionId } = await createSession({
    userId: input.userId,
    clientType: input.clientType,
    refreshTokenHash: hashToken(randomToken()),
    csrfTokenHash: csrfRaw ? hashToken(csrfRaw) : null,
    userAgent: "auth-lifecycle-smoke",
    ipAddress: "127.0.0.1",
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  const accessToken = signAccessToken({
    sub: input.userId,
    sid: sessionId,
    typ: "access",
    roles: ["player"],
  });
  const refreshToken = signRefreshToken({
    sub: input.userId,
    sid: sessionId,
    typ: "refresh",
  });
  await updateSessionRefreshTokenHash(sessionId, hashToken(refreshToken));
  return { accessToken, refreshToken, csrfTokenRaw: csrfRaw };
}

async function runWebContract(userId: string): Promise<void> {
  const csrfToken = randomToken();
  const session = await createSignedSession({
    userId,
    clientType: "web",
    csrfTokenRaw: csrfToken,
  });

  await expectJson(
    "/api/auth/refresh",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Cookie: `fahem_csrf_token=${csrfToken}`,
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    },
    200,
  );

  await expectJson(
    "/api/auth/me",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
    },
    200,
  );

  await expectJson(
    "/api/auth/logout",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "X-CSRF-Token": csrfToken,
        Cookie: `fahem_csrf_token=${csrfToken}`,
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    },
    200,
  );
}

async function runMobileContract(userId: string): Promise<void> {
  const session = await createSignedSession({
    userId,
    clientType: "mobile",
  });

  await expectJson(
    "/api/auth/refresh",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    },
    200,
  );

  await expectJson(
    "/api/auth/logout",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    },
    200,
  );
}

async function runOptionalExchangeSmoke(): Promise<void> {
  const firebaseIdToken = String(process.env.AUTH_SMOKE_FIREBASE_ID_TOKEN ?? "").trim();
  if (!firebaseIdToken) {
    console.log("[auth:lifecycle-smoke] exchange skipped (AUTH_SMOKE_FIREBASE_ID_TOKEN is empty)");
    return;
  }
  await expectJson(
    "/api/auth/exchange",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        provider: "firebase",
        externalToken: firebaseIdToken,
        clientType: "web",
      }),
    },
    200,
  );
}

async function main(): Promise<void> {
  const { userId } = await createSmokeUser();
  await runWebContract(userId);
  await runMobileContract(userId);
  await runOptionalExchangeSmoke();
  console.log("[auth:lifecycle-smoke] OK");
}

void main().catch((error) => {
  console.error("[auth:lifecycle-smoke] FAILED");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
