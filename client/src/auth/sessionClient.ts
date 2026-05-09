import { clearAuthTokens, getAuthTokens, readCookie, saveAuthTokens } from "./authClient";
import { apiFetch } from "./apiClient";

export type SessionUserPayload = {
  id: string;
  roles: string[];
  email: string | null;
  displayName: string | null;
};

export async function exchangeFirebaseToken(input: {
  firebaseIdToken: string;
  clientType?: "web" | "mobile";
  traceId?: string;
  traceStagesFlow?: "default";
}): Promise<{ user: SessionUserPayload }> {
  const ts = new Date().toISOString();
  if (input.traceId) {
    console.info("[auth-trace]", {
      ts,
      traceId: input.traceId,
      stage: "exchange_fetch_dispatch",
    });
  }
  const r = await fetch("/api/auth/exchange", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(input.traceId ? { "X-Auth-Trace-Id": input.traceId } : {}),
    },
    credentials: "include",
    body: JSON.stringify({
      provider: "firebase",
      externalToken: input.firebaseIdToken,
      clientType: input.clientType ?? "web",
    }),
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
    if (input.traceId) {
      console.info("[auth-trace]", {
        ts: new Date().toISOString(),
        traceId: input.traceId,
        stage: "exchange_fetch_failed",
        status: r.status,
        reason: body.reason ?? body.error ?? "unknown",
      });
    }
    throw new Error(body.reason || body.error || "auth_exchange_failed");
  }
  const body = (await r.json()) as {
    user?: SessionUserPayload;
    tokens?: { accessToken?: string; refreshToken?: string };
  };
  if (body.tokens?.accessToken && body.tokens?.refreshToken) {
    saveAuthTokens({
      accessToken: body.tokens.accessToken,
      refreshToken: body.tokens.refreshToken,
    });
  }
  if (!body.user) throw new Error("auth_user_missing");
  const user: SessionUserPayload = {
    id: body.user.id,
    roles: body.user.roles,
    email: body.user.email ?? null,
    displayName: body.user.displayName ?? null,
  };
  if (input.traceId) {
    console.info("[auth-trace]", {
      ts: new Date().toISOString(),
      traceId: input.traceId,
      stage: "exchange_fetch_success",
      hasTokens: Boolean(body.tokens?.accessToken && body.tokens?.refreshToken),
      hasUser: true,
    });
  }
  return { user };
}

export async function fetchCurrentUser(): Promise<{ id: string; email: string | null; displayName: string | null; roles: string[] }> {
  const r = await apiFetch("/api/auth/me");
  if (!r.ok) throw new Error(r.status === 401 ? "auth_unauthorized" : "auth_me_failed");
  const body = (await r.json()) as {
    user?: { id: string; email: string | null; displayName: string | null; roles: string[] };
  };
  if (!body.user) throw new Error("auth_me_missing");
  return body.user;
}

export async function logout(): Promise<void> {
  const refreshToken = getAuthTokens()?.refreshToken;
  const csrfToken = readCookie("fahem_csrf_token");
  await fetch("/api/auth/logout", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    credentials: "include",
    body: JSON.stringify({ refreshToken }),
  });
  clearAuthTokens();
}
