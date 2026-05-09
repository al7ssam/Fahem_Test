import { getAuthTokens, readCookie, saveAuthTokens } from "./authClient";

let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshTokens(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const tokens = getAuthTokens();
    /** الويب يضع refresh في كوكي HttpOnly فقط؛ الخادم يقبل التحديث من الكوكي إذا كان الجسم فارغاً. */
    const refreshFromStorage = tokens?.refreshToken?.trim();
    const payload = refreshFromStorage ? { refreshToken: refreshFromStorage } : {};
    const csrfToken = readCookie("fahem_csrf_token");
    const r = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      },
      credentials: "include",
      body: JSON.stringify(payload),
    });
    if (!r.ok) return false;
    const body = (await r.json()) as { accessToken?: string; refreshToken?: string };
    if (!body.accessToken || !body.refreshToken) return false;
    saveAuthTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
    window.dispatchEvent(new CustomEvent("fahem:auth-tokens-refreshed"));
    return true;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const tokens = getAuthTokens();
  const headers = new Headers(init?.headers ?? {});
  if (tokens?.accessToken) {
    headers.set("Authorization", `Bearer ${tokens.accessToken}`);
  }
  const method = String(init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = readCookie("fahem_csrf_token");
    if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  }
  let res = await fetch(input, { ...init, headers, credentials: "include" });
  if (res.status !== 401) return res;
  const refreshed = await tryRefreshTokens();
  if (!refreshed) return res;
  const retryTokens = getAuthTokens();
  const retryHeaders = new Headers(init?.headers ?? {});
  if (retryTokens?.accessToken) {
    retryHeaders.set("Authorization", `Bearer ${retryTokens.accessToken}`);
  }
  if (method !== "GET" && method !== "HEAD") {
    const retryCsrfToken = readCookie("fahem_csrf_token");
    if (retryCsrfToken) retryHeaders.set("X-CSRF-Token", retryCsrfToken);
  }
  res = await fetch(input, { ...init, headers: retryHeaders, credentials: "include" });
  return res;
}
