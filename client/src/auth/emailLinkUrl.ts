/**
 * Firebase Email Link redirects append query params such as mode, oobCode, apiKey.
 * Strip them after successful completion so refresh does not retry a consumed code.
 */
const FIREBASE_LINK_PARAM_KEYS = [
  "oobCode",
  "mode",
  "apiKey",
  "continueUrl",
  "lang",
  "type",
  "identifier",
];

export function cleanupEmailLinkLandingUrl(options: { preserveAuthIntent?: boolean } = {}): void {
  const u = new URL(window.location.href);
  u.searchParams.delete("authAction");
  if (!options.preserveAuthIntent) {
    for (const key of FIREBASE_LINK_PARAM_KEYS) {
      u.searchParams.delete(key);
    }
  }
  const qs = u.searchParams.toString();
  const next = qs ? `${u.pathname}?${qs}${u.hash}` : `${u.pathname}${u.hash}`;
  history.replaceState({}, "", next);
}

/**
 * Canonical continue URL for ActionCodeSettings.url — stable across SPA deep links.
 * Set VITE_FIREBASE_EMAIL_LINK_CONTINUE_URL on Render (e.g. https://your-app.onrender.com/).
 */
export function buildMagicLinkContinueUrl(): URL {
  const raw = String(import.meta.env.VITE_FIREBASE_EMAIL_LINK_CONTINUE_URL ?? "").trim();
  if (raw) {
    try {
      const abs = raw.includes("://") ? raw : new URL(raw, window.location.origin).toString();
      const u = new URL(abs);
      u.searchParams.set("authAction", "emailLinkComplete");
      return u;
    } catch {
      console.warn("[auth-trace]", { stage: "magic_link_continue_url_invalid_env", raw });
    }
  }
  const landing = new URL("/", window.location.origin);
  landing.searchParams.set("authAction", "emailLinkComplete");
  return landing;
}

export function readEmailLinkOobCode(): string | null {
  return new URLSearchParams(window.location.search).get("oobCode");
}
