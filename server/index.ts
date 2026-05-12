import http from "http";
import type { ScheduledTask } from "node-cron";
import cron from "node-cron";
import { Server } from "socket.io";
import type {
  ClientToServerEvents,
  FahemSocketData,
  InterServerEvents,
  ServerToClientEvents,
} from "../shared/socketEvents";
import { createApp } from "./app";
import { config } from "./config";
import { GameManager } from "./game/GameManager";
import {
  maybeRunStartupAiUsageLogsCleanup,
  maybeRunStartupCleanup,
  maybeRunStartupSimpleContentPricingAuditCleanup,
  maybeRunStartupSimpleContentRunsCleanup,
  maybeRunStartupUserSavedLessonsCleanup,
  performAiUsageLogsCleanup,
  performCleanup,
  performSimpleContentPricingAuditCleanup,
  performSimpleContentRunsCleanup,
  performUserSavedLessonsExpiredCleanup,
} from "./services/cleanup";
import { startSimpleContentScheduler } from "./services/simpleContent/scheduler";
import { setReleaseVersionListener } from "./releaseVersionBus";
import { authenticateSocket } from "./auth/socketAuth";
import { gracefulShutdown } from "./shutdownSequence";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let cleanupCronTask: ScheduledTask | null = null;

function scheduleCleanupCron(): void {
  cleanupCronTask = cron.schedule("0 3 * * *", async () => {
    try {
      await performCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
    try {
      await performSimpleContentRunsCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
    try {
      await performSimpleContentPricingAuditCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
    try {
      await performAiUsageLogsCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
    try {
      await performUserSavedLessonsExpiredCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
  });
}

async function startServer(): Promise<void> {
  const app = createApp();
  const httpServer = http.createServer(app);

  const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, FahemSocketData>(
    httpServer,
    {
      cors: {
        origin: config.clientOrigin ?? true,
        credentials: true,
      },
    },
  );
  io.use((socket, next) => {
    void authenticateSocket(socket, next);
  });

  const game = new GameManager(io);
  io.on("connection", (socket) => {
    game.attachSocket(socket);
  });
  setReleaseVersionListener((releaseVersion) => {
    io.emit("release_updated", { releaseVersion, serverNow: Date.now() });
  });

  app.get("/health/realtime", (_req, res) => {
    res.status(200).json({
      ok: true,
      service: "fahem",
      serverNow: Date.now(),
      ...game.getOperationalSnapshot(),
    });
  });

  try {
    await maybeRunStartupCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupSimpleContentRunsCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupSimpleContentPricingAuditCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupAiUsageLogsCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupUserSavedLessonsCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  startSimpleContentScheduler();

  scheduleCleanupCron();
  httpServer.listen(config.port, () => {
    console.log(`Fahem server listening on port ${config.port}`);
  });

  let shuttingDown = false;
  /** يمنع استدعاء `gracefulShutdown` متزامناً — انظر `docs/RUNTIME_LIFECYCLE_SHUTDOWN.md`. */
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown({ game, io, httpServer, cleanupCronTask }).catch((err) => {
      console.error("[fahem_shutdown] fatal", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
