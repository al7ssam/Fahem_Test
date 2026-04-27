import { Pool } from "pg";
import { config } from "../config";

function useSslForConnectionString(url: string): boolean {
  try {
    const u = new URL(url.replace(/^postgres(ql)?:\/\//, "http://"));
    return u.hostname !== "localhost" && u.hostname !== "127.0.0.1";
  } catch {
    return config.isProduction;
  }
}

function createPool(): Pool {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const ssl =
    useSslForConnectionString(config.databaseUrl) || config.isProduction
      ? { rejectUnauthorized: false }
      : undefined;
  return new Pool({
    connectionString: config.databaseUrl,
    ssl,
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
