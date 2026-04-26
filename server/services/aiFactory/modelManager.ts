import { getPool } from "../../db/pool";
import { sleep } from "./utils";
import type { FactoryLayer, LayerModelConfig } from "./types";

type ModelCallResult = {
  text: string;
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

function getEnvValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function parseRetryAfterMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return 0;
  const n = Number(retryAfter);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const parsedDate = Date.parse(retryAfter);
  if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - Date.now());
  return 0;
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
  }>(
    `SELECT layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled
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
  }>(
    `SELECT layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled
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
  }));
}

export async function saveModelConfig(input: LayerModelConfig): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO ai_factory_model_config (layer_name, provider, model_name, api_key_env, temperature, max_output_tokens, is_enabled, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (layer_name) DO UPDATE SET
       provider = EXCLUDED.provider,
       model_name = EXCLUDED.model_name,
       api_key_env = EXCLUDED.api_key_env,
       temperature = EXCLUDED.temperature,
       max_output_tokens = EXCLUDED.max_output_tokens,
       is_enabled = EXCLUDED.is_enabled,
       updated_at = NOW()`,
    [
      input.layerName,
      input.provider,
      input.modelName,
      input.apiKeyEnv,
      input.temperature,
      input.maxOutputTokens,
      input.isEnabled,
    ],
  );
}

async function callGemini(config: LayerModelConfig, prompt: string): Promise<ModelCallResult> {
  const apiKey = getEnvValue(config.apiKeyEnv);
  if (!apiKey) {
    throw new Error(`missing_api_key_env_${config.apiKeyEnv}`);
  }
  const model = encodeURIComponent(config.modelName);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: config.temperature,
      maxOutputTokens: config.maxOutputTokens,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    throw new RateLimitError("provider_rate_limited", parseRetryAfterMs(res.headers));
  }
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`provider_http_${res.status}:${txt.slice(0, 500)}`);
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = String(data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  if (!text) {
    throw new Error("provider_empty_response");
  }
  return {
    text,
    modelName: config.modelName,
    provider: config.provider,
  };
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
