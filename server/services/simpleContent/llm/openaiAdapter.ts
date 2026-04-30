import type { SimpleContentPreset } from "../types";
import type { LLMCompletionInput, LLMCompletionOutput, SimpleContentLLMProvider } from "./types";
import OpenAI from "openai";

function getEnvValue(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function extractOutputText(raw: unknown): string {
  const resp = raw as {
    output_text?: unknown;
    output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
  };

  if (typeof resp?.output_text === "string" && resp.output_text.trim()) {
    return resp.output_text;
  }

  const chunks: string[] = [];
  for (const item of resp?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part?.type === "output_text" && typeof part.text === "string" && part.text.length > 0) {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function mapFinishReason(raw: unknown): string | null {
  const resp = raw as {
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
  };
  const incompleteReason = typeof resp?.incomplete_details?.reason === "string"
    ? resp.incomplete_details.reason
    : "";
  if (incompleteReason === "max_output_tokens") return "MAX_TOKENS";
  if (incompleteReason === "content_filter") return "CONTENT_FILTER";
  if (resp?.status === "completed") return "STOP";
  return null;
}

function mapOpenAiProviderError(error: unknown): Error {
  if (error instanceof OpenAI.APIError) {
    const status = Number(error.status ?? 0);
    const msg = String(error.message || "");
    if (status === 401 || status === 403) return new Error("openai_auth_failed");
    if (status === 429) return new Error("openai_rate_limited_429");
    if (status >= 500) return new Error(`openai_server_error_${status}`);
    if (status === 400 && /unsupported parameter/i.test(msg) && /temperature/i.test(msg)) {
      return new Error(`openai_unsupported_temperature:${msg}`);
    }
    return new Error(`openai_http_${status || "unknown"}:${msg}`);
  }
  if (error instanceof Error) {
    const msg = String(error.message || "").toLowerCase();
    if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("econn")) {
      return new Error("openai_network_timeout");
    }
    return new Error(`openai_unknown_error:${error.message}`);
  }
  return new Error("openai_unknown_error");
}

export const openAiSimpleProvider: SimpleContentLLMProvider = {
  async complete(input: LLMCompletionInput, preset: SimpleContentPreset): Promise<LLMCompletionOutput> {
    const apiKey = getEnvValue(preset.apiKeyEnv || "OPENAI_API_KEY");
    if (!apiKey) {
      throw new Error(`openai_api_key_missing:${preset.apiKeyEnv || "OPENAI_API_KEY"}`);
    }
    const client = new OpenAI({ apiKey });
    try {
      const response = await client.responses.create({
        model: preset.modelId,
        input: input.prompt,
        max_output_tokens: preset.maxOutputTokens,
        store: false,
      });
      const text = extractOutputText(response);
      if (!text) {
        throw new Error("openai_empty_output");
      }
      const usage = response.usage
        ? {
            inputTokens: Number(response.usage.input_tokens ?? 0),
            cachedInputTokens: Number(response.usage.input_tokens_details?.cached_tokens ?? 0),
            outputTokens: Number(response.usage.output_tokens ?? 0),
            totalTokens: Number(
              response.usage.total_tokens ??
                Number(response.usage.input_tokens ?? 0) + Number(response.usage.output_tokens ?? 0),
            ),
          }
        : null;
      return {
        text,
        rawResponseText: safeJsonStringify(response),
        finishReason: mapFinishReason(response),
        usage,
      };
    } catch (error) {
      throw mapOpenAiProviderError(error);
    }
  },
};
