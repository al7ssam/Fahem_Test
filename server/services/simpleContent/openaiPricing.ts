export type OpenAiPriceRow = {
  inputPer1M: number;
  cachedInputPer1M: number;
  outputPer1M: number;
  note: string;
};

export const OPENAI_DEFAULT_PRICING_TABLE: Record<string, OpenAiPriceRow> = {
  "gpt-5.5": { inputPer1M: 5.0, cachedInputPer1M: 0.5, outputPer1M: 30.0, note: "default:gpt-5.5" },
  "gpt-5.4-mini": { inputPer1M: 2.5, cachedInputPer1M: 0.25, outputPer1M: 15.0, note: "default:gpt-5.4-mini" },
  "gpt-5.4-nano": { inputPer1M: 0.2, cachedInputPer1M: 0.05, outputPer1M: 1.25, note: "default:gpt-5.4-nano" },
};

export type OpenAiUsageForCost = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
};

export type OpenAiCostBreakdown = {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  inputCostUsd: number;
  cachedInputCostUsd: number;
  outputCostUsd: number;
};

function roundUsd6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

export function estimateOpenAiCostWithPricing(
  usage: OpenAiUsageForCost,
  pricing: OpenAiPriceRow,
): { usd: number; pricingTier: string; breakdown: OpenAiCostBreakdown } {
  const input = Math.max(0, Number(usage.inputTokens || 0));
  const cached = Math.max(0, Math.min(input, Number(usage.cachedInputTokens || 0)));
  const uncached = Math.max(0, input - cached);
  const output = Math.max(0, Number(usage.outputTokens || 0));

  const inputCost = (uncached / 1_000_000) * pricing.inputPer1M;
  const cachedCost = (cached / 1_000_000) * pricing.cachedInputPer1M;
  const outputCost = (output / 1_000_000) * pricing.outputPer1M;
  const raw = inputCost + cachedCost + outputCost;

  return {
    usd: roundUsd6(raw),
    pricingTier: pricing.note,
    breakdown: {
      uncachedInputTokens: uncached,
      cachedInputTokens: cached,
      outputTokens: output,
      inputCostUsd: inputCost,
      cachedInputCostUsd: cachedCost,
      outputCostUsd: outputCost,
    },
  };
}

export const OPENAI_PRICING_DOC_URL = "https://platform.openai.com/docs/models";
