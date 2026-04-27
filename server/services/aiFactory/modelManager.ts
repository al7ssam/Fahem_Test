import {
  GoogleGenerativeAI,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIResponseError,
} from "@google/generative-ai";
import type { GenerationConfig } from "@google/generative-ai";
import { getPool } from "../../db/pool";
import { sleep } from "./utils";
import type { FactoryLayer, FactoryReasoningLevel, LayerModelConfig } from "./types";

/**
 * Model IDs supported for factory layers (must match ListModels + generateContent for your API key).
 * Synchronized with `npm run list-gemini-models` (v1beta) — update when Google adds/removes endpoints.
 */
export const AI_FACTORY_AVAILABLE_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
  "gemma-3-1b-it",
  "gemma-3-4b-it",
  "gemma-3-12b-it",
  "gemma-3-27b-it",
  "gemma-3n-e4b-it",
  "gemma-3n-e2b-it",
  "gemma-4-26b-a4b-it",
  "gemma-4-31b-it",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-pro-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-image",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-image-preview",
  "nano-banana-pro-preview",
  "gemini-3.1-flash-image-preview",
  "lyria-3-clip-preview",
  "lyria-3-pro-preview",
  "gemini-3.1-flash-tts-preview",
  "gemini-robotics-er-1.5-preview",
  "gemini-robotics-er-1.6-preview",
  "gemini-2.5-computer-use-preview-10-2025",
  "deep-research-max-preview-04-2026",
  "deep-research-preview-04-2026",
  "deep-research-pro-preview-12-2025",
] as const;
export const AI_FACTORY_DEFAULT_MODEL = "gemini-3-flash-preview";
export const AI_FACTORY_DEFAULT_API_KEY_ENV = "GEMINI_API_KEY";
export const AI_FACTORY_AVAILABLE_REASONING_LEVELS = ["none", "low", "medium", "high"] as const;
export const AI_FACTORY_DEFAULT_REASONING_LEVEL: FactoryReasoningLevel = "none";

/**
 * Models that use `generationConfig.thinkingConfig.thinkingLevel` (Gemini 3 family on `v1beta`).
 * Only include IDs from ListModels that are general Gemini 3 text/multimodal; omit TTS-only / agents if they reject this field.
 */
export const AI_FACTORY_THINKING_LEVEL_MODEL_IDS: readonly string[] = [
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
];

type ModelCallResult = {
  text: string;
  rawResponseText: string;
  apiVersion: "v1" | "v1beta";
  modelName: string;
  provider: string;
};

class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_REQUEST_TIMEOUT_MS = 120_000;
const GEMINI_V1_MODEL_IDS = new Set<string>([
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite-001",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash-lite",
]);

/** Strip accidental `models/` prefix so the SDK path is not doubled. */
function normalizeGeminiModelId(raw: string): string {
  let s = String(raw ?? "").trim();
  if (s.startsWith("models/")) {
    s = s.slice("models/".length).trim();
  }
  return s;
}

function logGeminiRequestUrl(apiVersion: string, modelId: string): void {
  const path = `${GEMINI_API_BASE}/${apiVersion}/models/${encodeURIComponent(modelId)}:generateContent?key=REDACTED`;
  console.log("[callGemini] POST", path);
}

function selectApiVersion(modelId: string, reasoningLevel: FactoryReasoningLevel): "v1" | "v1beta" {
  const needsThinking = supportsThinkingLevel(modelId) && reasoningLevel !== "none";
  if (needsThinking) return "v1beta";
  return GEMINI_V1_MODEL_IDS.has(modelId) ? "v1" : "v1beta";
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

/**
 * Maps SDK / HTTP failures to RateLimitError where backoff helps, else a short Error for last_error.
 * @google/generative-ai is legacy; Google recommends @google/genai for long-term support.
 */
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

function isNonRetryableLayerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.startsWith("provider_404") ||
    error.message.startsWith("provider_401_403") ||
    error.message.startsWith("unsupported_") ||
    error.message.startsWith("missing_")
  );
}

function getEnvValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

async function readLayerConfig(layer: FactoryLayer): Promise<LayerModelConfig> {
  const pool = getPool();
  const r = await pool.query<{
    layer_name: FactoryLayer;
    provider: string;
    model_name: string;
    api_key_env: string;
    temperature: number;
    max_output_tokens: number;
    is_enabled: boolean;
    reasoning_level: FactoryReasoningLevel;
  }>(
    `SELECT layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled, reasoning_level
     FROM ai_factory_model_config
     WHERE layer_name = $1
     LIMIT 1`,
    [layer],
  );
  const row = r.rows[0];
  if (!row) {
    throw new Error(`missing_model_config_for_${layer}`);
  }
  if (!row.is_enabled) {
    throw new Error(`layer_${layer}_disabled`);
  }
  return {
    layerName: row.layer_name,
    provider: row.provider,
    modelName: row.model_name,
    apiKeyEnv: row.api_key_env,
    temperature: Number(row.temperature),
    maxOutputTokens: Number(row.max_output_tokens),
    isEnabled: row.is_enabled,
    reasoningLevel: row.reasoning_level ?? AI_FACTORY_DEFAULT_REASONING_LEVEL,
  };
}

export async function listModelConfigs(): Promise<LayerModelConfig[]> {
  const pool = getPool();
  const r = await pool.query<{
    layer_name: FactoryLayer;
    provider: string;
    model_name: string;
    api_key_env: string;
    temperature: number;
    max_output_tokens: number;
    is_enabled: boolean;
    reasoning_level: FactoryReasoningLevel;
  }>(
    `SELECT layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled, reasoning_level
     FROM ai_factory_model_config
     ORDER BY layer_name ASC`,
  );
  return r.rows.map((row) => ({
    layerName: row.layer_name,
    provider: row.provider,
    modelName: row.model_name,
    apiKeyEnv: row.api_key_env,
    temperature: Number(row.temperature),
    maxOutputTokens: Number(row.max_output_tokens),
    isEnabled: row.is_enabled,
    reasoningLevel: row.reasoning_level ?? AI_FACTORY_DEFAULT_REASONING_LEVEL,
  }));
}

export async function saveModelConfig(input: LayerModelConfig): Promise<void> {
  if (!AI_FACTORY_AVAILABLE_MODELS.includes(input.modelName as (typeof AI_FACTORY_AVAILABLE_MODELS)[number])) {
    throw new Error(`unsupported_model_${input.modelName}`);
  }
  if (
    !AI_FACTORY_AVAILABLE_REASONING_LEVELS.includes(
      input.reasoningLevel as (typeof AI_FACTORY_AVAILABLE_REASONING_LEVELS)[number],
    )
  ) {
    throw new Error(`unsupported_reasoning_level_${input.reasoningLevel}`);
  }
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_factory_model_config (layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled, reasoning_level, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (layer_name) DO UPDATE SET
       provider = EXCLUDED.provider,
       model_name = EXCLUDED.model_name,
       api_key_env = EXCLUDED.api_key_env,
       temperature = EXCLUDED.temperature,
       max_output_tokens = EXCLUDED.max_output_tokens,
       is_enabled = EXCLUDED.is_enabled,
       reasoning_level = EXCLUDED.reasoning_level,
       updated_at = NOW()`,
    [
      input.layerName,
      input.provider,
      input.modelName,
      input.apiKeyEnv,
      input.temperature,
      input.maxOutputTokens,
      input.isEnabled,
      input.reasoningLevel,
    ],
  );
}

/** True if the model supports `generationConfig.thinkingConfig.thinkingLevel` (Gemini 3 API). */
export function supportsThinkingLevel(modelName: string): boolean {
  return AI_FACTORY_THINKING_LEVEL_MODEL_IDS.includes(modelName);
}

async function callGemini(config: LayerModelConfig, prompt: string): Promise<ModelCallResult> {
  const apiKey = getEnvValue(config.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`missing_api_key_env_${config.apiKeyEnv}`);
  }

  const normalizedId = normalizeGeminiModelId(config.modelName);
  const needsThinking = supportsThinkingLevel(normalizedId) && config.reasoningLevel !== "none";
  const apiVersion = selectApiVersion(normalizedId, config.reasoningLevel);

  logGeminiRequestUrl(apiVersion, normalizedId);

  const generationConfig: GenerationConfig & { thinkingConfig?: { thinkingLevel: string; includeThoughts: boolean } } = {
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  };
  if (needsThinking) {
    generationConfig.thinkingConfig = {
      thinkingLevel: config.reasoningLevel,
      includeThoughts: true,
    };
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel(
    { model: normalizedId, generationConfig },
    { apiVersion, timeout: GEMINI_REQUEST_TIMEOUT_MS },
  );

  try {
    const result = await model.generateContent(prompt);
    const rawResponseText = JSON.stringify(result.response ?? {}, null, 2);
    const text = String(result.response.text() ?? "").trim();
    if (!text) {
      throw new Error("provider_empty_response");
    }
    return {
      text,
      rawResponseText,
      apiVersion,
      modelName: config.modelName,
      provider: config.provider,
    };
  } catch (error) {
    throw mapGeminiProviderError(error, { modelId: normalizedId, apiVersion });
  }
}

export async function runLayerModel(layer: FactoryLayer, prompt: string): Promise<ModelCallResult> {
  const config = await readLayerConfig(layer);
  let attempt = 0;
  let waitMs = 1000;
  while (attempt < 4) {
    attempt += 1;
    try {
      if (config.provider !== "gemini") {
        throw new Error(`unsupported_provider_${config.provider}`);
      }
      return await callGemini(config, prompt);
    } catch (error) {
      if (isNonRetryableLayerError(error)) {
        throw error;
      }
      if (error instanceof RateLimitError) {
        const backoffMs = Math.max(error.retryAfterMs, waitMs);
        await sleep(backoffMs);
        waitMs = Math.min(30_000, Math.floor(waitMs * 2));
        continue;
      }
      if (attempt >= 4) throw error;
      await sleep(waitMs);
      waitMs = Math.min(30_000, Math.floor(waitMs * 2));
    }
  }
  throw new Error(`layer_${layer}_failed_after_retries`);
}
