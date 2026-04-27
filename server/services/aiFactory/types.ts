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
  conceptIdsReferenced?: string[];
  difficultySignals?: {
    isAnswerExplicit: boolean;
    explicitFactCount: number;
    crossConceptCount: number;
  };
};

export type FactoryJobPayload = {
  subcategoryKey: string;
  targetCount: number;
  batchSize: number;
  difficultyMode: FactoryDifficulty;
};

export type FactoryAuditReport = {
  summary: string;
  issues: Array<{
    code: string;
    index: number;
    field: string;
    evidence: string;
    confidence: "high" | "medium" | "low";
    severity: "blocking" | "non_blocking";
  }>;
  patches: Array<{
    op: "replace";
    index: number;
    field:
      | "questionType"
      | "difficulty"
      | "studyBody"
      | "prompt"
      | "options"
      | "correctIndex"
      | "conceptIdsReferenced"
      | "difficultySignals";
    value: unknown;
  }>;
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
