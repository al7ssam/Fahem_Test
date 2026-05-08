import { FirebaseAuthProvider } from "./FirebaseAuthProvider";
import type { AuthProvider } from "./AuthProvider";
import {
  createSession,
  getActiveSession,
  getUserStatus,
  listUserRoleKeys,
  logAuthEvent,
  revokeSession,
  rotateSessionRefreshTokenHash,
  updateSessionRefreshTokenHash,
} from "./repository";
import {
  getAccessTtlSeconds,
  getRefreshTtlSeconds,
  getWebSessionTtlSeconds,
  hashToken,
  randomToken,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "./token";
import type { AuthenticatedUser } from "./types";
import { identityLinkingService } from "./IdentityLinkingService";

type ExchangeInput = {
  provider: string;
  externalToken: string;
  clientType: "web" | "mobile";
  userAgent?: string | null;
  ipAddress?: string | null;
};

type ExchangeResult = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string | null;
  sessionId: string;
  roles: string[];
  userId: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  webSessionTtlSeconds: number;
};

export class AuthService {
  private readonly providers = new Map<string, AuthProvider>();

  constructor() {
    const firebase = new FirebaseAuthProvider();
    this.providers.set(firebase.name, firebase);
  }

  private resolveProvider(name: string): AuthProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error("unsupported_provider");
    return provider;
  }

  async exchangeExternalToken(input: ExchangeInput): Promise<ExchangeResult> {
    const provider = this.resolveProvider(input.provider);
    const identity = await provider.verifyExternalToken(input.externalToken);
    const { userId } = await identityLinkingService.resolveUser(identity);
    const roles = await listUserRoleKeys(userId);

    const csrfTokenRaw = input.clientType === "web" ? randomToken() : null;
    const expiresAt = new Date(Date.now() + getRefreshTtlSeconds() * 1000);
    const { sessionId } = await createSession({
      userId,
      clientType: input.clientType,
      refreshTokenHash: hashToken(randomToken()),
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
      csrfTokenHash: csrfTokenRaw ? hashToken(csrfTokenRaw) : null,
      expiresAt,
    });

    const accessToken = signAccessToken({
      sub: userId,
      sid: sessionId,
      typ: "access",
      roles,
    });
    const refreshToken = signRefreshToken({
      sub: userId,
      sid: sessionId,
      typ: "refresh",
    });
    await updateSessionRefreshTokenHash(sessionId, hashToken(refreshToken));
    await logAuthEvent({
      userId,
      sessionId,
      eventType: "auth.exchange.success",
      provider: input.provider,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });

    return {
      accessToken,
      refreshToken,
      csrfToken: csrfTokenRaw,
      sessionId,
      roles,
      userId,
      accessTtlSeconds: getAccessTtlSeconds(),
      refreshTtlSeconds: getRefreshTtlSeconds(),
      webSessionTtlSeconds: getWebSessionTtlSeconds(),
    };
  }

  async refreshSession(refreshToken: string): Promise<ExchangeResult> {
    const payload = verifyRefreshToken(refreshToken);
    const session = await getActiveSession(payload.sid);
    if (session.revokedAt) throw new Error("session_revoked");
    if (new Date(session.expiresAt).getTime() <= Date.now()) throw new Error("session_expired");
    if (session.userId !== payload.sub) throw new Error("session_subject_mismatch");
    const userStatus = await getUserStatus(session.userId);
    if (userStatus !== "active") {
      await revokeSession(payload.sid, "user_inactive");
      throw new Error("user_inactive");
    }
    const presentedHash = hashToken(refreshToken);
    if (session.refreshTokenHash !== presentedHash) {
      await revokeSession(payload.sid, "refresh_token_reuse_detected");
      await logAuthEvent({
        userId: session.userId,
        sessionId: payload.sid,
        eventType: "auth.refresh.reuse_detected",
      });
      throw new Error("refresh_token_reuse_detected");
    }

    const roles = await listUserRoleKeys(session.userId);
    const nextAccessToken = signAccessToken({
      sub: session.userId,
      sid: payload.sid,
      typ: "access",
      roles,
    });
    const nextRefreshToken = signRefreshToken({
      sub: session.userId,
      sid: payload.sid,
      typ: "refresh",
    });
    const rotated = await rotateSessionRefreshTokenHash(payload.sid, presentedHash, hashToken(nextRefreshToken));
    if (!rotated) {
      await revokeSession(payload.sid, "refresh_rotation_conflict");
      await logAuthEvent({
        userId: session.userId,
        sessionId: payload.sid,
        eventType: "auth.refresh.rotation_conflict",
      });
      throw new Error("refresh_rotation_conflict");
    }
    await logAuthEvent({
      userId: session.userId,
      sessionId: payload.sid,
      eventType: "auth.refresh.success",
    });
    return {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      csrfToken: null,
      sessionId: payload.sid,
      roles,
      userId: session.userId,
      accessTtlSeconds: getAccessTtlSeconds(),
      refreshTtlSeconds: getRefreshTtlSeconds(),
      webSessionTtlSeconds: getWebSessionTtlSeconds(),
    };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthenticatedUser> {
    const payload = verifyAccessToken(accessToken);
    const session = await getActiveSession(payload.sid);
    if (session.revokedAt) throw new Error("session_revoked");
    if (new Date(session.expiresAt).getTime() <= Date.now()) throw new Error("session_expired");
    if (session.userId !== payload.sub) throw new Error("session_subject_mismatch");
    const userStatus = await getUserStatus(session.userId);
    if (userStatus !== "active") throw new Error("user_inactive");
    return {
      userId: payload.sub,
      sessionId: payload.sid,
      roles: payload.roles,
    };
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const payload = verifyRefreshToken(refreshToken);
    await revokeSession(payload.sid, "manual_logout");
    await logAuthEvent({
      userId: payload.sub,
      sessionId: payload.sid,
      eventType: "auth.logout.success",
    });
  }

  async validateRefreshCsrf(refreshToken: string, csrfToken: string): Promise<void> {
    const payload = verifyRefreshToken(refreshToken);
    const session = await getActiveSession(payload.sid);
    if (!session.csrfTokenHash) return;
    if (hashToken(csrfToken) !== session.csrfTokenHash) {
      throw new Error("csrf_mismatch");
    }
  }
}

export const authService = new AuthService();
