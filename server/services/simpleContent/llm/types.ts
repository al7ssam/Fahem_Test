import type { SimpleContentPreset } from "../types";

export type LLMCompletionInput = {
  prompt: string;
};

export type LLMTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type LLMCompletionOutput = {
  text: string;
  rawResponseText: string;
  finishReason: string | null;
  usage?: LLMTokenUsage | null;
};

export interface SimpleContentLLMProvider {
  complete(input: LLMCompletionInput, preset: SimpleContentPreset): Promise<LLMCompletionOutput>;
}
