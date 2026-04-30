import type { SimpleContentPreset } from "../types";
import type { LLMCompletionInput, LLMCompletionOutput, SimpleContentLLMProvider } from "./types";

export const openAiSimpleProviderStub: SimpleContentLLMProvider = {
  async complete(_input: LLMCompletionInput, _preset: SimpleContentPreset): Promise<LLMCompletionOutput> {
    throw new Error("openai_provider_not_implemented");
  },
};
