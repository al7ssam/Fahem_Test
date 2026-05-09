import type { PoolClient } from "pg";
import { getPool } from "../db/pool";
import type { ExternalIdentity } from "./types";
import { config } from "../config";

type UserRow = {
  id: string;
  status: "active" | "suspended" | "deleted";
};

function canonicalEmail(input: string): string {
  return input.trim().toLowerCase();
}

export async function runInTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failure
    }
    throw error;
  } finally {
    client.release();
  }
}

async function getUserByIdentity(client: PoolClient, identity: ExternalIdentity): Promise<UserRow | null> {
  const r = await client.query<UserRow>(
    `SELECT u.id::text AS id, u.status
     FROM public.user_identities i
     JOIN public.users u ON u.id = i.user_id
     WHERE i.provider = $1 AND i.provider_user_id = $2
     LIMIT 1`,
    [identity.provider, identity.providerUserId],
  );
  return r.rows[0] ?? null;
}

async function getUserByCanonicalEmail(client: PoolClient, emailCanonical: string): Promise<UserRow | null> {
  const r = await client.query<UserRow>(
    `SELECT u.id::text AS id, u.status
     FROM public.user_emails e
     JOIN public.users u ON u.id = e.user_id
     WHERE e.email_canonical = $1
       AND e.is_verified = TRUE
     LIMIT 1`,
    [emailCanonical],
  );
  return r.rows[0] ?? null;
}

async function createUser(client: PoolClient, identity: ExternalIdentity): Promise<UserRow> {
  const r = await client.query<UserRow>(
    `INSERT INTO public.users (display_name, avatar_url, primary_email, is_email_verified, status, last_login_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())
     RETURNING id::text AS id, status`,
    [identity.displayName, identity.pictureUrl, identity.email, identity.emailVerified],
  );
  return r.rows[0];
}

async function ensurePlayerRole(client: PoolClient, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO public.user_roles (user_id, role_id)
     SELECT $1::uuid, r.id
     FROM public.roles r
     WHERE r.role_key = 'player'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId],
  );
}

async function ensureAdminRoleWhenEligible(
  client: PoolClient,
  userId: string,
  email: string | null,
): Promise<void> {
  if (!email) return;
  const canonical = canonicalEmail(email);
  if (!config.authAdminEmails.includes(canonical)) return;
  await client.query(
    `INSERT INTO public.user_roles (user_id, role_id)
     SELECT $1::uuid, r.id
     FROM public.roles r
     WHERE r.role_key = 'admin'
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId],
  );
}

async function upsertUserEmail(client: PoolClient, userId: string, email: string, verified: boolean): Promise<void> {
  const emailCanonical = canonicalEmail(email);
  await client.query(
    `INSERT INTO public.user_emails (user_id, email_original, email_canonical, is_verified, is_primary, verified_at)
     VALUES ($1::uuid, $2, $3, $4, TRUE, CASE WHEN $4 THEN NOW() ELSE NULL END)
     ON CONFLICT (user_id, email_canonical)
     DO UPDATE SET
       email_original = EXCLUDED.email_original,
       is_verified = public.user_emails.is_verified OR EXCLUDED.is_verified,
       is_primary = TRUE,
       verified_at = COALESCE(public.user_emails.verified_at, EXCLUDED.verified_at)`,
    [userId, email, emailCanonical, verified],
  );
}

async function upsertUserIdentity(client: PoolClient, userId: string, identity: ExternalIdentity): Promise<void> {
  await client.query(
    `INSERT INTO public.user_identities
      (user_id, provider, provider_user_id, provider_email, provider_email_verified, profile_json, linked_at, last_used_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
     ON CONFLICT (provider, provider_user_id)
     DO UPDATE SET
       user_id = EXCLUDED.user_id,
       provider_email = EXCLUDED.provider_email,
       provider_email_verified = EXCLUDED.provider_email_verified,
       profile_json = EXCLUDED.profile_json,
       last_used_at = NOW()`,
    [
      userId,
      identity.provider,
      identity.providerUserId,
      identity.email,
      identity.emailVerified,
      JSON.stringify(identity.rawProfile ?? {}),
    ],
  );
}

export async function resolveOrCreateInternalUser(identity: ExternalIdentity): Promise<{ userId: string }> {
  return runInTx(async (client) => {
    let user = await getUserByIdentity(client, identity);
    if (!user && identity.email && identity.emailVerified) {
      user = await getUserByCanonicalEmail(client, canonicalEmail(identity.email));
    }
    if (!user) {
      user = await createUser(client, identity);
    }
    if (identity.email) {
      await upsertUserEmail(client, user.id, identity.email, identity.emailVerified);
    }
    await upsertUserIdentity(client, user.id, identity);
    await ensurePlayerRole(client, user.id);
    await ensureAdminRoleWhenEligible(client, user.id, identity.email);
    await client.query(
      `UPDATE public.users
       SET
         primary_email = COALESCE($2, primary_email),
         is_email_verified = is_email_verified OR $3,
         display_name = COALESCE($4, display_name),
         avatar_url = COALESCE($5, avatar_url),
         last_login_at = NOW(),
         updated_at = NOW()
       WHERE id = $1::uuid`,
      [user.id, identity.email, identity.emailVerified, identity.displayName, identity.pictureUrl],
    );
    return { userId: user.id };
  });
}

export async function listUserRoleKeys(userId: string): Promise<string[]> {
  const pool = getPool();
  const r = await pool.query<{ role_key: string }>(
    `SELECT r.role_key
     FROM public.user_roles ur
     JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = $1::uuid`,
    [userId],
  );
  return r.rows.map((row) => row.role_key);
}

export async function createSession(input: {
  userId: string;
  clientType: "web" | "mobile";
  refreshTokenHash: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  csrfTokenHash?: string | null;
  expiresAt: Date;
}): Promise<{ sessionId: string }> {
  const pool = getPool();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO public.user_sessions
      (user_id, client_type, refresh_token_hash, user_agent, ip_address, csrf_token_hash, expires_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
     RETURNING id::text AS id`,
    [
      input.userId,
      input.clientType,
      input.refreshTokenHash,
      input.userAgent ?? null,
      input.ipAddress ?? null,
      input.csrfTokenHash ?? null,
      input.expiresAt.toISOString(),
    ],
  );
  return { sessionId: r.rows[0]?.id ?? "" };
}

export async function getActiveSession(sessionId: string): Promise<{
  userId: string;
  clientType: "web" | "mobile";
  revokedAt: string | null;
  expiresAt: string;
  csrfTokenHash: string | null;
  refreshTokenHash: string;
}> {
  const pool = getPool();
  const r = await pool.query<{
    user_id: string;
    client_type: "web" | "mobile";
    revoked_at: string | null;
    expires_at: string;
    csrf_token_hash: string | null;
    refresh_token_hash: string;
  }>(
    `SELECT user_id::text, client_type, revoked_at::text, expires_at::text, csrf_token_hash, refresh_token_hash
     FROM public.user_sessions
     WHERE id = $1::uuid`,
    [sessionId],
  );
  if (!r.rows[0]) throw new Error("session_not_found");
  return {
    userId: r.rows[0].user_id,
    clientType: r.rows[0].client_type,
    revokedAt: r.rows[0].revoked_at,
    expiresAt: r.rows[0].expires_at,
    csrfTokenHash: r.rows[0].csrf_token_hash,
    refreshTokenHash: r.rows[0].refresh_token_hash,
  };
}

export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE public.user_sessions
     SET revoked_at = NOW(), revoked_reason = $2
     WHERE id = $1::uuid AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

export async function getUserStatus(userId: string): Promise<"active" | "suspended" | "deleted" | null> {
  const pool = getPool();
  const result = await pool.query<{ status: "active" | "suspended" | "deleted" }>(
    `SELECT status
     FROM public.users
     WHERE id = $1::uuid
     LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.status ?? null;
}

export async function logAuthEvent(input: {
  userId: string | null;
  sessionId?: string | null;
  eventType: string;
  provider?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO public.auth_events
      (user_id, session_id, event_type, provider, ip_address, user_agent, metadata_json)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb)`,
    [
      input.userId,
      input.sessionId ?? null,
      input.eventType,
      input.provider ?? null,
      input.ipAddress ?? null,
      input.userAgent ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function updateSessionRefreshTokenHash(sessionId: string, refreshTokenHash: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE public.user_sessions
     SET refresh_token_hash = $2, updated_at = NOW()
     WHERE id = $1::uuid`,
    [sessionId, refreshTokenHash],
  );
}

export async function rotateSessionRefreshTokenHash(
  sessionId: string,
  expectedRefreshTokenHash: string,
  nextRefreshTokenHash: string,
  slidingExpiresAt?: Date,
): Promise<boolean> {
  const pool = getPool();
  if (slidingExpiresAt) {
    const result = await pool.query(
      `UPDATE public.user_sessions
       SET refresh_token_hash = $3, updated_at = NOW(), expires_at = $4
       WHERE id = $1::uuid
         AND refresh_token_hash = $2
         AND revoked_at IS NULL`,
      [sessionId, expectedRefreshTokenHash, nextRefreshTokenHash, slidingExpiresAt.toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }
  const result = await pool.query(
    `UPDATE public.user_sessions
     SET refresh_token_hash = $3, updated_at = NOW()
     WHERE id = $1::uuid
       AND refresh_token_hash = $2
       AND revoked_at IS NULL`,
    [sessionId, expectedRefreshTokenHash, nextRefreshTokenHash],
  );
  return (result.rowCount ?? 0) > 0;
}
