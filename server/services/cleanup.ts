import type { PoolClient } from "pg";
import { getPool } from "../db/pool";

type CleanupSource = "manual" | "startup" | "cron";

const SETTINGS_KEYS = {
  enabled: "cleanup_auto_delete_enabled",
  thresholdDays: "cleanup_deletion_threshold_days",
  lastRunDate: "cleanup_last_run_date",
} as const;

const AI_FACTORY_LOGS_SETTINGS_KEYS = {
  enabled: "ai_factory_logs_cleanup_enabled",
  thresholdDays: "ai_factory_logs_cleanup_threshold_days",
  lastRunDate: "ai_factory_logs_cleanup_last_run_date",
} as const;

type CleanupSettings = {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
  lastRunDate: string;
};

type CleanupResult = {
  deletedCount: number;
  thresholdDays: number;
  runDate: string;
};

type AiFactoryLogsCleanupSettings = {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
  lastRunDate: string;
};

type AiFactoryLogsCleanupCounts = {
  jobLogsDeletedCount: number;
  inspectionLogsDeletedCount: number;
  totalDeletedCount: number;
};

type AiFactoryLogsCleanupResult = AiFactoryLogsCleanupCounts & {
  thresholdDays: number;
  runDate: string;
};

let runningCleanup: Promise<CleanupResult> | null = null;
let runningAiFactoryLogsCleanup: Promise<AiFactoryLogsCleanupResult> | null = null;

function parseEnabled(raw: string | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseThreshold(raw: string | undefined): number {
  const n = Number(raw ?? "30");
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.floor(n));
}

function normalizeRunDate(raw: string | undefined): string {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  return v.slice(0, 10);
}

function toISODate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function readSettingsMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    SETTINGS_KEYS.enabled,
    SETTINGS_KEYS.thresholdDays,
    SETTINGS_KEYS.lastRunDate,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

async function upsertSettings(
  client: PoolClient,
  rows: Array<{ key: string; value: string }>,
): Promise<void> {
  if (rows.length === 0) return;
  const valuesSql = rows
    .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
    .join(", ");
  const params = rows.flatMap((row) => [row.key, row.value]);
  await client.query(
    `INSERT INTO app_settings (key, value)
     VALUES ${valuesSql}
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    params,
  );
}

export async function getCleanupSettings(): Promise<CleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const map = await readSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SETTINGS_KEYS.enabled)),
      deletionThresholdDays: parseThreshold(map.get(SETTINGS_KEYS.thresholdDays)),
      lastRunDate: normalizeRunDate(map.get(SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function updateCleanupSettings(input: {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
}): Promise<CleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const thresholdDays = Math.max(1, Math.floor(input.deletionThresholdDays));
    await upsertSettings(client, [
      {
        key: SETTINGS_KEYS.enabled,
        value: input.autoDeleteEnabled ? "1" : "0",
      },
      {
        key: SETTINGS_KEYS.thresholdDays,
        value: String(thresholdDays),
      },
    ]);
    const map = await readSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SETTINGS_KEYS.enabled)),
      deletionThresholdDays: parseThreshold(map.get(SETTINGS_KEYS.thresholdDays)),
      lastRunDate: normalizeRunDate(map.get(SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function countExpiredQuestions(
  thresholdDays: number,
  clientArg?: PoolClient,
): Promise<number> {
  const run = async (client: PoolClient): Promise<number> => {
    const threshold = Math.max(1, Math.floor(thresholdDays));
    const result = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM questions
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    return Number(result.rows[0]?.c ?? 0);
  };

  if (clientArg) return run(clientArg);
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

export async function performCleanup(input: {
  source: CleanupSource;
  forceRun?: boolean;
}): Promise<CleanupResult> {
  if (runningCleanup) return runningCleanup;

  const pool = getPool();
  runningCleanup = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const settingsMap = await readSettingsMap(client);
      const enabled = parseEnabled(settingsMap.get(SETTINGS_KEYS.enabled));
      const thresholdDays = parseThreshold(settingsMap.get(SETTINGS_KEYS.thresholdDays));
      const today = toISODate();

      if (!input.forceRun && !enabled) {
        await client.query("ROLLBACK");
        console.log(`[cleanup] skipped source=${input.source} reason=disabled`);
        return { deletedCount: 0, thresholdDays, runDate: normalizeRunDate(settingsMap.get(SETTINGS_KEYS.lastRunDate)) };
      }

      const expiredCount = await countExpiredQuestions(thresholdDays, client);
      await client.query(
        `DELETE FROM questions
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );

      await upsertSettings(client, [
        { key: SETTINGS_KEYS.lastRunDate, value: today },
      ]);
      await client.query("COMMIT");

      console.log(
        `[cleanup] success source=${input.source} date=${today} thresholdDays=${thresholdDays} deleted=${expiredCount}`,
      );
      return { deletedCount: expiredCount, thresholdDays, runDate: today };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback error */
      }
      console.error(`[cleanup] failed source=${input.source}`, error);
      throw error;
    } finally {
      client.release();
      runningCleanup = null;
    }
  })();

  return runningCleanup;
}

export async function maybeRunStartupCleanup(): Promise<CleanupResult | null> {
  const settings = await getCleanupSettings();
  const today = toISODate();
  if (!settings.autoDeleteEnabled) {
    console.log("[cleanup] startup skipped reason=disabled");
    return null;
  }
  if (settings.lastRunDate === today) {
    console.log("[cleanup] startup skipped reason=already-ran-today");
    return null;
  }
  return performCleanup({ source: "startup" });
}

async function readAiFactoryLogsSettingsMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    AI_FACTORY_LOGS_SETTINGS_KEYS.enabled,
    AI_FACTORY_LOGS_SETTINGS_KEYS.thresholdDays,
    AI_FACTORY_LOGS_SETTINGS_KEYS.lastRunDate,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

export async function getAiFactoryLogsCleanupSettings(): Promise<AiFactoryLogsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const map = await readAiFactoryLogsSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: parseThreshold(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.thresholdDays)),
      lastRunDate: normalizeRunDate(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function updateAiFactoryLogsCleanupSettings(input: {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
}): Promise<AiFactoryLogsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const thresholdDays = Math.max(1, Math.floor(input.deletionThresholdDays));
    await upsertSettings(client, [
      {
        key: AI_FACTORY_LOGS_SETTINGS_KEYS.enabled,
        value: input.autoDeleteEnabled ? "1" : "0",
      },
      {
        key: AI_FACTORY_LOGS_SETTINGS_KEYS.thresholdDays,
        value: String(thresholdDays),
      },
    ]);
    const map = await readAiFactoryLogsSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: parseThreshold(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.thresholdDays)),
      lastRunDate: normalizeRunDate(map.get(AI_FACTORY_LOGS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function countExpiredAiFactoryLogs(
  thresholdDays: number,
  clientArg?: PoolClient,
): Promise<AiFactoryLogsCleanupCounts> {
  const run = async (client: PoolClient): Promise<AiFactoryLogsCleanupCounts> => {
    const threshold = Math.max(1, Math.floor(thresholdDays));
    const inspectionResult = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM ai_factory_inspection_logs
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    const jobLogsResult = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM ai_factory_job_logs
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    const inspectionLogsDeletedCount = Number(inspectionResult.rows[0]?.c ?? 0);
    const jobLogsDeletedCount = Number(jobLogsResult.rows[0]?.c ?? 0);
    return {
      jobLogsDeletedCount,
      inspectionLogsDeletedCount,
      totalDeletedCount: jobLogsDeletedCount + inspectionLogsDeletedCount,
    };
  };

  if (clientArg) return run(clientArg);
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

export async function performAiFactoryLogsCleanup(input: {
  source: CleanupSource;
  forceRun?: boolean;
}): Promise<AiFactoryLogsCleanupResult> {
  if (runningAiFactoryLogsCleanup) return runningAiFactoryLogsCleanup;

  const pool = getPool();
  runningAiFactoryLogsCleanup = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const settingsMap = await readAiFactoryLogsSettingsMap(client);
      const enabled = parseEnabled(settingsMap.get(AI_FACTORY_LOGS_SETTINGS_KEYS.enabled));
      const thresholdDays = parseThreshold(settingsMap.get(AI_FACTORY_LOGS_SETTINGS_KEYS.thresholdDays));
      const today = toISODate();

      if (!input.forceRun && !enabled) {
        await client.query("ROLLBACK");
        console.log(`[ai_factory_logs_cleanup] skipped source=${input.source} reason=disabled`);
        return {
          jobLogsDeletedCount: 0,
          inspectionLogsDeletedCount: 0,
          totalDeletedCount: 0,
          thresholdDays,
          runDate: normalizeRunDate(settingsMap.get(AI_FACTORY_LOGS_SETTINGS_KEYS.lastRunDate)),
        };
      }

      const counts = await countExpiredAiFactoryLogs(thresholdDays, client);
      await client.query(
        `DELETE FROM ai_factory_inspection_logs
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );
      await client.query(
        `DELETE FROM ai_factory_job_logs
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );

      await upsertSettings(client, [
        { key: AI_FACTORY_LOGS_SETTINGS_KEYS.lastRunDate, value: today },
      ]);
      await client.query("COMMIT");
      console.log(
        `[ai_factory_logs_cleanup] success source=${input.source} date=${today} thresholdDays=${thresholdDays} deleted=${counts.totalDeletedCount}`,
      );
      return {
        ...counts,
        thresholdDays,
        runDate: today,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback error */
      }
      console.error(`[ai_factory_logs_cleanup] failed source=${input.source}`, error);
      throw error;
    } finally {
      client.release();
      runningAiFactoryLogsCleanup = null;
    }
  })();

  return runningAiFactoryLogsCleanup;
}

export async function maybeRunStartupAiFactoryLogsCleanup(): Promise<AiFactoryLogsCleanupResult | null> {
  const settings = await getAiFactoryLogsCleanupSettings();
  const today = toISODate();
  if (!settings.autoDeleteEnabled) {
    console.log("[ai_factory_logs_cleanup] startup skipped reason=disabled");
    return null;
  }
  if (settings.lastRunDate === today) {
    console.log("[ai_factory_logs_cleanup] startup skipped reason=already-ran-today");
    return null;
  }
  return performAiFactoryLogsCleanup({ source: "startup" });
}
