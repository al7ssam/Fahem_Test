/**
 * Approximate Gemini API cost (USD) for simple-content estimates.
 * Source of truth for numbers: https://ai.google.dev/gemini-api/docs/pricing — Paid tier, Standard.
 * Last reviewed manually: 2026-04-28. Update when Google changes list prices.
 * Does not include grounding, caching, or tier variants (Batch/Flex/Priority).
 */

export type GeminiPriceRow = {
  usdPerMillionInput: number;
  usdPerMillionOutput: number;
  note: string;
};

/** Paid Standard tier, text; Pro uses <=200k prompt tier for simplicity. */
const TABLE: Record<string, GeminiPriceRow> = {
  "gemini-2.5-flash": {
    usdPerMillionInput: 0.3,
    usdPerMillionOutput: 2.5,
    note: "2.5 Flash Standard (text)",
  },
  "gemini-2.5-pro": {
    usdPerMillionInput: 1.25,
    usdPerMillionOutput: 10.0,
    note: "2.5 Pro Standard, prompts <=200k tokens (simplified)",
  },
  "gemini-3-flash-preview": {
    usdPerMillionInput: 0.5,
    usdPerMillionOutput: 3.0,
    note: "Gemini 3 Flash Preview Standard (text)",
  },
  /** Approx. from same doc tier as Gemini 3 Pro family; verify on pricing page when Google updates. */
  "gemini-3.1-pro-preview": {
    usdPerMillionInput: 2.0,
    usdPerMillionOutput: 12.0,
    note: "Gemini 3.1 Pro Preview Standard (text, approx.)",
  },
};

export function estimateGeminiCallCostUsd(
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

export const GEMINI_PRICING_DOC_URL = "https://ai.google.dev/gemini-api/docs/pricing";
