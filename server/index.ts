import http from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import { createApp } from "./app";
import { config } from "./config";
import { GameManager } from "./game/GameManager";
import {
  maybeRunStartupAiFactoryLogsCleanup,
  maybeRunStartupCleanup,
  maybeRunStartupSimpleContentRunsCleanup,
  performAiFactoryLogsCleanup,
  performCleanup,
  performSimpleContentRunsCleanup,
} from "./services/cleanup";
import { aiFactoryRuntime } from "./services/aiFactory/runtime";
import { startSimpleContentScheduler, stopSimpleContentScheduler } from "./services/simpleContent/scheduler";

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
      await performAiFactoryLogsCleanup({ source: "cron" });
    } catch {
      // detailed log is emitted inside cleanup service
    }
    try {
      await performSimpleContentRunsCleanup({ source: "cron" });
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

  const game = new GameManager(io);
  io.on("connection", (socket) => {
    game.attachSocket(socket);
  });

  try {
    await maybeRunStartupCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupAiFactoryLogsCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  try {
    await maybeRunStartupSimpleContentRunsCleanup();
  } catch {
    // detailed log is emitted inside cleanup service
  }
  await aiFactoryRuntime.start();
  startSimpleContentScheduler();

  scheduleCleanupCron();
  httpServer.listen(config.port, () => {
    console.log(`Fahem server listening on port ${config.port}`);
  });

  const shutdown = async () => {
    try {
      stopSimpleContentScheduler();
    } catch {
      // ignore
    }
    try {
      await aiFactoryRuntime.stop();
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
