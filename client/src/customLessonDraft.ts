import type { LessonAiPromptParams } from "./lessonPromptBuilder";

const STORAGE_KEY = "fahem.customLesson.draft.v1";

export type CustomLessonDraftV1 = {
  version: 1;
  clientLessonId: string;
  updatedAt: string;
  learningIntent: string;
  jsonText: string;
  promptParams: LessonAiPromptParams;
  /** اختياري: آخر رمز جلسة من السيرفر */
  lastSessionToken?: string | null;
  /** بعد نسخ البرومبت تُظهر خطوة لصق JSON (يُستعاد من المسودة) */
  showJsonPanel?: boolean;
};

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `cl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function loadCustomLessonDraft(): CustomLessonDraftV1 | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<CustomLessonDraftV1>;
    if (o.version !== 1 || !o.promptParams) return null;
    return {
      version: 1,
      clientLessonId: typeof o.clientLessonId === "string" ? o.clientLessonId : randomId(),
      updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : new Date().toISOString(),
      learningIntent: typeof o.learningIntent === "string" ? o.learningIntent : "",
      jsonText: typeof o.jsonText === "string" ? o.jsonText : "",
      promptParams: o.promptParams as LessonAiPromptParams,
      lastSessionToken: o.lastSessionToken ?? null,
      showJsonPanel: typeof o.showJsonPanel === "boolean" ? o.showJsonPanel : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCustomLessonDraft(draft: Omit<CustomLessonDraftV1, "version" | "updatedAt"> & { updatedAt?: string }): void {
  const full: CustomLessonDraftV1 = {
    version: 1,
    clientLessonId: draft.clientLessonId || randomId(),
    updatedAt: draft.updatedAt ?? new Date().toISOString(),
    learningIntent: draft.learningIntent,
    jsonText: draft.jsonText,
    promptParams: draft.promptParams,
    lastSessionToken: draft.lastSessionToken ?? null,
    showJsonPanel: draft.showJsonPanel,
  };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(full));
  } catch {
    /* ignore quota */
  }
}

export function clearCustomLessonDraft(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
