import http from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import { createApp } from "./app";
import { config } from "./config";
import { GameManager } from "./game/GameManager";
import {
  maybeRunStartupCleanup,
  maybeRunStartupSimpleContentPricingAuditCleanup,
  maybeRunStartupSimpleContentRunsCleanup,
  performCleanup,
  performSimpleContentPricingAuditCleanup,
  performSimpleContentRunsCleanup,
} from "./services/cleanup";
import { startSimpleContentScheduler, stopSimpleContentScheduler } from "./services/simpleContent/scheduler";
import { setReleaseVersionListener } from "./releaseVersionBus";
import { authenticateSocket } from "./auth/socketAuth";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

function scheduleCleanupCron(): void {
  cron.schedule("0 3 * * *", async () => {
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
  });
}

async function startServer(): Promise<void> {
  const app = createApp();
  const httpServer = http.createServer(app);

  const io = new Server(httpServer, {
    cors: {
      origin: config.clientOrigin ?? true,
      credentials: true,
    },
  });
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
  startSimpleContentScheduler();

  scheduleCleanupCron();
  httpServer.listen(config.port, () => {
    console.log(`Fahem server listening on port ${config.port}`);
  });

  const shutdown = async () => {
    setReleaseVersionListener(null);
    try {
      stopSimpleContentScheduler();
    } catch {
      // ignore
    }
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
