import { Pool } from "pg";
import { config } from "../config";

function createPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.isProduction ? { rejectUnauthorized: false } : undefined,
  });
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
