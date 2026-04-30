import type { SimpleContentPreset } from "../types";
import { geminiSimpleProvider } from "./geminiAdapter";
import { openAiSimpleProvider } from "./openaiAdapter";
import type { SimpleContentLLMProvider } from "./types";

export function resolveSimpleContentProvider(preset: SimpleContentPreset): SimpleContentLLMProvider {
  if (preset.provider === "openai") return openAiSimpleProvider;
  return geminiSimpleProvider;
}
