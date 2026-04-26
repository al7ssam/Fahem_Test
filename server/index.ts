import http from "http";
import { Server } from "socket.io";
import cron from "node-cron";
import { createApp } from "./app";
import { config } from "./config";
import { GameManager } from "./game/GameManager";
import { maybeRunStartupCleanup, performCleanup } from "./services/cleanup";

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

  scheduleCleanupCron();
  httpServer.listen(config.port, () => {
    console.log(`Fahem server listening on port ${config.port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server", error);
  process.exit(1);
});
