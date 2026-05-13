import { apiFetch } from "./auth/apiClient";

export type SavedLessonSummary = {
  id: string;
  title: string;
  /** إيموجي المكتبة؛ غائب أو فارغ يُعرَض كتاب افتراضياً */
  libraryIcon?: string | null;
  expiresAt: string;
  updatedAt: string;
};

export type SavedLessonDetailResponse = {
  ok?: boolean;
  lesson?: {
    id: string;
    title: string;
    libraryIcon?: string | null;
    payload: Record<string, unknown>;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
};

export async function fetchSavedLessonsList(): Promise<{
  ok: boolean;
  lessons?: SavedLessonSummary[];
  error?: string;
}> {
  const res = await apiFetch("/api/me/saved-lessons");
  const data = (await res.json()) as {
    ok?: boolean;
    lessons?: SavedLessonSummary[];
    error?: string;
  };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "list_failed" };
  }
  return { ok: true, lessons: data.lessons ?? [] };
}

export async function fetchSavedLessonDetail(id: string): Promise<SavedLessonDetailResponse> {
  const res = await apiFetch(`/api/me/saved-lessons/${encodeURIComponent(id)}`);
  const data = (await res.json()) as SavedLessonDetailResponse;
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "load_failed" };
  }
  return data;
}

export async function postSavedLesson(payload: Record<string, unknown>): Promise<{
  ok: boolean;
  error?: string;
  status?: number;
}> {
  const res = await apiFetch("/api/me/saved-lessons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "save_failed", status: res.status };
  }
  return { ok: true };
}

export async function patchSavedLesson(
  id: string,
  body: { title?: string; payload?: Record<string, unknown>; libraryIcon?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  /** المخطط في الخادم يقبل نصاً أو "" فقط؛ null يُرفَض من Zod فيُرسل فراغاً لمسح الأيقونة. */
  const serialized: Record<string, unknown> = {};
  if (body.title !== undefined) serialized.title = body.title;
  if (body.payload !== undefined) serialized.payload = body.payload;
  if (body.libraryIcon !== undefined) {
    serialized.libraryIcon = body.libraryIcon === null ? "" : body.libraryIcon;
  }
  const res = await apiFetch(`/api/me/saved-lessons/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serialized),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "update_failed" };
  }
  return { ok: true };
}

export async function deleteSavedLesson(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(`/api/me/saved-lessons/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "delete_failed" };
  }
  return { ok: true };
}

export async function fetchPublicSavedLessonsPolicy(): Promise<{
  retentionDays: number;
  maxLessonsPerUser: number;
} | null> {
  try {
    const res = await fetch("/api/public/user-saved-lessons-policy");
    const data = (await res.json()) as {
      ok?: boolean;
      policy?: { retentionDays: number; maxLessonsPerUser: number };
    };
    if (!res.ok || !data.policy) return null;
    return data.policy;
  } catch {
    return null;
  }
}
