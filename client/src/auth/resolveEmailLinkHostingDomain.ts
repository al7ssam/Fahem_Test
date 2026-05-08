/**
 * Firebase rejects sendSignInLinkToEmail when `linkDomain` is not one of your project's
 * authorized Hosting / Dynamic Link hosts (often auth/invalid-hosting-link-domain).
 * Render/production domains like *.onrender.com must NOT appear here unless you went
 * through Firebase Hosting authorization for Email Link explicitly.
 */

function normalizeToHostname(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  try {
    const withScheme = t.includes("://") ? t : `https://${t}`;
    const u = new URL(withScheme);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return t.replace(/^[^a-z0-9.-]+|[^a-z0-9.-]+$/gi, "").toLowerCase();
  }
}

function isFirebaseDefaultLinkHostingHost(hostname: string): boolean {
  if (!hostname) return false;
  if (hostname.endsWith(".firebaseapp.com")) return true;
  if (hostname.endsWith(".web.app")) return true;
  if (hostname.includes(".page.link")) return true;
  return false;
}

/**
 * Resolve value for ActionCodeSettings.linkDomain, or omit (undefined).
 */
export function resolveEmailLinkActionCodeLinkDomain(linkDomainEnvRaw: string | undefined): {
  hostname: string | undefined;
  droppedReason?: string;
} {
  const raw = String(linkDomainEnvRaw ?? "").trim();
  if (!raw) {
    return { hostname: undefined };
  }

  const force = String(import.meta.env.VITE_FIREBASE_ALLOW_EMAIL_LINK_DOMAIN ?? "").trim() === "1";
  const host = normalizeToHostname(raw);

  if (!host) {
    return { hostname: undefined, droppedReason: "empty_hostname_after_normalize" };
  }

  if (force) {
    return { hostname: host };
  }

  if (isFirebaseDefaultLinkHostingHost(host)) {
    return { hostname: host };
  }

  return {
    hostname: undefined,
    droppedReason:
      "not_default_firebase_link_host:set_VITE_FIREBASE_ALLOW_EMAIL_LINK_DOMAIN=1_after_configuring_in_Console_if_needed",
  };
}
