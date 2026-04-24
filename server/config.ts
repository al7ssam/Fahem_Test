import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const port = Number(process.env.PORT) || 3000;
const nodeEnv = process.env.NODE_ENV || "development";
const databaseUrl = process.env.DATABASE_URL;
const clientOrigin =
  process.env.CLIENT_ORIGIN ||
  (nodeEnv === "development" ? "http://localhost:5173" : undefined);
const adminSecret = process.env.ADMIN_SECRET?.trim() || "";

const studyPhaseMs = Number(process.env.STUDY_PHASE_MS) || 60_000;
const studyQuizBlockSize = Number(process.env.STUDY_QUIZ_BLOCK_SIZE) || 8;
const maxStudyCardsDisplay = Number(process.env.MAX_STUDY_CARDS_DISPLAY) || 8;

/** عدد الأسئلة المُسبَقة قبل مراجعة واحدة في بداية المباراة (نمط study_then_quiz) */
const studyMatchPrefetch = Math.min(
  200,
  Math.max(1, Number(process.env.STUDY_MATCH_PREFETCH) || 50),
)
/** سقف إجمالي لبطاقات المراجعة الشاملة في بداية المباراة */
const maxStudyCardsMatchStart = Math.min(
  10_000,
  Math.max(1, Number(process.env.MAX_STUDY_CARDS_MATCH_START) || 1000),
)

export const config = {
  port,
  nodeEnv,
  databaseUrl,
  clientOrigin,
  isProduction: nodeEnv === "production",
  adminSecret,
  studyPhaseMs,
  studyQuizBlockSize,
  maxStudyCardsDisplay,
  studyMatchPrefetch,
  maxStudyCardsMatchStart,
};
