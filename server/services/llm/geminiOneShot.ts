/**
 * استدعاء Gemini من خط واحد (مسار المحتوى البسيط وغيره) دون الاعتماد على مصنع الطبقات.
 */
import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
} from "@google/generative-ai";
import type { GenerationConfig } from "@google/generative-ai";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_REQUEST_TIMEOUT_MS = 120_000;
const GEMINI_PROCESS_LEVEL_TIMEOUT_MS = GEMINI_REQUEST_TIMEOUT_MS + 30_000;

const GEMINI_V1_MODEL_IDS = new Set<string>([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash-lite",
]);

const THINKING_LEVEL_MODEL_IDS: readonly string[] = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
];

export type GeminiOneShotModelCallResult = {
  text: string;
  rawResponseText: string;
  finishReason: string | null;
  apiVersion: "v1" | "v1beta";
  modelName: string;
  provider: string;
  usageMetadata: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    raw: unknown;
  };
};

function supportsThinkingLevel(modelName: string): boolean {
  return THINKING_LEVEL_MODEL_IDS.includes(modelName);
}

type ReasoningLevel = "none" | "low" | "medium" | "high";

function normalizeGeminiModelId(raw: string): string {
  let s = String(raw ?? "").trim();
  if (s.startsWith("models/")) {
    s = s.slice("models/".length).trim();
  }
  return s;
}

function logGeminiRequestUrl(apiVersion: string, modelId: string): void {
  const path = `${GEMINI_API_BASE}/${apiVersion}/models/${encodeURIComponent(modelId)}:generateContent?key=REDACTED`;
  console.log("[callGeminiOneShot] POST", path);
}

function selectApiVersion(modelId: string, reasoningLevel: ReasoningLevel): "v1" | "v1beta" {
  const needsThinking = supportsThinkingLevel(modelId) && reasoningLevel !== "none";
  if (needsThinking) return "v1beta";
  return GEMINI_V1_MODEL_IDS.has(modelId) ? "v1" : "v1beta";
}

function getEnvValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function isQuotaOrRateLimitMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  if (m.includes("resource_exhausted")) return true;
  if (m.includes("resource exhausted")) return true;
  if (m.includes("too many requests")) return true;
  if (m.includes("rate limit")) return true;
  if (m.includes("quota") && (m.includes("exceeded") || m.includes("exhausted"))) return true;
  return false;
}

function mapUnknownErrorToProviderError(error: unknown, ctx?: { modelId?: string; apiVersion?: string }): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const short = msg.length > 220 ? `${msg.slice(0, 220)}…` : msg;
  const suffix =
    ctx?.modelId || ctx?.apiVersion ? ` model=${ctx?.modelId ?? "?"} api=${ctx?.apiVersion ?? "?"}` : "";
  return new Error(`provider_error:${short}${suffix}`);
}

function mapGeminiProviderError(error: unknown, ctx?: { modelId: string; apiVersion: string }): Error {
  if (error instanceof RateLimitError) return error;

  if (error instanceof GoogleGenerativeAIFetchError) {
    const status = error.status ?? 0;
    if (status === 429) {
      return new RateLimitError("provider_429", 2000);
    }
    if (status === 503) {
      return new RateLimitError("provider_503", 2000);
    }
    if (status === 404) {
      return new Error(`provider_404_model_or_version:model=${ctx?.modelId ?? "?"}:api=${ctx?.apiVersion ?? "?"}`);
    }
    if (status === 401 || status === 403) {
      return new Error(`provider_401_403_auth:model=${ctx?.modelId ?? "?"}:api=${ctx?.apiVersion ?? "?"}`);
    }
    if (isQuotaOrRateLimitMessage(error.message)) {
      return new RateLimitError("provider_quota_or_rate_limit", 3000);
    }
    return new Error(`provider_http_${status}:model=${ctx?.modelId ?? "?"}:api=${ctx?.apiVersion ?? "?"}`);
  }

  if (error instanceof GoogleGenerativeAIResponseError) {
    const msg = error.message ?? "";
    if (isQuotaOrRateLimitMessage(msg)) {
      return new RateLimitError("provider_quota_or_rate_limit", 3000);
    }
    const short = msg.length > 180 ? `${msg.slice(0, 180)}…` : msg;
    return new Error(
      `provider_response:${short || "blocked_or_invalid"}:model=${ctx?.modelId ?? "?"}:api=${ctx?.apiVersion ?? "?"}`,
    );
  }

  if (error instanceof Error && isQuotaOrRateLimitMessage(error.message)) {
    return new RateLimitError("provider_quota_or_rate_limit", 3000);
  }

  return mapUnknownErrorToProviderError(error, ctx);
}

/** Parse finishReason from `JSON.stringify(response)` shape used in inspection logs. */
export function extractGeminiFinishReason(rawResponseText: string): string | null {
  try {
    const obj = JSON.parse(rawResponseText) as { candidates?: Array<{ finishReason?: unknown }> };
    const fr = obj?.candidates?.[0]?.finishReason;
    return typeof fr === "string" && fr.trim() ? fr.trim() : null;
  } catch {
    return null;
  }
}

async function callGeminiOneShotInner(
  input: { modelName: string; apiKeyEnv: string; temperature: number; maxOutputTokens: number },
  prompt: string,
): Promise<GeminiOneShotModelCallResult> {
  const apiKey = getEnvValue(input.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`missing_api_key_env_${input.apiKeyEnv}`);
  }

  const normalizedId = normalizeGeminiModelId(input.modelName);
  const reasoningLevel: ReasoningLevel = "none";
  const needsThinking = supportsThinkingLevel(normalizedId) && reasoningLevel !== "none";
  const apiVersion = selectApiVersion(normalizedId, reasoningLevel);

  logGeminiRequestUrl(apiVersion, normalizedId);

  const generationConfig: GenerationConfig & { thinkingConfig?: { thinkingLevel: string; includeThoughts: boolean } } =
    {
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
    };
  if (needsThinking) {
    generationConfig.thinkingConfig = {
      thinkingLevel: reasoningLevel,
      includeThoughts: true,
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    { model: normalizedId, generationConfig },
    { apiVersion, timeout: GEMINI_REQUEST_TIMEOUT_MS },
  );

  try {
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("gemini_process_timeout_exceeded"));
        }, GEMINI_PROCESS_LEVEL_TIMEOUT_MS);
      }),
    ]);
    const rawResponseText = JSON.stringify(result.response ?? {}, null, 2);
    const text = String(result.response.text() ?? "").trim();
    const usageRaw = (result.response as { usageMetadata?: unknown })?.usageMetadata;
    const usageObj = usageRaw && typeof usageRaw === "object" ? (usageRaw as Record<string, unknown>) : {};
    const inputTokens = Math.max(0, Math.floor(Number(usageObj.promptTokenCount ?? 0) || 0));
    const outputTokens = Math.max(0, Math.floor(Number(usageObj.candidatesTokenCount ?? 0) || 0));
    const totalCandidate = Number(usageObj.totalTokenCount ?? 0);
    const totalTokens = Number.isFinite(totalCandidate)
      ? Math.max(0, Math.floor(totalCandidate))
      : inputTokens + outputTokens;
    if (!text) {
      throw new Error("provider_empty_response");
    }
    const finishReason = extractGeminiFinishReason(rawResponseText);
    return {
      text,
      rawResponseText,
      finishReason,
      apiVersion,
      modelName: input.modelName,
      provider: "gemini",
      usageMetadata: {
        inputTokens,
        outputTokens,
        totalTokens,
        raw: usageRaw ?? null,
      },
    };
  } catch (error) {
    throw mapGeminiProviderError(error, { modelId: normalizedId, apiVersion });
  }
}

/** Single-turn Gemini call for simple content and other non-factory modules. */
export async function runGeminiOneShot(
  input: { modelName: string; apiKeyEnv: string; temperature: number; maxOutputTokens: number },
  prompt: string,
): Promise<GeminiOneShotModelCallResult> {
  return callGeminiOneShotInner(input, prompt);
}
