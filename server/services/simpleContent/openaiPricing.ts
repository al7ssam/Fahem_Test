/**
 * Approximate OpenAI API cost (USD) for simple-content estimates.
 * Source: https://platform.openai.com/docs/models (input/output MTok prices).
 * Last reviewed manually: 2026-04-30.
 */
export type OpenAiPriceRow = {
  usdPerMillionInput: number;
  usdPerMillionOutput: number;
  note: string;
};

const TABLE: Record<string, OpenAiPriceRow> = {
  "gpt-5.5": {
    usdPerMillionInput: 5.0,
    usdPerMillionOutput: 30.0,
    note: "GPT-5.5",
  },
  "gpt-5.4-mini": {
    usdPerMillionInput: 2.5,
    usdPerMillionOutput: 15.0,
    note: "GPT-5.4 mini",
  },
  "gpt-5.4-nano": {
    usdPerMillionInput: 0.75,
    usdPerMillionOutput: 4.5,
    note: "GPT-5.4 nano",
  },
};

export function estimateOpenAiCallCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number | null; pricingTier: string } {
  const row = TABLE[modelId];
  if (!row) {
    return { usd: null, pricingTier: "unknown_model" };
  }
  const usd =
    (Math.max(0, inputTokens) / 1_000_000) * row.usdPerMillionInput +
    (Math.max(0, outputTokens) / 1_000_000) * row.usdPerMillionOutput;
  return { usd, pricingTier: row.note };
}

export const OPENAI_PRICING_DOC_URL = "https://platform.openai.com/docs/models";
