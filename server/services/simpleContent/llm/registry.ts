import type { SimpleContentPreset } from "../types";
import { geminiSimpleProvider } from "./geminiAdapter";
import { openAiSimpleProviderStub } from "./openaiAdapter";
import type { SimpleContentLLMProvider } from "./types";

export function resolveSimpleContentProvider(preset: SimpleContentPreset): SimpleContentLLMProvider {
  if (preset.provider === "openai") return openAiSimpleProviderStub;
  return geminiSimpleProvider;
}
