import type { Server as HttpServer } from "http";
import type { Server as IoServer } from "socket.io";
import { closePool } from "./db/pool";
import type { GameManager } from "./game/GameManager";
import { stopSimpleContentScheduler } from "./services/simpleContent/scheduler";
import { setReleaseVersionListener } from "./releaseVersionBus";
import { shutdownIoBudgetMs, withTimeout } from "./shutdownUtils";
import { fahemStructuredLog } from "./runtime/fahemStructuredLog";

type ScheduledTaskLike = { stop: () => void };

/**
 * تسلسل إيقاف منضبط لـ Render (مهلة إجمالية ~8s افتراضياً).
 * لا يستخدم Redis — يقتصر على عملية واحدة.
 * وثيقة المراحل وترتيب العمليات: `docs/RUNTIME_LIFECYCLE_SHUTDOWN.md`.
 */
export async function gracefulShutdown(opts: {
  game: GameManager;
  io: IoServer;
  httpServer: HttpServer;
  cleanupCronTask: ScheduledTaskLike | null;
}): Promise<void> {
  const { game, io, httpServer } = opts;
  const budgetMs = shutdownIoBudgetMs();
  const engineCloseMs = Math.max(2_000, Math.floor(budgetMs * 0.35));
  const httpCloseMs = Math.max(2_000, Math.floor(budgetMs * 0.45));
  const t0 = Date.now();

  const phaseLog = (phase: string, extra?: Record<string, unknown>) => {
    fahemStructuredLog("info", {
      cat: "shutdown",
      event: "shutdown_phase",
      phase,
      elapsedMs: Date.now() - t0,
      budgetMs,
      engineCloseMs,
      httpCloseMs,
      ...extra,
    });
  };

  phaseLog("begin");

  setReleaseVersionListener(null);

  try {
    game.beginDrain();
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "beginDrain",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  phaseLog("after_beginDrain");

  try {
    game.abortAllMatchesForShutdown();
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "abort_matches",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  phaseLog("after_abort_matches");

  try {
    stopSimpleContentScheduler();
  } catch {
    /* ignore */
  }

  if (opts.cleanupCronTask) {
    try {
      opts.cleanupCronTask.stop();
    } catch {
      /* ignore */
    }
  }

  try {
    game.stopPeriodicTasks();
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "stop_periodic",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  phaseLog("after_stop_periodic");

  try {
    io.disconnectSockets(true);
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "disconnectSockets",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  phaseLog("after_disconnectSockets");

  await new Promise<void>((r) => setImmediate(r));

  const engine = io.engine as unknown as { close?: (cb?: (err?: Error) => void) => void };
  if (typeof engine.close === "function") {
    const enginePhaseStart = Date.now();
    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          engine.close!((err?: Error) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        engineCloseMs,
        "engine_close",
      );
      fahemStructuredLog("info", {
        cat: "shutdown",
        event: "shutdown_phase",
        phase: "engine_close",
        elapsedMs: Date.now() - t0,
        phaseMs: Date.now() - enginePhaseStart,
      });
    } catch (e) {
      fahemStructuredLog("error", {
        cat: "shutdown",
        event: "shutdown_phase_failed",
        phase: "engine_close",
        elapsedMs: Date.now() - t0,
        phaseMs: Date.now() - enginePhaseStart,
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const poolPhaseStart = Date.now();
  try {
    await closePool();
    fahemStructuredLog("info", {
      cat: "shutdown",
      event: "shutdown_phase",
      phase: "pool_close",
      elapsedMs: Date.now() - t0,
      phaseMs: Date.now() - poolPhaseStart,
    });
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "pool_close",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  const httpPhaseStart = Date.now();
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        httpServer.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      }),
      httpCloseMs,
      "http_close",
    );
    fahemStructuredLog("info", {
      cat: "shutdown",
      event: "shutdown_phase",
      phase: "http_close",
      elapsedMs: Date.now() - t0,
      phaseMs: Date.now() - httpPhaseStart,
    });
  } catch (e) {
    fahemStructuredLog("error", {
      cat: "shutdown",
      event: "shutdown_phase_failed",
      phase: "http_close",
      elapsedMs: Date.now() - t0,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  fahemStructuredLog("info", {
    cat: "shutdown",
    event: "shutdown_complete_exit",
    elapsedMs: Date.now() - t0,
    totalMs: Date.now() - t0,
  });
  process.exit(0);
}
