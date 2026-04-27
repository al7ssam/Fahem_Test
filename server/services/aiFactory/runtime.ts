import cron, { type ScheduledTask } from "node-cron";
import { getPool } from "../../db/pool";
import { runFactoryJob } from "./orchestrator";
import type { FactoryDifficulty } from "./types";

type FactorySettings = {
  enabled: boolean;
  batchSize: number;
  intervalMinutes: number;
  defaultTargetCount: number;
  lastSchedulerRun: string;
};

type ClaimedJob = {
  id: number;
  subcategory_key: string;
  difficulty_mode: FactoryDifficulty;
  target_count: number;
  batch_size: number;
  status: string;
  payload: unknown;
  attempt_count: number;
  max_attempts: number;
};

const SETTING_KEYS = {
  enabled: "ai_factory_enabled",
  batchSize: "ai_factory_batch_size",
  intervalMinutes: "ai_factory_interval_minutes",
  defaultTargetCount: "ai_factory_default_target_count",
  lastSchedulerRun: "ai_factory_last_scheduler_run",
} as const;

function toBool(v: string | undefined): boolean {
  const x = String(v ?? "").trim().toLowerCase();
  return x === "1" || x === "true" || x === "yes";
}

function toInt(v: string | undefined, d: number, min: number, max: number): number {
  const n = Number(v ?? d);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export async function readFactorySettings(): Promise<FactorySettings> {
  const pool = getPool();
  const rows = await pool.query<{ key: string; value: string }>(
    `SELECT key, value
     FROM app_settings
     WHERE key IN ($1, $2, $3, $4, $5)`,
    [
      SETTING_KEYS.enabled,
      SETTING_KEYS.batchSize,
      SETTING_KEYS.intervalMinutes,
      SETTING_KEYS.defaultTargetCount,
      SETTING_KEYS.lastSchedulerRun,
    ],
  );
  const map = new Map(rows.rows.map((r) => [r.key, r.value]));
  return {
    enabled: toBool(map.get(SETTING_KEYS.enabled)),
    batchSize: toInt(map.get(SETTING_KEYS.batchSize), 20, 1, 200),
    intervalMinutes: toInt(map.get(SETTING_KEYS.intervalMinutes), 30, 1, 1440),
    defaultTargetCount: toInt(map.get(SETTING_KEYS.defaultTargetCount), 200, 1, 100000),
    lastSchedulerRun: String(map.get(SETTING_KEYS.lastSchedulerRun) ?? "").trim(),
  };
}

export async function saveFactorySettings(input: {
  enabled: boolean;
  batchSize: number;
  intervalMinutes: number;
  defaultTargetCount: number;
}): Promise<FactorySettings> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES
       ($1, $2),
       ($3, $4),
       ($5, $6),
       ($7, $8)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [
      SETTING_KEYS.enabled,
      input.enabled ? "1" : "0",
      SETTING_KEYS.batchSize,
      String(toInt(String(input.batchSize), 20, 1, 200)),
      SETTING_KEYS.intervalMinutes,
      String(toInt(String(input.intervalMinutes), 30, 1, 1440)),
      SETTING_KEYS.defaultTargetCount,
      String(toInt(String(input.defaultTargetCount), 200, 1, 100000)),
    ],
  );
  return readFactorySettings();
}

async function updateLastSchedulerRun(iso: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTING_KEYS.lastSchedulerRun, iso],
  );
}

async function enqueueJob(input: {
  subcategoryKey: string;
  difficultyMode: FactoryDifficulty;
  targetCount: number;
  batchSize: number;
  payload?: unknown;
}): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO ai_factory_jobs (
       subcategory_key, difficulty_mode, target_count, batch_size, status, payload, next_run_at
     )
     SELECT $1, $2, $3, $4, 'queued', $5::jsonb, NOW()
     WHERE NOT EXISTS (
       SELECT 1
       FROM ai_factory_jobs j
       WHERE j.subcategory_key = $1
         AND j.status IN ('queued', 'running')
     )
     RETURNING id`,
    [
      input.subcategoryKey,
      input.difficultyMode,
      input.targetCount,
      input.batchSize,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return Number(r.rows[0]?.id ?? 0);
}

export type FactoryCancelResult = {
  cancelledQueued: number;
  markedRunning: number;
  jobId?: number;
};

type Queryable = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function appendCancelLogs(
  client: Queryable,
  jobIds: number[],
  message: string,
): Promise<void> {
  if (!jobIds.length) return;
  await client.query(
    `INSERT INTO ai_factory_job_logs (job_id, layer_name, level, message, details)
     SELECT id, NULL, 'warn', $2, $3::jsonb
     FROM UNNEST($1::bigint[]) AS id`,
    [jobIds, message, JSON.stringify({ cancelled: true })],
  );
}

async function cancelQueuedJobs(
  client: Queryable,
): Promise<number[]> {
  const r = await client.query<{ id: number }>(
    `WITH x AS (
       UPDATE ai_factory_jobs
       SET status = 'cancelled', current_layer = NULL, finished_at = NOW(), updated_at = NOW(),
           last_error = COALESCE(last_error, 'cancelled_by_admin')
       WHERE status = 'queued'
       RETURNING id
     )
     SELECT id FROM x`,
  );
  return r.rows.map((x) => Number(x.id)).filter((x) => Number.isInteger(x) && x > 0);
}

async function markRunningJobsCancelled(
  client: Queryable,
): Promise<number[]> {
  const r = await client.query<{ id: number }>(
    `WITH x AS (
       UPDATE ai_factory_jobs
       SET status = 'cancelled', updated_at = NOW(), last_error = 'cancel_requested_by_admin'
       WHERE status = 'running'
       RETURNING id
     )
     SELECT id FROM x`,
  );
  return r.rows.map((x) => Number(x.id)).filter((x) => Number.isInteger(x) && x > 0);
}

async function cancelSingleJob(jobId: number, client: Queryable): Promise<FactoryCancelResult> {
  const qr = await client.query<{ id: number; previous_status: string }>(
    `WITH x AS (
       UPDATE ai_factory_jobs
       SET status = 'cancelled',
           current_layer = CASE WHEN status = 'queued' THEN NULL ELSE current_layer END,
           finished_at = CASE WHEN status = 'queued' THEN NOW() ELSE finished_at END,
           updated_at = NOW(),
           last_error = CASE WHEN status = 'queued' THEN COALESCE(last_error, 'cancelled_by_admin') ELSE 'cancel_requested_by_admin' END
       WHERE id = $1
         AND status IN ('queued', 'running')
       RETURNING id, status AS previous_status
     )
     SELECT id, previous_status FROM x`,
    [jobId],
  );
  const changed = qr.rows.length;
  if (changed > 0) {
    await appendCancelLogs(client, [jobId], "Job cancelled by admin");
  }
  return {
    cancelledQueued: changed > 0 && String(qr.rows[0]?.previous_status) === "queued" ? 1 : 0,
    markedRunning: changed > 0 && String(qr.rows[0]?.previous_status) === "running" ? 1 : 0,
    jobId,
  };
}

async function claimNextJob(): Promise<ClaimedJob | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const picked = await client.query<ClaimedJob>(
      `SELECT id, subcategory_key, difficulty_mode, target_count, batch_size, status, payload, attempt_count, max_attempts
       FROM ai_factory_jobs
       WHERE status = 'queued'
         AND next_run_at <= NOW()
       ORDER BY id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const row = picked.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE ai_factory_jobs
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [row.id],
    );
    await client.query("COMMIT");
    return row;
  } catch {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    return null;
  } finally {
    client.release();
  }
}

export class AIFactoryRuntime {
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private schedulerTask: ScheduledTask | null = null;
  private workerBusy = false;
  private started = false;
  private shuttingDown = false;

  async runNow(input: {
    subcategoryKey: string;
    difficultyMode: FactoryDifficulty;
    targetCount: number;
    batchSize: number;
  }): Promise<{ jobId: number }> {
    const jobId = await enqueueJob({
      subcategoryKey: input.subcategoryKey,
      difficultyMode: input.difficultyMode,
      targetCount: input.targetCount,
      batchSize: input.batchSize,
      payload: { manual: true },
    });
    if (!jobId) {
      throw new Error("duplicate_job_guard_blocked");
    }
    return { jobId };
  }

  async cancelAllJobs(): Promise<FactoryCancelResult> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const queuedIds = await cancelQueuedJobs(client);
      const runningIds = await markRunningJobsCancelled(client);
      await appendCancelLogs(client, queuedIds, "Job cancelled by admin (queued bulk)");
      await appendCancelLogs(client, runningIds, "Job cancel requested by admin (running bulk)");
      await client.query("COMMIT");
      return { cancelledQueued: queuedIds.length, markedRunning: runningIds.length };
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw new Error("cancel_all_failed");
    } finally {
      client.release();
    }
  }

  async cancelQueuedOnly(): Promise<FactoryCancelResult> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const queuedIds = await cancelQueuedJobs(client);
      await appendCancelLogs(client, queuedIds, "Job cancelled by admin (queued bulk)");
      await client.query("COMMIT");
      return { cancelledQueued: queuedIds.length, markedRunning: 0 };
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw new Error("cancel_queued_failed");
    } finally {
      client.release();
    }
  }

  async cancelJob(jobId: number): Promise<FactoryCancelResult> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await cancelSingleJob(jobId, client);
      await client.query("COMMIT");
      return result;
    } catch {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw new Error("cancel_job_failed");
    } finally {
      client.release();
    }
  }

  async getStatus(): Promise<{
    started: boolean;
    workerBusy: boolean;
    queued: number;
    running: number;
    succeeded24h: number;
    failed24h: number;
  }> {
    const pool = getPool();
    const r = await pool.query<{
      queued: string;
      running: string;
      succeeded24h: string;
      failed24h: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM ai_factory_jobs WHERE status = 'queued') AS queued,
         (SELECT COUNT(*)::text FROM ai_factory_jobs WHERE status = 'running') AS running,
         (SELECT COUNT(*)::text FROM ai_factory_jobs WHERE status = 'succeeded' AND finished_at >= NOW() - INTERVAL '24 hour') AS succeeded24h,
         (SELECT COUNT(*)::text FROM ai_factory_jobs WHERE status = 'failed' AND finished_at >= NOW() - INTERVAL '24 hour') AS failed24h`,
    );
    return {
      started: this.started,
      workerBusy: this.workerBusy,
      queued: Number(r.rows[0]?.queued ?? 0),
      running: Number(r.rows[0]?.running ?? 0),
      succeeded24h: Number(r.rows[0]?.succeeded24h ?? 0),
      failed24h: Number(r.rows[0]?.failed24h ?? 0),
    };
  }

  private async scheduleCycle(): Promise<void> {
    const settings = await readFactorySettings();
    if (!settings.enabled) return;
    const now = Date.now();
    const last = settings.lastSchedulerRun ? Date.parse(settings.lastSchedulerRun) : 0;
    const minDeltaMs = settings.intervalMinutes * 60_000;
    if (last > 0 && now - last < minDeltaMs) return;

    const pool = getPool();
    const subs = await pool.query<{ subcategory_key: string }>(
      `SELECT subcategory_key
       FROM question_subcategories
       WHERE is_active = TRUE
       ORDER BY sort_order ASC, id ASC`,
    );
    for (const s of subs.rows) {
      const key = s.subcategory_key;
      const state = await pool.query<{ generated_count: string; target_count: string }>(
        `SELECT generated_count::text, target_count::text
         FROM ai_factory_pipeline_state
         WHERE subcategory_key = $1
         LIMIT 1`,
        [key],
      );
      const generated = Number(state.rows[0]?.generated_count ?? 0);
      const target = Number(state.rows[0]?.target_count ?? settings.defaultTargetCount);
      if (generated >= target) continue;
      await enqueueJob({
        subcategoryKey: key,
        difficultyMode: "mix",
        targetCount: target,
        batchSize: settings.batchSize,
        payload: { scheduled: true },
      });
    }
    await updateLastSchedulerRun(new Date(now).toISOString());
  }

  private async workerTick(): Promise<void> {
    if (this.workerBusy || this.shuttingDown) return;
    this.workerBusy = true;
    try {
      const job = await claimNextJob();
      if (!job) return;
      await runFactoryJob(job);
    } finally {
      this.workerBusy = false;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.workerTimer = setInterval(() => {
      void this.workerTick();
    }, 2500);
    this.schedulerTask = cron.schedule("* * * * *", () => {
      void this.scheduleCycle().catch((e) => {
        console.error("[ai-factory] scheduler error", e);
      });
    });
    await this.scheduleCycle().catch((e) => {
      console.error("[ai-factory] initial scheduler error", e);
    });
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
    }
    if (this.schedulerTask) {
      this.schedulerTask.stop();
      this.schedulerTask = null;
    }
    this.started = false;
  }
}

export const aiFactoryRuntime = new AIFactoryRuntime();
