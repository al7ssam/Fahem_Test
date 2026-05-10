import { apiFetch } from "./auth/apiClient";
import type { LessonAiPromptParams } from "./lessonPromptBuilder";

export async function fetchMeCustomLessonPromptParams(): Promise<{
  ok: boolean;
  params: LessonAiPromptParams | null;
  error?: string;
}> {
  const res = await apiFetch("/api/me/custom-lesson-prompt-params");
  const data = (await res.json()) as {
    ok?: boolean;
    params?: LessonAiPromptParams | null;
    error?: string;
  };
  if (!res.ok || data.ok === false) {
    return { ok: false, params: null, error: data.error ?? "load_failed" };
  }
  return { ok: true, params: data.params ?? null };
}

export async function putMeCustomLessonPromptParams(
  params: LessonAiPromptParams,
): Promise<{ ok: boolean; error?: string }> {
  const body = {
    nSec: params.nSec,
    qSame: params.qSame,
    ansSec: params.ansSec,
    studySec: params.studySec,
    audience: params.audience,
    minSentences: params.minSentences,
    maxSentences: params.maxSentences,
  };
  const res = await apiFetch("/api/me/custom-lesson-prompt-params", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "save_failed" };
  }
  return { ok: true };
}

export async function deleteMeCustomLessonPromptParams(): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch("/api/me/custom-lesson-prompt-params", {
    method: "DELETE",
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    return { ok: false, error: data.error ?? "clear_failed" };
  }
  return { ok: true };
}
