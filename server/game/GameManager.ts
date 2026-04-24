import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { Match, type GameMode } from "./Match";

const joinLobbySchema = z.object({
  name: z.string().trim().min(1).max(32),
  mode: z.enum(["direct", "study_then_quiz"]).default("direct"),
});

const answerSchema = z.object({
  questionId: z.number().int().positive(),
  choiceIndex: z.number().int().min(0).max(3),
});

const MATCH_START_SECONDS = 3;

type LobbyEntry = {
  socketId: string;
  name: string;
  ready: boolean;
  mode: GameMode;
};

export class GameManager {
  private readonly lobbies: Record<GameMode, Map<string, LobbyEntry>> = {
    direct: new Map(),
    study_then_quiz: new Map(),
  };
  private readonly matchStartTimers: Record<
    GameMode,
    ReturnType<typeof setTimeout> | null
  > = {
    direct: null,
    study_then_quiz: null,
  };
  private readonly socketToMatch = new Map<string, Match>();
  private readonly runningMatches = new Map<string, Match>();

  constructor(private readonly io: Server) {}

  private lobbyRoom(mode: GameMode): string {
    return mode === "direct" ? "lobby:direct" : "lobby:study_then_quiz";
  }

  attachSocket(socket: Socket): void {
    socket.on("join_lobby", (raw, cb) => {
      try {
        const parsed = joinLobbySchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: "invalid_name" });
          return;
        }
        const { name, mode } = parsed.data;
        this.leaveMatchForSocket(socket.id);
        this.leaveLobbyEverywhere(socket.id);
        this.lobbies[mode].set(socket.id, {
          socketId: socket.id,
          name,
          ready: false,
          mode,
        });
        void socket.join(this.lobbyRoom(mode));
        this.broadcastLobby(mode);
        cb?.({ ok: true });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("player_ready", (_payload, cb) => {
      const entry = this.findLobbyEntry(socket.id);
      if (!entry) {
        cb?.({ ok: false, error: "not_in_lobby" });
        return;
      }
      entry.ready = true;
      this.broadcastLobby(entry.mode);
      this.scheduleMatchStart(entry.mode);
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

  private findLobbyEntry(socketId: string): LobbyEntry | undefined {
    for (const mode of ["direct", "study_then_quiz"] as const) {
      const e = this.lobbies[mode].get(socketId);
      if (e) return e;
    }
    return undefined;
  }

  private leaveLobbyEverywhere(socketId: string): void {
    for (const mode of ["direct", "study_then_quiz"] as const) {
      if (this.lobbies[mode].delete(socketId)) {
        void this.io.sockets.sockets.get(socketId)?.leave(this.lobbyRoom(mode));
        this.clearMatchStartTimerIfNeeded(mode);
        this.broadcastLobby(mode);
      }
    }
  }

  private removeFromLobby(socketId: string): void {
    const entry = this.findLobbyEntry(socketId);
    if (!entry) return;
    this.lobbies[entry.mode].delete(socketId);
    void this.io.sockets.sockets.get(socketId)?.leave(this.lobbyRoom(entry.mode));
    this.clearMatchStartTimerIfNeeded(entry.mode);
    this.broadcastLobby(entry.mode);
  }

  private leaveMatchForSocket(socketId: string): void {
    const m = this.socketToMatch.get(socketId);
    if (!m) return;
    m.handleDisconnect(socketId);
    this.socketToMatch.delete(socketId);
    void this.io.sockets.sockets.get(socketId)?.leave(m.room);
  }

  private readyPlayers(mode: GameMode): LobbyEntry[] {
    return [...this.lobbies[mode].values()].filter((p) => p.ready);
  }

  private broadcastLobby(mode: GameMode): void {
    this.io.to(this.lobbyRoom(mode)).emit("lobby_state", {
      mode,
      players: [...this.lobbies[mode].values()].map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
        mode: p.mode,
      })),
    });
  }

  private clearMatchStartTimerIfNeeded(mode: GameMode): void {
    if (this.readyPlayers(mode).length < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
      }
    }
  }

  private scheduleMatchStart(mode: GameMode): void {
    const ready = this.readyPlayers(mode);
    if (ready.length < 2) {
      this.clearMatchStartTimerIfNeeded(mode);
      return;
    }
    if (this.matchStartTimers[mode]) return;

    this.io.to(this.lobbyRoom(mode)).emit("match_starting", {
      seconds: MATCH_START_SECONDS,
    });

    this.matchStartTimers[mode] = setTimeout(() => {
      this.matchStartTimers[mode] = null;
      void this.startMatchFromLobby(mode);
    }, MATCH_START_SECONDS * 1000);
  }

  private async startMatchFromLobby(gameMode: GameMode): Promise<void> {
    const ready = this.readyPlayers(gameMode).filter((p) => {
      const s = this.io.sockets.sockets.get(p.socketId);
      return s?.connected;
    });
    if (ready.length < 2) return;

    const participants = ready.slice();
    const matchId = randomUUID();
    const match = new Match(this.io, matchId, participants, gameMode);

    for (const p of participants) {
      this.lobbies[gameMode].delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.lobbyRoom(gameMode));
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
      }
    }

    this.runningMatches.set(matchId, match);
    this.broadcastLobby(gameMode);

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
