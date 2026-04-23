import http from "http";
import { Server } from "socket.io";
import { createApp } from "./app";
import { config } from "./config";
import { GameManager } from "./game/GameManager";

if (!config.databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

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

httpServer.listen(config.port, () => {
  console.log(`Fahem server listening on port ${config.port}`);
});
