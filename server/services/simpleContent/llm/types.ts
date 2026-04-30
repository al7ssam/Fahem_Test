import type { SimpleContentPreset } from "../types";

export type LLMCompletionInput = {
  prompt: string;
};

export type LLMCompletionOutput = {
  text: string;
  rawResponseText: string;
  finishReason: string | null;
};

export interface SimpleContentLLMProvider {
  complete(input: LLMCompletionInput, preset: SimpleContentPreset): Promise<LLMCompletionOutput>;
}
