import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Match } from "./Match";

const joinLobbySchema = z.object({
  name: z.string().trim().min(1).max(32),
});

const answerSchema = z.object({
  questionId: z.number().int().positive(),
  choiceIndex: z.number().int().min(0).max(3),
});

const LOBBY_ROOM = "lobby";
const MATCH_START_SECONDS = 3;

type LobbyEntry = {
  socketId: string;
  name: string;
  ready: boolean;
};

export class GameManager {
  private readonly lobby = new Map<string, LobbyEntry>();
  private matchStartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly socketToMatch = new Map<string, Match>();
  private readonly runningMatches = new Map<string, Match>();

  constructor(private readonly io: Server) {}

  attachSocket(socket: Socket): void {
    socket.on("join_lobby", (raw, cb) => {
      try {
        const parsed = joinLobbySchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: "invalid_name" });
          return;
        }
        const { name } = parsed.data;
        this.leaveMatchForSocket(socket.id);
        this.lobby.set(socket.id, { socketId: socket.id, name, ready: false });
        void socket.join(LOBBY_ROOM);
        this.broadcastLobby();
        cb?.({ ok: true });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("player_ready", (_payload, cb) => {
      const entry = this.lobby.get(socket.id);
      if (!entry) {
        cb?.({ ok: false, error: "not_in_lobby" });
        return;
      }
      entry.ready = true;
      this.broadcastLobby();
      this.scheduleMatchStart();
      cb?.({ ok: true });
    });

    socket.on("answer", (raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      const parsed = answerSchema.safeParse(raw);
      if (!match || !parsed.success) {
        cb?.({ ok: false });
        return;
      }
      match.recordAnswer(
        socket.id,
        parsed.data.questionId,
        parsed.data.choiceIndex,
      );
      cb?.({ ok: true });
    });

    socket.on("disconnect", () => {
      this.removeFromLobby(socket.id);
      const match = this.socketToMatch.get(socket.id);
      if (match) {
        match.handleDisconnect(socket.id);
        this.socketToMatch.delete(socket.id);
      }
    });
  }

  private leaveMatchForSocket(socketId: string): void {
    const m = this.socketToMatch.get(socketId);
    if (!m) return;
    m.handleDisconnect(socketId);
    this.socketToMatch.delete(socketId);
    void this.io.sockets.sockets.get(socketId)?.leave(m.room);
  }

  private removeFromLobby(socketId: string): void {
    if (this.lobby.delete(socketId)) {
      void this.io.sockets.sockets.get(socketId)?.leave(LOBBY_ROOM);
      this.broadcastLobby();
      if (this.readyPlayers().length < 2 && this.matchStartTimer) {
        clearTimeout(this.matchStartTimer);
        this.matchStartTimer = null;
      }
    }
  }

  private readyPlayers(): LobbyEntry[] {
    return [...this.lobby.values()].filter((p) => p.ready);
  }

  private broadcastLobby(): void {
    this.io.to(LOBBY_ROOM).emit("lobby_state", {
      players: [...this.lobby.values()].map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
      })),
    });
  }

  private scheduleMatchStart(): void {
    const ready = this.readyPlayers();
    if (ready.length < 2) {
      if (this.matchStartTimer) {
        clearTimeout(this.matchStartTimer);
        this.matchStartTimer = null;
      }
      return;
    }

    if (this.matchStartTimer) return;

    this.io.to(LOBBY_ROOM).emit("match_starting", {
      seconds: MATCH_START_SECONDS,
    });

    this.matchStartTimer = setTimeout(() => {
      this.matchStartTimer = null;
      void this.startMatchFromLobby();
    }, MATCH_START_SECONDS * 1000);
  }

  private async startMatchFromLobby(): Promise<void> {
    const ready = this.readyPlayers().filter((p) => {
      const s = this.io.sockets.sockets.get(p.socketId);
      return s?.connected;
    });
    if (ready.length < 2) return;

    const participants = ready.slice();
    const matchId = randomUUID();
    const match = new Match(this.io, matchId, participants);

    for (const p of participants) {
      this.lobby.delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(LOBBY_ROOM);
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
      }
    }

    this.runningMatches.set(matchId, match);
    this.broadcastLobby();

    try {
      await match.run();
    } finally {
      for (const p of participants) {
        this.socketToMatch.delete(p.socketId);
        const s = this.io.sockets.sockets.get(p.socketId);
        if (s) {
          try {
            await Promise.resolve(s.leave(match.room));
          } catch {
            /* ignore */
          }
        }
      }
      this.runningMatches.delete(matchId);
    }
  }
}
