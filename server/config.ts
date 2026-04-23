import path from "path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

const port = Number(process.env.PORT) || 3000;
const nodeEnv = process.env.NODE_ENV || "development";
const databaseUrl = process.env.DATABASE_URL;
const clientOrigin =
  process.env.CLIENT_ORIGIN ||
  (nodeEnv === "development" ? "http://localhost:5173" : undefined);

export const config = {
  port,
  nodeEnv,
  databaseUrl,
  clientOrigin,
  isProduction: nodeEnv === "production",
};
