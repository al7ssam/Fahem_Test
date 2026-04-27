export type FactoryLayer = "architect" | "creator" | "auditor" | "refiner";
export type FactoryReasoningLevel = "none" | "low" | "medium" | "high";

export type FactoryDifficulty = "mix" | "easy" | "medium" | "hard";
export type FactoryQuestionType = "conceptual" | "procedural" | "application";

export type FactoryQuestion = {
  prompt: string;
  options: string[];
  correctIndex: number;
  studyBody: string;
  subcategoryKey: string;
  difficulty: "easy" | "medium" | "hard";
  questionType: FactoryQuestionType;
};

export type FactoryJobPayload = {
  subcategoryKey: string;
  targetCount: number;
  batchSize: number;
  difficultyMode: FactoryDifficulty;
};

export type FactoryAuditReport = {
  summary: string;
  issues: string[];
};

export type FactoryValidationError = {
  code: string;
  field: string;
  index: number;
  message: string;
  before?: unknown;
  after?: unknown;
};

export type LayerModelConfig = {
  layerName: FactoryLayer;
  provider: string;
  modelName: string;
  apiKeyEnv: string;
  temperature: number;
  maxOutputTokens: number;
  isEnabled: boolean;
  reasoningLevel: FactoryReasoningLevel;
};
