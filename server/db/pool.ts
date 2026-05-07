import { Pool, type PoolClient } from "pg";
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
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl,
    max: config.isProduction ? 20 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: "fahem-server",
  });
  pool.on("connect", (client) => {
    void applySessionDefaults(client);
  });
  pool.on("error", (error) => {
    console.error("[db_pool] unexpected_client_error", error);
  });
  return pool;
}

async function applySessionDefaults(client: PoolClient): Promise<void> {
  try {
    // Deterministic SQL should always use public.<table>. This remains fallback only.
    await client.query("SET search_path TO public");
  } catch (error) {
    console.error("[db_pool] session_init_failed", error);
  }
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
