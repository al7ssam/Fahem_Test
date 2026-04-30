import { extractGeminiFinishReason, runGeminiOneShot } from "../../aiFactory/modelManager";
import type { SimpleContentPreset } from "../types";
import type { LLMCompletionInput, LLMCompletionOutput, SimpleContentLLMProvider } from "./types";

export const geminiSimpleProvider: SimpleContentLLMProvider = {
  async complete(input: LLMCompletionInput, preset: SimpleContentPreset): Promise<LLMCompletionOutput> {
    const r = await runGeminiOneShot(
      {
        modelName: preset.modelId,
        apiKeyEnv: preset.apiKeyEnv,
        temperature: preset.temperature,
        maxOutputTokens: preset.maxOutputTokens,
      },
      input.prompt,
    );
    return {
      text: r.text,
      rawResponseText: r.rawResponseText,
      finishReason: r.finishReason ?? extractGeminiFinishReason(r.rawResponseText),
    };
  },
};
