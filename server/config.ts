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
};
