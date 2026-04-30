export type SimpleContentProviderId = "gemini" | "openai";

export type SimpleContentPreset = {
  id: number;
  provider: SimpleContentProviderId;
  modelId: string;
  labelAr: string;
  maxOutputTokens: number;
  temperature: number;
  apiKeyEnv: string;
  isActive: boolean;
  sortOrder: number;
};

export type SimpleContentAutomation = {
  subcategoryKey: string;
  enabled: boolean;
  intervalMinutes: number;
  modelPresetId: number | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
};
