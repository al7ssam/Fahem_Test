import type { Pool } from "pg";
import { z } from "zod";
import type { LessonAiPromptParams } from "../../shared/lessonAiPrompt";
import {
  DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS,
  DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
  DEFAULT_LESSON_AI_PROMPT_TEMPLATE,
  lessonAiPromptTemplateContainsLegacyPlaceholders,
} from "../../shared/lessonAiPrompt";

export const LESSON_AI_PROMPT_SETTINGS_KEY = "lesson_ai_prompt_config_v1";

const fragmentEnum = z.enum([
  "head",
  "strictJsonRules",
  "midExample",
  "jsonExample",
  "structureAndItems",
  "quality",
  "paramsAndTopic",
  "closing",
]);

const lessonParamsPartialSchema = z.object({
  nSec: z.number().optional(),
  qSame: z.number().optional(),
  ansSec: z.number().optional(),
  studySec: z.number().optional(),
  topic: z.string().optional(),
  audience: z.string().optional(),
  minSentences: z.number().optional(),
  maxSentences: z.number().optional(),
});

/** Legacy — قراءة فقط من النسخ القديمة */
export const lessonAiPromptStoredConfigV1Schema = z
  .object({
    version: z.literal(1),
    defaults: lessonParamsPartialSchema.optional(),
    audienceOptions: z.array(z.object({ v: z.string(), t: z.string() })).optional(),
    fragmentEnabled: z.record(fragmentEnum, z.boolean()).optional(),
    fragmentOverrides: z.record(fragmentEnum, z.string()).optional(),
  })
  .strict();

export type LessonAiPromptStoredConfigV1 = z.infer<typeof lessonAiPromptStoredConfigV1Schema>;

const MAX_PROMPT_TEMPLATE_CHARS = 200_000;

export const lessonAiPromptStoredConfigV2Schema = z
  .object({
    version: z.literal(2),
    promptTemplate: z.string().max(MAX_PROMPT_TEMPLATE_CHARS),
    defaults: lessonParamsPartialSchema.optional(),
    audienceOptions: z.array(z.object({ v: z.string(), t: z.string() })).optional(),
  })
  .strict();

export type LessonAiPromptStoredConfigV2 = z.infer<typeof lessonAiPromptStoredConfigV2Schema>;

export type LessonAiPromptStoredUnion = LessonAiPromptStoredConfigV1 | LessonAiPromptStoredConfigV2;

export type ResolvedLessonAiPromptPublicConfig = {
  defaults: LessonAiPromptParams;
  audienceOptions: Array<{ v: string; t: string }>;
  /** القالب الفعلي للتوليد (من DB أو الافتراضي من الكود). */
  promptTemplate: string;
};

export function mergeLessonAiPromptStored(stored: LessonAiPromptStoredUnion | null): ResolvedLessonAiPromptPublicConfig {
  const partial =
    stored && (stored.version === 1 || stored.version === 2) && stored.defaults ? stored.defaults : {};
  const defaults: LessonAiPromptParams = {
    ...DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
    ...partial,
  };
  const audienceOptions =
    stored &&
    "audienceOptions" in stored &&
    stored.audienceOptions &&
    stored.audienceOptions.length > 0
      ? [...stored.audienceOptions]
      : [...DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS];

  let promptTemplate = DEFAULT_LESSON_AI_PROMPT_TEMPLATE;
  if (stored?.version === 2 && typeof stored.promptTemplate === "string") {
    const t = stored.promptTemplate.trim();
    if (t.length > 0) {
      /** قوالب v2 القديمة التي ما زالت تستخدم placeholders المحذوفة — لا نعرض {{qualityBlock}} إلخ حرفياً */
      promptTemplate = lessonAiPromptTemplateContainsLegacyPlaceholders(stored.promptTemplate)
        ? DEFAULT_LESSON_AI_PROMPT_TEMPLATE
        : stored.promptTemplate;
    }
  }

  return {
    defaults,
    audienceOptions,
    promptTemplate,
  };
}

function parseStoredJson(raw: unknown): LessonAiPromptStoredUnion | null {
  const v2 = lessonAiPromptStoredConfigV2Schema.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = lessonAiPromptStoredConfigV1Schema.safeParse(raw);
  if (v1.success) return v1.data;
  return null;
}

export async function getLessonAiPromptStored(pool: Pool): Promise<LessonAiPromptStoredUnion | null> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM public.app_settings WHERE key = $1 LIMIT 1`,
    [LESSON_AI_PROMPT_SETTINGS_KEY],
  );
  const raw = r.rows[0]?.value;
  if (raw == null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parseStoredJson(parsed);
  } catch {
    return null;
  }
}

export async function saveLessonAiPromptStored(
  pool: Pool,
  body: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = lessonAiPromptStoredConfigV2Schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_body" };
  }
  const json = JSON.stringify(parsed.data);
  await pool.query(
    `INSERT INTO public.app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [LESSON_AI_PROMPT_SETTINGS_KEY, json],
  );
  return { ok: true };
}
