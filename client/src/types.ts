export type GameMode = "direct" | "study_then_quiz" | "lesson";
export type DifficultyMode = "mix" | "easy" | "medium" | "hard";
export type Phase =
  | "name"
  | "custom_lesson"
  | "saved_lessons_library"
  | "saved_lesson_detail"
  | "saved_lesson_edit"
  | "lesson_menu"
  | "lesson_study"
  | "lesson_quiz"
  | "lesson_done"
  | "lesson_review"
  | "match_lesson_review"
  | "matchmaking"
  | "private_room_lobby"
  | "countdown"
  | "studying"
  | "playing"
  | "result";

export type LessonPlaybackStep = {
  sortOrder: number;
  questionId: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  studyBody: string | null;
  effectiveAnswerMs: number;
  effectiveStudyCardMs: number;
};

export type LessonPlaybackSection = {
  id: number;
  sortOrder: number;
  titleAr: string | null;
  studyPhaseMs?: number;
  steps: LessonPlaybackStep[];
};

export type LessonPlaybackPayload = {
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  category: { id: number; nameAr: string; icon: string } | null;
  sections?: LessonPlaybackSection[];
  steps: LessonPlaybackStep[];
};

export type NameFlowStep = "mode" | "main_categories" | "sub_categories" | "difficulty";
export type JoinKind = "public" | "solo" | "private_create" | "private_join";
export type ResultScreenKind = "win" | "lose" | "tie" | "empty";
export type ResumePolicy = "none" | "resume_only";

export type IncomingQuestionPayload = {
  questionId: number;
  prompt: string;
  options: string[];
  endsAt: number;
  serverNow?: number;
  revealKeysActive?: boolean;
  keysAttacksEnabled?: boolean;
  abilityCosts?: Partial<AbilityCostsPayload> | null;
  abilityToggles?: Partial<AbilityTogglesPayload> | null;
};

export type AbilityCostsPayload = {
  skillBoost: number;
  skipQuestion: number;
  heartAttack: number;
  reveal: number;
};

export type AbilityTogglesPayload = {
  skillBoost: boolean;
  skipQuestion: boolean;
  heartAttack: boolean;
  reveal: boolean;
};
