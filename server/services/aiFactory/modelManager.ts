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
const REASONING_ORDER: FactoryReasoningLevel[] = ["none", "low", "medium", "high"];
const REASONING_CAP_DEFAULTS: Record<FactoryLayer, FactoryReasoningLevel> = {
  architect: "low",
  creator: "low",
  auditor: "none",
  refiner: "none",
};

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
  /** Gemini `candidates[0].finishReason` when present (e.g. STOP, MAX_TOKENS). */
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

export type LayerFailureMeta = {
  layer: FactoryLayer;
  providerCode: string | null;
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  modelName: string;
  apiVersion: "v1" | "v1beta" | null;
  providerMessage: string;
};

export class LayerExecutionError extends Error {
  readonly meta: LayerFailureMeta;
  constructor(message: string, meta: LayerFailureMeta) {
    super(message);
    this.meta = meta;
  }
}

class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";
const GEMINI_REQUEST_TIMEOUT_MS = 120_000;
/** Extra guard if the SDK does not abort the HTTP call when `timeout` elapses. */
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

function extractProviderCodeFromMessage(input: string): string | null {
  const m = input.match(/\b(4\d{2}|5\d{2}|429|503)\b/);
  if (m?.[1]) return m[1];
  if (input.includes("provider_429")) return "429";
  if (input.includes("provider_503")) return "503";
  const http = input.match(/provider_http_(\d{3})/);
  if (http?.[1]) return http[1];
  return null;
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
    error.message.includes("_disabled") ||
    error.message.startsWith("unsupported_") ||
    error.message.startsWith("missing_")
  );
}

function getEnvValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function parseReasoningLevel(raw: string): FactoryReasoningLevel | null {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  return null;
}

function minReasoningLevel(a: FactoryReasoningLevel, b: FactoryReasoningLevel): FactoryReasoningLevel {
  return REASONING_ORDER[Math.min(REASONING_ORDER.indexOf(a), REASONING_ORDER.indexOf(b))] ?? "none";
}

function resolveReasoningCap(layer: FactoryLayer): FactoryReasoningLevel {
  const fromLayerEnv = parseReasoningLevel(getEnvValue(`AI_FACTORY_REASONING_CAP_${layer.toUpperCase()}`));
  return fromLayerEnv ?? REASONING_CAP_DEFAULTS[layer];
}

function applyReasoningPolicy(layer: FactoryLayer, configured: FactoryReasoningLevel): FactoryReasoningLevel {
  const mode = getEnvValue("AI_FACTORY_REASONING_POLICY_MODE").toLowerCase() || "cap";
  if (mode === "off") return configured;
  return minReasoningLevel(configured, resolveReasoningCap(layer));
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
    reasoningLevel: applyReasoningPolicy(
      row.layer_name,
      (row.reasoning_level ?? AI_FACTORY_DEFAULT_REASONING_LEVEL) as FactoryReasoningLevel,
    ),
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
      modelName: config.modelName,
      provider: config.provider,
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

function currentApiVersionForConfig(config: LayerModelConfig): "v1" | "v1beta" {
  const normalizedId = normalizeGeminiModelId(config.modelName);
  return selectApiVersion(normalizedId, config.reasoningLevel);
}

export type LayerConfigHealth = {
  layer: FactoryLayer;
  status: "ok" | "warn" | "fail";
  reasons: string[];
  provider: string;
  modelName: string;
  apiVersion: "v1" | "v1beta";
  apiKeyEnv: string;
  envPresent: boolean;
  isEnabled: boolean;
  reasoningLevel: FactoryReasoningLevel;
};

export async function getLayerConfigHealth(layer: FactoryLayer): Promise<LayerConfigHealth> {
  const config = await readLayerConfig(layer);
  const reasons: string[] = [];
  const envPresent = Boolean(getEnvValue(config.apiKeyEnv));
  const apiVersion = currentApiVersionForConfig(config);
  if (!envPresent) reasons.push(`missing_api_key_env_${config.apiKeyEnv}`);
  if (config.provider !== "gemini") reasons.push(`unsupported_provider_${config.provider}`);
  if (config.reasoningLevel !== "none" && !supportsThinkingLevel(config.modelName)) {
    reasons.push("reasoning_level_not_supported_by_model");
  }
  return {
    layer,
    status: reasons.length ? "fail" : "ok",
    reasons,
    provider: config.provider,
    modelName: config.modelName,
    apiVersion,
    apiKeyEnv: config.apiKeyEnv,
    envPresent,
    isEnabled: config.isEnabled,
    reasoningLevel: config.reasoningLevel,
  };
}

export async function probeLayerModel(layer: FactoryLayer): Promise<
  | {
      ok: true;
      layer: FactoryLayer;
      status: "ok";
      providerCode: null;
      latencyMs: number;
      provider: string;
      modelName: string;
      apiVersion: "v1" | "v1beta";
    }
  | {
      ok: false;
      layer: FactoryLayer;
      status: "fail";
      providerCode: string | null;
      latencyMs: number;
      provider: string | null;
      modelName: string | null;
      apiVersion: "v1" | "v1beta" | null;
      error: string;
      retryable: boolean;
    }
> {
  const started = Date.now();
  let cfg: LayerModelConfig | null = null;
  try {
    cfg = await readLayerConfig(layer);
    await runLayerModel(layer, "Return exactly the word OK.");
    return {
      ok: true,
      layer,
      status: "ok",
      providerCode: null,
      latencyMs: Date.now() - started,
      provider: cfg.provider,
      modelName: cfg.modelName,
      apiVersion: currentApiVersionForConfig(cfg),
    };
  } catch (error) {
    const meta = error instanceof LayerExecutionError ? error.meta : null;
    return {
      ok: false,
      layer,
      status: "fail",
      providerCode: meta?.providerCode ?? (error instanceof Error ? extractProviderCodeFromMessage(error.message) : null),
      latencyMs: Date.now() - started,
      provider: meta?.modelName ? "gemini" : cfg?.provider ?? null,
      modelName: meta?.modelName ?? cfg?.modelName ?? null,
      apiVersion: meta?.apiVersion ?? (cfg ? currentApiVersionForConfig(cfg) : null),
      error: error instanceof Error ? error.message : "probe_failed",
      retryable: meta?.retryable ?? false,
    };
  }
}

export async function runLayerModel(layer: FactoryLayer, prompt: string): Promise<ModelCallResult> {
  const config = await readLayerConfig(layer);
  const maxAttempts = 4;
  let attempt = 0;
  let waitMs = 1000;
  let lastActualError: Error | null = null;
  const apiVersion = currentApiVersionForConfig(config);

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      if (config.provider !== "gemini") {
        throw new Error(`unsupported_provider_${config.provider}`);
      }
      return await callGemini(config, prompt);
    } catch (error) {
      if (error instanceof Error) {
        lastActualError = error;
      } else {
        lastActualError = new Error(String(error));
      }
      const providerCode = extractProviderCodeFromMessage(lastActualError.message);
      const retryable = !isNonRetryableLayerError(error);
      if (isNonRetryableLayerError(error)) {
        throw new LayerExecutionError(`${layer}_failed: ${lastActualError.message}${providerCode ? ` (${providerCode})` : ""}`, {
          layer,
          providerCode,
          retryable,
          attempt,
          maxAttempts,
          modelName: config.modelName,
          apiVersion,
          providerMessage: lastActualError.message,
        });
      }
      if (error instanceof RateLimitError) {
        const backoffMs = Math.max(error.retryAfterMs, waitMs);
        await sleep(backoffMs);
        waitMs = Math.min(30_000, Math.floor(waitMs * 2));
        continue;
      }
      if (attempt >= maxAttempts) {
        throw new LayerExecutionError(
          `${layer}_failed: ${lastActualError.message}${providerCode ? ` (${providerCode})` : ""}`,
          {
            layer,
            providerCode,
            retryable,
            attempt,
            maxAttempts,
            modelName: config.modelName,
            apiVersion,
            providerMessage: lastActualError.message,
          },
        );
      }
      await sleep(waitMs);
      waitMs = Math.min(30_000, Math.floor(waitMs * 2));
    }
  }
  const reason = lastActualError?.message || "unknown_provider_error";
  const code = extractProviderCodeFromMessage(reason);
  const suffix = code ? ` (${code})` : "";
  throw new LayerExecutionError(`${layer}_failed: ${reason}${suffix}`, {
    layer,
    providerCode: code,
    retryable: true,
    attempt: maxAttempts,
    maxAttempts,
    modelName: config.modelName,
    apiVersion,
    providerMessage: reason,
  });
}
