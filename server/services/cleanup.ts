import type { PoolClient } from "pg";
import { getPool } from "../db/pool";

type CleanupSource = "manual" | "startup" | "cron";

const SETTINGS_KEYS = {
  enabled: "cleanup_auto_delete_enabled",
  thresholdDays: "cleanup_deletion_threshold_days",
  lastRunDate: "cleanup_last_run_date",
} as const;

const SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS = {
  enabled: "simple_content_pricing_audit_cleanup_enabled",
  lastRunDate: "simple_content_pricing_audit_cleanup_last_run_date",
} as const;

const AI_RETENTION_SETTINGS_KEYS = {
  retentionDays: "ai_cleanup_retention_days",
  pricingAuditRetentionDays: "ai_pricing_audit_retention_days",
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

export type CleanupTableStatsRow = {
  tableName: string;
  rowCount: number;
  totalBytes: number;
  totalSize: string;
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
};

let runningCleanup: Promise<CleanupResult> | null = null;
let runningSimpleContentPricingAuditCleanup: Promise<SimpleContentPricingAuditCleanupResult> | null = null;

function parseEnabled(raw: string | undefined): boolean {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function parseThreshold(raw: string | undefined): number {
  const n = Number(raw ?? "30");
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.floor(n));
}

function parseThresholdWithDefault(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
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
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

async function readAiRetentionMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    AI_RETENTION_SETTINGS_KEYS.retentionDays,
    AI_RETENTION_SETTINGS_KEYS.pricingAuditRetentionDays,
    SETTINGS_KEYS.thresholdDays,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
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
    `INSERT INTO public.app_settings (key, value)
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
      {
        key: AI_RETENTION_SETTINGS_KEYS.retentionDays,
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

async function resolveUnifiedAiRetentionDays(client: PoolClient): Promise<number> {
  const map = await readAiRetentionMap(client);
  const explicit = map.get(AI_RETENTION_SETTINGS_KEYS.retentionDays);
  if (explicit != null && String(explicit).trim() !== "") {
    return parseThreshold(explicit);
  }
  return parseThreshold(map.get(SETTINGS_KEYS.thresholdDays));
}

async function resolvePricingAuditRetentionDays(client: PoolClient): Promise<number> {
  const map = await readAiRetentionMap(client);
  return parseThresholdWithDefault(map.get(AI_RETENTION_SETTINGS_KEYS.pricingAuditRetentionDays), 180);
}

export async function countExpiredQuestions(
  thresholdDays: number,
  clientArg?: PoolClient,
): Promise<number> {
  const run = async (client: PoolClient): Promise<number> => {
    const threshold = Math.max(1, Math.floor(thresholdDays));
    const result = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM public.questions
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
        `DELETE FROM public.questions
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

const SIMPLE_CONTENT_RUNS_SETTINGS_KEYS = {
  enabled: "simple_content_runs_cleanup_enabled",
  thresholdDays: "simple_content_runs_cleanup_threshold_days",
  lastRunDate: "simple_content_runs_cleanup_last_run_date",
} as const;

type SimpleContentRunsCleanupSettings = {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
  lastRunDate: string;
};

type SimpleContentRunsCleanupResult = {
  deletedCount: number;
  thresholdDays: number;
  runDate: string;
};

let runningSimpleContentRunsCleanup: Promise<SimpleContentRunsCleanupResult> | null = null;

async function readSimpleContentRunsSettingsMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.enabled,
    SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.thresholdDays,
    SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.lastRunDate,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

export async function getSimpleContentRunsCleanupSettings(): Promise<SimpleContentRunsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const map = await readSimpleContentRunsSettingsMap(client);
    const unifiedThreshold = await resolveUnifiedAiRetentionDays(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: unifiedThreshold,
      lastRunDate: normalizeRunDate(map.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function updateSimpleContentRunsCleanupSettings(input: {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
}): Promise<SimpleContentRunsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const thresholdDays = Math.max(1, Math.floor(input.deletionThresholdDays));
    await upsertSettings(client, [
      {
        key: SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.enabled,
        value: input.autoDeleteEnabled ? "1" : "0",
      },
      {
        key: SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.thresholdDays,
        value: String(thresholdDays),
      },
      {
        key: AI_RETENTION_SETTINGS_KEYS.retentionDays,
        value: String(thresholdDays),
      },
    ]);
    const map = await readSimpleContentRunsSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: thresholdDays,
      lastRunDate: normalizeRunDate(map.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function countExpiredSimpleContentRuns(
  thresholdDays: number,
  clientArg?: PoolClient,
): Promise<number> {
  const threshold = Math.max(1, Math.floor(thresholdDays));
  const run = async (client: PoolClient): Promise<number> => {
    const r = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM public.simple_content_runs
       WHERE status IN ('succeeded', 'failed', 'pending_review')
         AND finished_at IS NOT NULL
         AND finished_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    return Number(r.rows[0]?.c ?? 0);
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

export async function performSimpleContentRunsCleanup(input: {
  source: CleanupSource;
  forceRun?: boolean;
}): Promise<SimpleContentRunsCleanupResult> {
  if (runningSimpleContentRunsCleanup) return runningSimpleContentRunsCleanup;

  const pool = getPool();
  runningSimpleContentRunsCleanup = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const settingsMap = await readSimpleContentRunsSettingsMap(client);
      const enabled = parseEnabled(settingsMap.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.enabled));
      const thresholdDays = await resolveUnifiedAiRetentionDays(client);
      const today = toISODate();

      if (!input.forceRun && !enabled) {
        await client.query("ROLLBACK");
        console.log(`[simple_content_runs_cleanup] skipped source=${input.source} reason=disabled`);
        return {
          deletedCount: 0,
          thresholdDays,
          runDate: normalizeRunDate(settingsMap.get(SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.lastRunDate)),
        };
      }

      const expiredCount = await countExpiredSimpleContentRuns(thresholdDays, client);
      await client.query(
        `DELETE FROM public.simple_content_runs
         WHERE status IN ('succeeded', 'failed', 'pending_review')
           AND finished_at IS NOT NULL
           AND finished_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );

      await upsertSettings(client, [
        { key: SIMPLE_CONTENT_RUNS_SETTINGS_KEYS.lastRunDate, value: today },
      ]);
      await client.query("COMMIT");
      console.log(
        `[simple_content_runs_cleanup] success source=${input.source} date=${today} thresholdDays=${thresholdDays} deleted=${expiredCount}`,
      );
      return {
        deletedCount: expiredCount,
        thresholdDays,
        runDate: today,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback error */
      }
      console.error(`[simple_content_runs_cleanup] failed source=${input.source}`, error);
      throw error;
    } finally {
      client.release();
      runningSimpleContentRunsCleanup = null;
    }
  })();

  return runningSimpleContentRunsCleanup;
}

export async function maybeRunStartupSimpleContentRunsCleanup(): Promise<SimpleContentRunsCleanupResult | null> {
  const settings = await getSimpleContentRunsCleanupSettings();
  const today = toISODate();
  if (!settings.autoDeleteEnabled) {
    console.log("[simple_content_runs_cleanup] startup skipped reason=disabled");
    return null;
  }
  if (settings.lastRunDate === today) {
    console.log("[simple_content_runs_cleanup] startup skipped reason=already-ran-today");
    return null;
  }
  return performSimpleContentRunsCleanup({ source: "startup" });
}

type SimpleContentPricingAuditCleanupSettings = {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
  lastRunDate: string;
};

type SimpleContentPricingAuditCleanupResult = {
  deletedCount: number;
  thresholdDays: number;
  runDate: string;
};

async function readSimpleContentPricingAuditSettingsMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.enabled,
    SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.lastRunDate,
    AI_RETENTION_SETTINGS_KEYS.pricingAuditRetentionDays,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

export async function getSimpleContentPricingAuditCleanupSettings(): Promise<SimpleContentPricingAuditCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const map = await readSimpleContentPricingAuditSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: await resolvePricingAuditRetentionDays(client),
      lastRunDate: normalizeRunDate(map.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function updateSimpleContentPricingAuditCleanupSettings(input: {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
}): Promise<SimpleContentPricingAuditCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const thresholdDays = Math.max(1, Math.floor(input.deletionThresholdDays));
    await upsertSettings(client, [
      {
        key: SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.enabled,
        value: input.autoDeleteEnabled ? "1" : "0",
      },
      {
        key: AI_RETENTION_SETTINGS_KEYS.pricingAuditRetentionDays,
        value: String(thresholdDays),
      },
    ]);
    const map = await readSimpleContentPricingAuditSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: thresholdDays,
      lastRunDate: normalizeRunDate(map.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function countExpiredSimpleContentPricingAuditLogs(
  thresholdDays: number,
  clientArg?: PoolClient,
): Promise<number> {
  const threshold = Math.max(1, Math.floor(thresholdDays));
  const run = async (client: PoolClient): Promise<number> => {
    const r = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM public.simple_content_pricing_audit_logs
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    return Number(r.rows[0]?.c ?? 0);
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

export async function performSimpleContentPricingAuditCleanup(input: {
  source: CleanupSource;
  forceRun?: boolean;
}): Promise<SimpleContentPricingAuditCleanupResult> {
  if (runningSimpleContentPricingAuditCleanup) return runningSimpleContentPricingAuditCleanup;
  const pool = getPool();
  runningSimpleContentPricingAuditCleanup = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const settingsMap = await readSimpleContentPricingAuditSettingsMap(client);
      const enabled = parseEnabled(settingsMap.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.enabled));
      const thresholdDays = await resolvePricingAuditRetentionDays(client);
      const today = toISODate();

      if (!input.forceRun && !enabled) {
        await client.query("ROLLBACK");
        return {
          deletedCount: 0,
          thresholdDays,
          runDate: normalizeRunDate(settingsMap.get(SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.lastRunDate)),
        };
      }

      const expiredCount = await countExpiredSimpleContentPricingAuditLogs(thresholdDays, client);
      await client.query(
        `DELETE FROM public.simple_content_pricing_audit_logs
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );

      await upsertSettings(client, [
        { key: SIMPLE_CONTENT_PRICING_AUDIT_SETTINGS_KEYS.lastRunDate, value: today },
      ]);
      await client.query("COMMIT");
      return { deletedCount: expiredCount, thresholdDays, runDate: today };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore rollback error */
      }
      throw error;
    } finally {
      client.release();
      runningSimpleContentPricingAuditCleanup = null;
    }
  })();
  return runningSimpleContentPricingAuditCleanup;
}

export async function maybeRunStartupSimpleContentPricingAuditCleanup(): Promise<SimpleContentPricingAuditCleanupResult | null> {
  const settings = await getSimpleContentPricingAuditCleanupSettings();
  const today = toISODate();
  if (!settings.autoDeleteEnabled || settings.lastRunDate === today) {
    return null;
  }
  return performSimpleContentPricingAuditCleanup({ source: "startup" });
}

const AI_USAGE_LOGS_SETTINGS_KEYS = {
  enabled: "ai_usage_logs_cleanup_enabled",
  thresholdDays: "ai_usage_logs_cleanup_threshold_days",
  lastRunDate: "ai_usage_logs_cleanup_last_run_date",
} as const;

type AiUsageLogsCleanupSettings = {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
  lastRunDate: string;
};

type AiUsageLogsCleanupResult = {
  deletedCount: number;
  thresholdDays: number;
  runDate: string;
};

let runningAiUsageLogsCleanup: Promise<AiUsageLogsCleanupResult> | null = null;

async function readAiUsageLogsSettingsMap(client: PoolClient): Promise<Map<string, string>> {
  const keys = [
    AI_USAGE_LOGS_SETTINGS_KEYS.enabled,
    AI_USAGE_LOGS_SETTINGS_KEYS.thresholdDays,
    AI_USAGE_LOGS_SETTINGS_KEYS.lastRunDate,
  ];
  const rows = await client.query<{ key: string; value: string }>(
    `SELECT key, value FROM public.app_settings WHERE key = ANY($1::text[])`,
    [keys],
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

export async function getAiUsageLogsCleanupSettings(): Promise<AiUsageLogsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const map = await readAiUsageLogsSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(AI_USAGE_LOGS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: parseThreshold(map.get(AI_USAGE_LOGS_SETTINGS_KEYS.thresholdDays)),
      lastRunDate: normalizeRunDate(map.get(AI_USAGE_LOGS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function updateAiUsageLogsCleanupSettings(input: {
  autoDeleteEnabled: boolean;
  deletionThresholdDays: number;
}): Promise<AiUsageLogsCleanupSettings> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const thresholdDays = Math.max(1, Math.floor(input.deletionThresholdDays));
    await upsertSettings(client, [
      {
        key: AI_USAGE_LOGS_SETTINGS_KEYS.enabled,
        value: input.autoDeleteEnabled ? "1" : "0",
      },
      {
        key: AI_USAGE_LOGS_SETTINGS_KEYS.thresholdDays,
        value: String(thresholdDays),
      },
    ]);
    const map = await readAiUsageLogsSettingsMap(client);
    return {
      autoDeleteEnabled: parseEnabled(map.get(AI_USAGE_LOGS_SETTINGS_KEYS.enabled)),
      deletionThresholdDays: thresholdDays,
      lastRunDate: normalizeRunDate(map.get(AI_USAGE_LOGS_SETTINGS_KEYS.lastRunDate)),
    };
  } finally {
    client.release();
  }
}

export async function countExpiredAiUsageLogs(thresholdDays: number, clientArg?: PoolClient): Promise<number> {
  const threshold = Math.max(1, Math.floor(thresholdDays));
  const run = async (client: PoolClient): Promise<number> => {
    const r = await client.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM public.ai_usage_logs
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [threshold],
    );
    return Number(r.rows[0]?.c ?? 0);
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

export async function performAiUsageLogsCleanup(input: {
  source: CleanupSource;
  forceRun?: boolean;
}): Promise<AiUsageLogsCleanupResult> {
  if (runningAiUsageLogsCleanup) return runningAiUsageLogsCleanup;

  const pool = getPool();
  runningAiUsageLogsCleanup = (async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const settingsMap = await readAiUsageLogsSettingsMap(client);
      const enabled = parseEnabled(settingsMap.get(AI_USAGE_LOGS_SETTINGS_KEYS.enabled));
      const thresholdDays = parseThreshold(settingsMap.get(AI_USAGE_LOGS_SETTINGS_KEYS.thresholdDays));
      const today = toISODate();

      if (!input.forceRun && !enabled) {
        await client.query("ROLLBACK");
        console.log(`[ai_usage_logs_cleanup] skipped source=${input.source} reason=disabled`);
        return {
          deletedCount: 0,
          thresholdDays,
          runDate: normalizeRunDate(settingsMap.get(AI_USAGE_LOGS_SETTINGS_KEYS.lastRunDate)),
        };
      }

      const expiredCount = await countExpiredAiUsageLogs(thresholdDays, client);
      await client.query(
        `DELETE FROM public.ai_usage_logs
         WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
        [thresholdDays],
      );

      await upsertSettings(client, [{ key: AI_USAGE_LOGS_SETTINGS_KEYS.lastRunDate, value: today }]);
      await client.query("COMMIT");
      console.log(
        `[ai_usage_logs_cleanup] success source=${input.source} date=${today} thresholdDays=${thresholdDays} deleted=${expiredCount}`,
      );
      return {
        deletedCount: expiredCount,
        thresholdDays,
        runDate: today,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
      console.error(`[ai_usage_logs_cleanup] failed source=${input.source}`, error);
      throw error;
    } finally {
      client.release();
      runningAiUsageLogsCleanup = null;
    }
  })();

  return runningAiUsageLogsCleanup;
}

export async function maybeRunStartupAiUsageLogsCleanup(): Promise<AiUsageLogsCleanupResult | null> {
  const settings = await getAiUsageLogsCleanupSettings();
  const today = toISODate();
  if (!settings.autoDeleteEnabled) {
    console.log("[ai_usage_logs_cleanup] startup skipped reason=disabled");
    return null;
  }
  if (settings.lastRunDate === today) {
    console.log("[ai_usage_logs_cleanup] startup skipped reason=already-ran-today");
    return null;
  }
  return performAiUsageLogsCleanup({ source: "startup" });
}

type CleanupStatsSqlRow = {
  row_count: string;
  total_bytes: string | null;
  total_size: string | null;
  oldest_created_at: string | null;
  newest_created_at: string | null;
};

async function readCleanupStatsForTable(client: PoolClient, tableName: string): Promise<CleanupTableStatsRow> {
  const r = await client.query<CleanupStatsSqlRow>(
    `SELECT
       COUNT(*)::text AS row_count,
       pg_total_relation_size($1::regclass)::text AS total_bytes,
       pg_size_pretty(pg_total_relation_size($1::regclass)) AS total_size,
       MIN(created_at)::text AS oldest_created_at,
       MAX(created_at)::text AS newest_created_at
     FROM ${tableName}`,
    [tableName],
  );
  const row = r.rows[0];
  return {
    tableName,
    rowCount: Number(row?.row_count ?? 0),
    totalBytes: Number(row?.total_bytes ?? 0),
    totalSize: String(row?.total_size ?? "0 bytes"),
    oldestCreatedAt: row?.oldest_created_at ?? null,
    newestCreatedAt: row?.newest_created_at ?? null,
  };
}

export async function getAiCleanupTableStats(): Promise<CleanupTableStatsRow[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const tables = ["ai_usage_logs", "simple_content_runs", "simple_content_pricing_audit_logs"];
    const out: CleanupTableStatsRow[] = [];
    for (const tableName of tables) {
      out.push(await readCleanupStatsForTable(client, tableName));
    }
    return out;
  } finally {
    client.release();
  }
}
