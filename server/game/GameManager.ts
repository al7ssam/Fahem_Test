import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getPool } from "../db/pool";
import { Match, type GameMode } from "./Match";

const joinLobbySchema = z.object({
  name: z.string().trim().min(1).max(32),
  mode: z.enum(["direct", "study_then_quiz"]).default("direct"),
});

const answerSchema = z.object({
  questionId: z.number().int().positive(),
  choiceIndex: z.number().int().min(0).max(3),
});

const abilityHeartSchema = z.object({
  targetSocketId: z.string().min(1),
});

const DEFAULT_MATCH_FILL_WINDOW_SECONDS = 5;
const DEFAULT_MAX_PLAYERS_PER_MATCH = 10;
const MATCH_SETTINGS_CACHE_MS = 15_000;

type LobbyEntry = {
  socketId: string;
  name: string;
  ready: boolean;
  readyOrder: number | null;
  mode: GameMode;
};

type LobbyStatePayload = {
  mode: GameMode;
  players: Array<{
    socketId: string;
    name: string;
    ready: boolean;
    mode: GameMode;
  }>;
  isStarting: boolean;
  participantSocketIds: string[];
  maxPlayersPerMatch: number;
  countdownSecondsRemaining?: number;
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
  private readonly countdownEndsAt: Record<GameMode, number | null> = {
    direct: null,
    study_then_quiz: null,
  };
  private readonly scheduleChain: Record<GameMode, Promise<void>> = {
    direct: Promise.resolve(),
    study_then_quiz: Promise.resolve(),
  };
  private readonly socketToMatch = new Map<string, Match>();
  private readonly runningMatches = new Map<string, Match>();
  private readonly lockedParticipants: Record<GameMode, string[]> = {
    direct: [],
    study_then_quiz: [],
  };
  private readyOrderCounter = 0;
  private maxPlayersPerMatch = DEFAULT_MAX_PLAYERS_PER_MATCH;
  private matchFillWindowSeconds = DEFAULT_MATCH_FILL_WINDOW_SECONDS;
  private maxPlayersLoadedAtMs = 0;
  private fillWindowLoadedAtMs = 0;

  constructor(private readonly io: Server) {}

  private lobbyRoom(mode: GameMode): string {
    return mode === "direct" ? "lobby:direct" : "lobby:study_then_quiz";
  }

  private buildLobbyPayload(mode: GameMode): LobbyStatePayload {
    const isStarting = Boolean(this.matchStartTimers[mode]);
    const endsAt = this.countdownEndsAt[mode];
    const countdownSecondsRemaining =
      isStarting && endsAt != null
        ? Math.max(1, Math.ceil((endsAt - Date.now()) / 1000))
        : undefined;
    return {
      mode,
      players: [...this.lobbies[mode].values()].map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
        mode: p.mode,
      })),
      isStarting,
      participantSocketIds: [...this.lockedParticipants[mode]],
      maxPlayersPerMatch: this.maxPlayersPerMatch,
      countdownSecondsRemaining,
    };
  }

  attachSocket(socket: Socket): void {
    socket.on("join_lobby", async (raw, cb) => {
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
          ready: true,
          readyOrder: ++this.readyOrderCounter,
          mode,
        });
        await socket.join(this.lobbyRoom(mode));
        this.broadcastLobby(mode);
        socket.emit("lobby_state", this.buildLobbyPayload(mode));
        this.enqueueScheduleMatchStart(mode);
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
      if (!entry.ready) {
        entry.ready = true;
        entry.readyOrder = ++this.readyOrderCounter;
      }
      this.broadcastLobby(entry.mode);
      this.enqueueScheduleMatchStart(entry.mode);
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

    socket.on("round_ready", (_raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      if (!match) {
        cb?.({ ok: false });
        return;
      }
      match.markRoundReady(socket.id);
      cb?.({ ok: true });
    });

    socket.on("continue_as_spectator", (_raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      cb?.({ ok: Boolean(match) });
    });

    socket.on("ability_skill_boost", (_raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      if (!match) {
        cb?.({ ok: false, error: "not_in_match" });
        return;
      }
      const r = match.tryAbilitySkillBoost(socket.id);
      cb?.(r);
    });

    socket.on("ability_skip_question", (_raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      if (!match) {
        cb?.({ ok: false, error: "not_in_match" });
        return;
      }
      const r = match.tryAbilitySkipQuestion(socket.id);
      cb?.(r);
    });

    socket.on("ability_heart_attack", (raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      if (!match) {
        cb?.({ ok: false, error: "not_in_match" });
        return;
      }
      const parsed = abilityHeartSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: "invalid_body" });
        return;
      }
      const r = match.tryAbilityHeartAttack(socket.id, parsed.data.targetSocketId);
      cb?.(r);
    });

    socket.on("ability_reveal_keys", (_raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      if (!match) {
        cb?.({ ok: false, error: "not_in_match" });
        return;
      }
      const r = match.tryAbilityRevealKeys(socket.id);
      cb?.(r);
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
        this.lockedParticipants[mode] = this.lockedParticipants[mode].filter((id) => id !== socketId);
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
    this.lockedParticipants[entry.mode] = this.lockedParticipants[entry.mode].filter(
      (id) => id !== socketId,
    );
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

  private sortedReadyPlayers(mode: GameMode): LobbyEntry[] {
    return this.readyPlayers(mode).sort((a, b) => {
      const aOrder = a.readyOrder ?? Number.MAX_SAFE_INTEGER;
      const bOrder = b.readyOrder ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
  }

  private async loadMaxPlayersPerMatch(): Promise<number> {
    const now = Date.now();
    if (now - this.maxPlayersLoadedAtMs <= MATCH_SETTINGS_CACHE_MS) {
      return this.maxPlayersPerMatch;
    }
    try {
      const pool = getPool();
      const rows = await pool.query<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'max_players_per_match' LIMIT 1`,
      );
      const raw = Number(rows.rows[0]?.value ?? DEFAULT_MAX_PLAYERS_PER_MATCH);
      const next = Math.min(100, Math.max(2, Number.isFinite(raw) ? raw : DEFAULT_MAX_PLAYERS_PER_MATCH));
      this.maxPlayersPerMatch = next;
      this.maxPlayersLoadedAtMs = now;
      return next;
    } catch {
      this.maxPlayersPerMatch = DEFAULT_MAX_PLAYERS_PER_MATCH;
      this.maxPlayersLoadedAtMs = now;
      return this.maxPlayersPerMatch;
    }
  }

  private async loadMatchFillWindowSeconds(): Promise<number> {
    const now = Date.now();
    if (now - this.fillWindowLoadedAtMs <= MATCH_SETTINGS_CACHE_MS) {
      return this.matchFillWindowSeconds;
    }
    try {
      const pool = getPool();
      const rows = await pool.query<{ value: string }>(
        `SELECT value FROM app_settings WHERE key = 'match_fill_window_seconds' LIMIT 1`,
      );
      const raw = Number(rows.rows[0]?.value ?? DEFAULT_MATCH_FILL_WINDOW_SECONDS);
      const next = Math.min(
        120,
        Math.max(1, Number.isFinite(raw) ? raw : DEFAULT_MATCH_FILL_WINDOW_SECONDS),
      );
      this.matchFillWindowSeconds = next;
      this.fillWindowLoadedAtMs = now;
      return next;
    } catch {
      this.matchFillWindowSeconds = DEFAULT_MATCH_FILL_WINDOW_SECONDS;
      this.fillWindowLoadedAtMs = now;
      return this.matchFillWindowSeconds;
    }
  }

  private broadcastLobby(mode: GameMode): void {
    this.io.to(this.lobbyRoom(mode)).emit("lobby_state", this.buildLobbyPayload(mode));
  }

  private enqueueScheduleMatchStart(mode: GameMode): void {
    this.scheduleChain[mode] = this.scheduleChain[mode]
      .catch(() => undefined)
      .then(() => this.runScheduleMatchStart(mode));
  }

  private clearMatchStartTimerIfNeeded(mode: GameMode): void {
    const effectiveReadyCount =
      this.lockedParticipants[mode].length > 0
        ? this.lockedParticipants[mode].length
        : this.readyPlayers(mode).length;
    if (effectiveReadyCount < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
        this.countdownEndsAt[mode] = null;
        this.lockedParticipants[mode] = [];
        this.io.to(this.lobbyRoom(mode)).emit("match_start_cancelled", {
          reason: "not_enough_ready",
        });
        if (this.readyPlayers(mode).length >= 2) {
          this.enqueueScheduleMatchStart(mode);
        }
      }
    }
  }

  private emitMatchStarting(mode: GameMode, locked: string[], maxPlayers: number): void {
    const fillMs = this.matchFillWindowSeconds * 1000;
    const endsAt = this.countdownEndsAt[mode] ?? Date.now() + fillMs;
    const seconds = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));
    this.io.to(this.lobbyRoom(mode)).emit("match_starting", {
      seconds,
      participantSocketIds: locked,
      maxPlayersPerMatch: maxPlayers,
      lockedCount: locked.length,
    });
  }

  private async updateRosterDuringCountdown(mode: GameMode): Promise<void> {
    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const locked = this.sortedReadyPlayers(mode)
      .slice(0, maxPlayers)
      .map((p) => p.socketId);
    if (locked.length < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
      }
      this.countdownEndsAt[mode] = null;
      this.lockedParticipants[mode] = [];
      this.io.to(this.lobbyRoom(mode)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(mode);
      if (this.readyPlayers(mode).length >= 2) {
        this.enqueueScheduleMatchStart(mode);
      }
      return;
    }
    this.lockedParticipants[mode] = locked;
    this.emitMatchStarting(mode, locked, maxPlayers);
    this.broadcastLobby(mode);
  }

  private async runScheduleMatchStart(mode: GameMode): Promise<void> {
    const ready = this.readyPlayers(mode);
    if (ready.length < 2) {
      if (!this.matchStartTimers[mode]) {
        this.clearMatchStartTimerIfNeeded(mode);
      }
      return;
    }

    if (this.matchStartTimers[mode]) {
      await this.updateRosterDuringCountdown(mode);
      return;
    }

    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const fillSeconds = await this.loadMatchFillWindowSeconds();
    const fillMs = fillSeconds * 1000;
    const locked = this.sortedReadyPlayers(mode)
      .slice(0, maxPlayers)
      .map((p) => p.socketId);
    if (locked.length < 2) return;

    if (this.matchStartTimers[mode]) {
      await this.updateRosterDuringCountdown(mode);
      return;
    }

    this.lockedParticipants[mode] = locked;
    this.countdownEndsAt[mode] = Date.now() + fillMs;
    this.emitMatchStarting(mode, locked, maxPlayers);
    this.broadcastLobby(mode);

    this.matchStartTimers[mode] = setTimeout(() => {
      this.matchStartTimers[mode] = null;
      this.countdownEndsAt[mode] = null;
      void this.startMatchFromLobby(mode);
    }, fillMs);
  }

  private async startMatchFromLobby(gameMode: GameMode): Promise<void> {
    const startedAt = Date.now();
    const locked = this.lockedParticipants[gameMode];
    const participants = locked
      .map((socketId) => this.lobbies[gameMode].get(socketId))
      .filter((p): p is LobbyEntry => Boolean(p))
      .filter((p) => {
        const s = this.io.sockets.sockets.get(p.socketId);
        return Boolean(s?.connected && p.ready);
      });
    if (participants.length < 2) {
      this.lockedParticipants[gameMode] = [];
      this.io.to(this.lobbyRoom(gameMode)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(gameMode);
      if (this.readyPlayers(gameMode).length >= 2) {
        this.enqueueScheduleMatchStart(gameMode);
      }
      return;
    }
    this.lockedParticipants[gameMode] = [];
    const matchId = randomUUID();
    const match = new Match(this.io, matchId, participants, gameMode);

    await Promise.all(participants.map(async (p) => {
      this.lobbies[gameMode].delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.lobbyRoom(gameMode));
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
      }
    }));
    const roomsReadyMs = Date.now() - startedAt;
    console.debug(`[matchmaking] lobby_to_match_rooms_ms=${roomsReadyMs} mode=${gameMode} participants=${participants.length}`);

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
