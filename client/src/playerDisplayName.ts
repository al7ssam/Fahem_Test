import { apiFetch } from "./auth/apiClient";
import { getAuthState } from "./auth/authStore";

export const PLAYER_NAME_STORAGE_KEY = "fahem.playerName";

const MAX_GAME_NAME = 32;

export type CachedProfileNames = {
  firstName: string | null;
  lastName: string | null;
};

let cachedProfile: CachedProfileNames | null = null;

export function getProfileNameCache(): CachedProfileNames | null {
  return cachedProfile;
}

export function setProfileNameCache(p: CachedProfileNames | null): void {
  cachedProfile = p;
  window.dispatchEvent(new CustomEvent("fahem:profile-cache-updated"));
}

export function updateProfileNameCacheFromPayload(profile: CachedProfileNames): void {
  setProfileNameCache({ firstName: profile.firstName, lastName: profile.lastName });
}

function clampGameName(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_GAME_NAME) return t;
  return t.slice(0, MAX_GAME_NAME);
}

function profileDisplayFromCache(): string | null {
  if (!cachedProfile) return null;
  const f = (cachedProfile.firstName ?? "").trim();
  const l = (cachedProfile.lastName ?? "").trim();
  if (f && l) return `${f} ${l}`;
  if (f) return f;
  if (l) return l;
  return null;
}

export function getStoredPlayerName(): string {
  try {
    return (window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY) ?? "").trim();
  } catch {
    return "";
  }
}

export function storePlayerName(name: string): void {
  try {
    window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
  } catch {
    /* ignore */
  }
}

/**
 * اسم اللعب الفعّال: ملف شخصي (كاش) ثم displayName من المصادقة ثم الاسم المحلي ثم «مجهول».
 */
export function getEffectivePlayerName(playerNameDraft: string): string {
  const fromProfile = profileDisplayFromCache();
  if (fromProfile) return clampGameName(fromProfile);

  const auth = getAuthState();
  if (auth.status === "authenticated" && auth.user?.displayName?.trim()) {
    return clampGameName(auth.user.displayName.trim());
  }

  const local = (playerNameDraft || getStoredPlayerName()).trim();
  if (local) return clampGameName(local);

  return "مجهول";
}

/** اسم قصير للترحيب (نفس الأولويات تقريباً). */
export function getWelcomeDisplayName(playerNameDraft: string): string {
  const full = getEffectivePlayerName(playerNameDraft);
  if (full !== "مجهول") return full;
  const auth = getAuthState();
  if (auth.status === "authenticated" && auth.user?.email?.trim()) {
    const e = auth.user.email.trim();
    const at = e.indexOf("@");
    return at > 0 ? e.slice(0, at) : e;
  }
  return "مستخدم";
}

function splitLocalName(raw: string): { firstName: string; lastName: string | null } {
  const s = raw.trim();
  if (!s) return { firstName: "", lastName: null };
  const i = s.indexOf(" ");
  if (i === -1) return { firstName: s, lastName: null };
  return { firstName: s.slice(0, i).trim() || s, lastName: s.slice(i + 1).trim() || null };
}

/** يجلب الملف بعد المصادقة ويحدّث الكاش؛ ويمزامن الاسم المحلي إن وُجد ولم يُعرَّف الاسم الأول بعد. */
export async function refreshProfileCacheAfterAuth(): Promise<void> {
  if (getAuthState().status !== "authenticated") {
    setProfileNameCache(null);
    return;
  }
  try {
    const res = await apiFetch("/api/profile/me");
    if (!res.ok) return;
    const body = (await res.json()) as {
      ok?: boolean;
      profile?: { firstName: string | null; lastName: string | null };
    };
    if (!body.ok || !body.profile) return;
    updateProfileNameCacheFromPayload({
      firstName: body.profile.firstName,
      lastName: body.profile.lastName,
    });
    await syncLocalPlayerNameToProfileIfNeeded();
  } catch {
    /* ignore */
  }
}

async function syncLocalPlayerNameToProfileIfNeeded(): Promise<void> {
  if (getAuthState().status !== "authenticated") return;
  const f = cachedProfile?.firstName?.trim();
  if (f) return;
  const local = getStoredPlayerName();
  if (!local) return;
  const { firstName, lastName } = splitLocalName(local);
  if (!firstName) return;
  try {
    const res = await apiFetch("/api/profile/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName, lastName }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      ok?: boolean;
      profile?: { firstName: string | null; lastName: string | null };
    };
    if (body.ok && body.profile) {
      updateProfileNameCacheFromPayload({
        firstName: body.profile.firstName,
        lastName: body.profile.lastName,
      });
    }
  } catch {
    /* ignore */
  }
}
