export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
};

const ACCESS_KEY = "fahem_auth_access_token";
const REFRESH_KEY = "fahem_auth_refresh_token";

function safeGet(key: string): string {
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore storage failures
  }
}

export function getAuthTokens(): AuthTokens | null {
  const accessToken = safeGet(ACCESS_KEY);
  const refreshToken = safeGet(REFRESH_KEY);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

export function saveAuthTokens(tokens: AuthTokens): void {
  safeSet(ACCESS_KEY, tokens.accessToken);
  safeSet(REFRESH_KEY, tokens.refreshToken);
}

export function clearAuthTokens(): void {
  safeRemove(ACCESS_KEY);
  safeRemove(REFRESH_KEY);
}

export function readCookie(name: string): string {
  try {
    const target = `${name}=`;
    const parts = document.cookie.split(";").map((x) => x.trim());
    const hit = parts.find((p) => p.startsWith(target));
    if (!hit) return "";
    const raw = hit.slice(target.length);
    /** المتصفح يعيد قيمة الكوكي مفسَّرة؛ تجنُّب decodeURIComponent قد يفسد قيم base64url لـ CSRF */
    try {
      return /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
    } catch {
      return raw;
    }
  } catch {
    return "";
  }
}
