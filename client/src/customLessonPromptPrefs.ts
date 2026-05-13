import type { LessonAiPromptParams } from "./lessonPromptBuilder";
import { clampCustomLessonFlowParams } from "./lessonPromptBuilder";

const STORAGE_KEY = "fahem.customLesson.promptPrefs.v1";

export type StoredPromptPrefsV1 = {
  version: 1;
  params: LessonAiPromptParams;
};

export function hasLocalCustomLessonPromptPrefs(): boolean {
  return loadCustomLessonPromptPrefs() != null;
}

export function loadCustomLessonPromptPrefs(): StoredPromptPrefsV1 | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<StoredPromptPrefsV1>;
    if (o.version !== 1 || !o.params || typeof o.params !== "object") return null;
    return {
      version: 1,
      params: clampCustomLessonFlowParams(o.params as LessonAiPromptParams),
    };
  } catch {
    return null;
  }
}

export function saveCustomLessonPromptPrefs(params: LessonAiPromptParams): void {
  const full: StoredPromptPrefsV1 = {
    version: 1,
    params: clampCustomLessonFlowParams(params),
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  } catch {
    /* ignore quota */
  }
}

export function clearCustomLessonPromptPrefs(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** يدمج تفضيل المستخدم فوق قاعدة ثابتة من الواجهة (`DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS` بعد clamp). */
export function mergeUserPromptParamsWithSiteDefaults(
  siteBase: LessonAiPromptParams,
  user: LessonAiPromptParams | null | undefined,
): LessonAiPromptParams {
  if (user == null) return siteBase;
  return clampCustomLessonFlowParams({
    ...siteBase,
    ...user,
    topic: "",
  });
}
