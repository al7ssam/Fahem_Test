import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getPool } from "../db/pool";
import { countQuestionsBySubcategory } from "../db/questions";
import { Match, type DifficultyMode, type GameMode } from "./Match";

const joinLobbySchema = z.object({
  name: z.string().trim().min(1).max(32),
  mode: z.enum(["direct", "study_then_quiz"]).default("direct"),
  subcategoryKey: z.string().trim().min(1).max(120).optional(),
  difficultyMode: z.enum(["mix", "easy", "medium", "hard"]).default("mix"),
  playerSessionId: z.string().trim().min(1).max(120).optional(),
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
  playerSessionId: string;
  name: string;
  ready: boolean;
  readyOrder: number | null;
  mode: GameMode;
  subcategoryKey: string | null;
  difficultyMode: DifficultyMode;
  roomCode?: string | null;
};

type LobbyStatePayload = {
  mode: GameMode;
  players: Array<{
    socketId: string;
    name: string;
    ready: boolean;
    mode: GameMode;
    subcategoryKey: string | null;
    difficultyMode: DifficultyMode;
  }>;
  isStarting: boolean;
  participantSocketIds: string[];
  maxPlayersPerMatch: number;
  countdownSecondsRemaining?: number;
  isPrivate?: boolean;
  roomCode?: string;
  hostSocketId?: string;
  roomSettings?: {
    questionMs: number;
    studyPhaseMs: number;
  };
};

type PrivateRoomSettings = {
  questionMs: number;
  studyPhaseMs: number;
};

type PrivateRoomState = {
  roomCode: string;
  hostSocketId: string;
  mode: GameMode;
  subcategoryKey: string | null;
  difficultyMode: DifficultyMode;
  settings: PrivateRoomSettings;
  members: Map<string, LobbyEntry>;
  lockedParticipants: string[];
  countdownEndsAt: number | null;
  matchStartTimer: ReturnType<typeof setTimeout> | null;
  roomVersion: number;
};

type PrivateRoomStatePayload = {
  roomCode: string;
  hostSocketId: string;
  mode: GameMode;
  subcategoryKey: string | null;
  difficultyMode: DifficultyMode;
  roomVersion: number;
  players: Array<{ socketId: string; name: string; ready: boolean }>;
  isStarting: boolean;
  participantSocketIds: string[];
  countdownSecondsRemaining?: number;
  roomSettings: {
    questionMs: number;
    studyPhaseMs: number;
  };
};

export class GameManager {
  private readonly privateRooms = new Map<string, PrivateRoomState>();
  private readonly socketToPrivateRoomCode = new Map<string, string>();
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
  private readonly countdownGroup: Record<
    GameMode,
    { subcategoryKey: string | null; difficultyMode: DifficultyMode } | null
  > = {
    direct: null,
    study_then_quiz: null,
  };
  private readonly scheduleChain: Record<GameMode, Promise<void>> = {
    direct: Promise.resolve(),
    study_then_quiz: Promise.resolve(),
  };
  private readonly socketToMatch = new Map<string, Match>();
  private readonly socketToPlayerSessionId = new Map<string, string>();
  private readonly playerSessionToMatch = new Map<string, Match>();
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

  private resolvePlayerSessionId(raw: unknown, socketId: string): string {
    const value = String((raw as { playerSessionId?: unknown })?.playerSessionId ?? "").trim();
    if (value) return value.slice(0, 120);
    return `sid:${socketId}`;
  }

  private lobbyRoom(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): string {
    if (mode === "direct") return `lobby:direct:${difficultyMode}`;
    return `lobby:study_then_quiz:${subcategoryKey ?? "general_default"}:${difficultyMode}`;
  }

  private privateLobbyRoom(roomCode: string): string {
    return `lobby:private:${roomCode}`;
  }

  private makeRoomCode(): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  private allocateUniqueRoomCode(): string {
    let code = this.makeRoomCode();
    while (this.privateRooms.has(code)) {
      code = this.makeRoomCode();
    }
    return code;
  }

  private buildLobbyPayload(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): LobbyStatePayload {
    const isStarting = Boolean(this.matchStartTimers[mode]);
    const endsAt = this.countdownEndsAt[mode];
    const countdownSecondsRemaining =
      isStarting && endsAt != null
        ? Math.max(1, Math.ceil((endsAt - Date.now()) / 1000))
        : undefined;
    return {
      mode,
      players: [...this.lobbies[mode].values()]
        .filter(
          (p) =>
            p.difficultyMode === difficultyMode &&
            (mode !== "study_then_quiz" || p.subcategoryKey === (subcategoryKey ?? "general_default")),
        )
        .map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
        mode: p.mode,
        subcategoryKey: p.subcategoryKey,
        difficultyMode: p.difficultyMode,
      })),
      isStarting,
      participantSocketIds: [...this.lockedParticipants[mode]],
      maxPlayersPerMatch: this.maxPlayersPerMatch,
      countdownSecondsRemaining,
    };
  }

  private emitPrivateLobbyState(roomCode: string): void {
    const room = this.privateRooms.get(roomCode);
    if (!room) return;
    const countdownSecondsRemaining =
      room.countdownEndsAt != null
        ? Math.max(1, Math.ceil((room.countdownEndsAt - Date.now()) / 1000))
        : undefined;
    const payload: LobbyStatePayload = {
      mode: room.mode,
      players: [...room.members.values()].map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
        mode: p.mode,
        subcategoryKey: p.subcategoryKey,
        difficultyMode: p.difficultyMode,
      })),
      isStarting: Boolean(room.matchStartTimer),
      participantSocketIds: [...room.lockedParticipants],
      maxPlayersPerMatch: 100,
      countdownSecondsRemaining,
      isPrivate: true,
      roomCode: room.roomCode,
      hostSocketId: room.hostSocketId,
      roomSettings: {
        questionMs: room.settings.questionMs,
        studyPhaseMs: room.settings.studyPhaseMs,
      },
    };
    const privatePayload: PrivateRoomStatePayload = {
      roomCode: room.roomCode,
      hostSocketId: room.hostSocketId,
      mode: room.mode,
      subcategoryKey: room.subcategoryKey,
      difficultyMode: room.difficultyMode,
      roomVersion: room.roomVersion,
      players: [...room.members.values()].map((p) => ({
        socketId: p.socketId,
        name: p.name,
        ready: p.ready,
      })),
      isStarting: Boolean(room.matchStartTimer),
      participantSocketIds: [...room.lockedParticipants],
      countdownSecondsRemaining,
      roomSettings: {
        questionMs: room.settings.questionMs,
        studyPhaseMs: room.settings.studyPhaseMs,
      },
    };
    this.io.to(this.privateLobbyRoom(roomCode)).emit("lobby_state", payload);
    this.io.to(this.privateLobbyRoom(roomCode)).emit("private_room_state", privatePayload);
  }

  attachSocket(socket: Socket): void {
    socket.on("reconnect_match", async (raw, cb) => {
      try {
        const playerSessionId = this.resolvePlayerSessionId(raw, socket.id);
        const match = this.playerSessionToMatch.get(playerSessionId);
        if (!match) {
          cb?.({ ok: false, error: "match_not_found" });
          return;
        }
        const reconnect = match.reconnectPlayer(playerSessionId, socket.id);
        if (!reconnect.ok) {
          cb?.({ ok: false, error: "player_not_found" });
          return;
        }
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        this.socketToMatch.set(socket.id, match);
        await socket.join(match.room);
        cb?.({
          ok: true,
          asSpectator: Boolean(reconnect.asSpectator),
        });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("join_lobby", async (raw, cb) => {
      try {
        const parsed = joinLobbySchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: "invalid_name" });
          return;
        }
        const { name, mode } = parsed.data;
        const playerSessionId = this.resolvePlayerSessionId(raw, socket.id);
        const difficultyMode = parsed.data.difficultyMode ?? "mix";
        const subcategoryKey =
          mode === "study_then_quiz"
            ? String(parsed.data.subcategoryKey ?? "general_default").trim()
            : null;
        this.leaveMatchForSocket(socket.id);
        this.leaveLobbyEverywhere(socket.id);
        this.removeFromPrivateRoom(socket.id);
        this.lobbies[mode].set(socket.id, {
          socketId: socket.id,
          playerSessionId,
          name,
          ready: true,
          readyOrder: ++this.readyOrderCounter,
          mode,
          subcategoryKey,
          difficultyMode,
        });
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        await socket.join(this.lobbyRoom(mode, subcategoryKey, difficultyMode));
        this.broadcastLobby(mode, subcategoryKey, difficultyMode);
        socket.emit("lobby_state", this.buildLobbyPayload(mode, subcategoryKey, difficultyMode));
        this.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode);
        cb?.({ ok: true });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("create_private_room", async (raw, cb) => {
      try {
        const parsed = joinLobbySchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: "invalid_body" });
          return;
        }
        const d = parsed.data;
        const playerSessionId = this.resolvePlayerSessionId(raw, socket.id);
        const roomCode = this.allocateUniqueRoomCode();
        const mode = d.mode;
        const subcategoryKey =
          mode === "study_then_quiz"
            ? String(d.subcategoryKey ?? "general_default").trim()
            : null;
        const questionMsRaw = Number((raw as { questionMs?: unknown }).questionMs ?? 15_000);
        const studyPhaseMsRaw = Number((raw as { studyPhaseMs?: unknown }).studyPhaseMs ?? 60_000);
        const settings: PrivateRoomSettings = {
          questionMs: Math.min(120_000, Math.max(5_000, Number.isFinite(questionMsRaw) ? questionMsRaw : 15_000)),
          studyPhaseMs: Math.min(300_000, Math.max(10_000, Number.isFinite(studyPhaseMsRaw) ? studyPhaseMsRaw : 60_000)),
        };
        this.leaveMatchForSocket(socket.id);
        this.leaveLobbyEverywhere(socket.id);
        this.removeFromPrivateRoom(socket.id);
        const entry: LobbyEntry = {
          socketId: socket.id,
          playerSessionId,
          name: d.name,
          ready: false,
          readyOrder: null,
          mode,
          subcategoryKey,
          difficultyMode: d.difficultyMode ?? "mix",
          roomCode,
        };
        const room: PrivateRoomState = {
          roomCode,
          hostSocketId: socket.id,
          mode,
          subcategoryKey,
          difficultyMode: d.difficultyMode ?? "mix",
          settings,
          members: new Map([[socket.id, entry]]),
          lockedParticipants: [],
          countdownEndsAt: null,
          matchStartTimer: null,
          roomVersion: 1,
        };
        this.privateRooms.set(roomCode, room);
        this.socketToPrivateRoomCode.set(socket.id, roomCode);
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        await socket.join(this.privateLobbyRoom(roomCode));
        this.emitPrivateLobbyState(roomCode);
        const origin = String((raw as { origin?: unknown }).origin ?? "").trim();
        const inviteUrl = origin ? `${origin}?room=${roomCode}` : `?room=${roomCode}`;
        cb?.({
          ok: true,
          roomCode,
          inviteUrl,
          hostSocketId: socket.id,
          mode,
          subcategoryKey,
          difficultyMode: d.difficultyMode ?? "mix",
          roomSettings: settings,
          roomVersion: room.roomVersion,
        });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("join_private_room", async (raw, cb) => {
      try {
        const name = String((raw as { name?: unknown }).name ?? "").trim();
        const playerSessionId = this.resolvePlayerSessionId(raw, socket.id);
        const roomCode = String((raw as { roomCode?: unknown }).roomCode ?? "").trim().toUpperCase();
        if (!name || !roomCode) {
          cb?.({ ok: false, error: "invalid_body" });
          return;
        }
        const room = this.privateRooms.get(roomCode);
        if (!room) {
          cb?.({ ok: false, error: "room_not_found", message: "الغرفة غير موجودة." });
          return;
        }
        this.leaveMatchForSocket(socket.id);
        this.leaveLobbyEverywhere(socket.id);
        this.removeFromPrivateRoom(socket.id);
        const entry: LobbyEntry = {
          socketId: socket.id,
          playerSessionId,
          name,
          ready: false,
          readyOrder: null,
          mode: room.mode,
          subcategoryKey: room.subcategoryKey,
          difficultyMode: room.difficultyMode,
          roomCode,
        };
        room.members.set(socket.id, entry);
        room.roomVersion += 1;
        this.socketToPrivateRoomCode.set(socket.id, roomCode);
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        await socket.join(this.privateLobbyRoom(roomCode));
        this.emitPrivateLobbyState(roomCode);
        cb?.({
          ok: true,
          roomCode,
          hostSocketId: room.hostSocketId,
          mode: room.mode,
          subcategoryKey: room.subcategoryKey,
          difficultyMode: room.difficultyMode,
          roomSettings: room.settings,
          roomVersion: room.roomVersion,
        });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("private_room_update_settings", (raw, cb) => {
      const roomCode = this.socketToPrivateRoomCode.get(socket.id);
      if (!roomCode) {
        cb?.({ ok: false, error: "not_in_private_room" });
        return;
      }
      const room = this.privateRooms.get(roomCode);
      if (!room) {
        cb?.({ ok: false, error: "room_not_found" });
        return;
      }
      if (room.hostSocketId !== socket.id) {
        cb?.({ ok: false, error: "forbidden" });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: "countdown_started" });
        return;
      }
      const qRaw = Number((raw as { questionMs?: unknown }).questionMs ?? room.settings.questionMs);
      const sRaw = Number((raw as { studyPhaseMs?: unknown }).studyPhaseMs ?? room.settings.studyPhaseMs);
      room.settings.questionMs = Math.min(120_000, Math.max(5_000, Number.isFinite(qRaw) ? qRaw : room.settings.questionMs));
      room.settings.studyPhaseMs = Math.min(300_000, Math.max(10_000, Number.isFinite(sRaw) ? sRaw : room.settings.studyPhaseMs));
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      cb?.({ ok: true, roomSettings: room.settings, roomVersion: room.roomVersion });
    });

    socket.on("private_room_set_ready", async (raw, cb) => {
      const roomCode = this.socketToPrivateRoomCode.get(socket.id);
      if (!roomCode) {
        cb?.({ ok: false, error: "not_in_private_room" });
        return;
      }
      const room = this.privateRooms.get(roomCode);
      if (!room) {
        cb?.({ ok: false, error: "room_not_found" });
        return;
      }
      const entry = room.members.get(socket.id);
      if (!entry) {
        cb?.({ ok: false, error: "not_in_private_room" });
        return;
      }
      const ready = Boolean((raw as { ready?: unknown }).ready);
      entry.ready = ready;
      if (room.matchStartTimer && ![...room.members.values()].every((m) => m.ready)) {
        clearTimeout(room.matchStartTimer);
        room.matchStartTimer = null;
        room.countdownEndsAt = null;
        room.lockedParticipants = [];
        this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
          reason: "not_all_ready",
          message: "تم إلغاء البدء لأن أحد اللاعبين ألغى الجاهزية.",
        });
      }
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      cb?.({ ok: true, ready, roomVersion: room.roomVersion });
      await this.tryStartPrivateRoom(roomCode);
    });

    socket.on("start_solo_match", async (raw, cb) => {
      try {
        const parsed = joinLobbySchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: "invalid_name" });
          return;
        }
        const { name, mode } = parsed.data;
        const playerSessionId = this.resolvePlayerSessionId(raw, socket.id);
        const difficultyMode = parsed.data.difficultyMode ?? "mix";
        const subcategoryKey =
          mode === "study_then_quiz"
            ? String(parsed.data.subcategoryKey ?? "general_default").trim()
            : null;

        if (mode === "study_then_quiz") {
          const key = subcategoryKey ?? "general_default";
          const difficultyFilter = difficultyMode === "mix" ? null : difficultyMode;
          const total = await countQuestionsBySubcategory(getPool(), key, true, difficultyFilter);
          if (total < 30) {
            cb?.({
              ok: false,
              error: "not_enough_questions",
              message: difficultyMode === "mix"
                ? "لا توجد أسئلة كافية في هذا التصنيف."
                : "لا توجد أسئلة كافية في مستوى الصعوبة هذا داخل التصنيف. جرّب اختيار مزيج.",
            });
            return;
          }
        }

        this.leaveMatchForSocket(socket.id);
        this.leaveLobbyEverywhere(socket.id);
        this.removeFromPrivateRoom(socket.id);

        const matchId = randomUUID();
        const match = new Match(
          this.io,
          matchId,
          [{ socketId: socket.id, name, playerSessionId }],
          mode,
          mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
          difficultyMode,
        );

        await socket.join(match.room);
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        this.socketToMatch.set(socket.id, match);
        this.playerSessionToMatch.set(playerSessionId, match);
        this.runningMatches.set(matchId, match);
        cb?.({ ok: true });

        void (async () => {
          try {
            await match.run();
          } finally {
            this.socketToMatch.delete(socket.id);
            this.playerSessionToMatch.delete(playerSessionId);
            const s = this.io.sockets.sockets.get(socket.id);
            if (s) {
              try {
                await Promise.resolve(s.leave(match.room));
              } catch {
                /* ignore */
              }
            }
            this.runningMatches.delete(matchId);
          }
        })();
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
      this.broadcastLobby(entry.mode, entry.subcategoryKey, entry.difficultyMode);
      this.enqueueScheduleMatchStart(entry.mode, entry.subcategoryKey, entry.difficultyMode);
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
      this.removeFromPrivateRoom(socket.id);
      const playerSessionId = this.socketToPlayerSessionId.get(socket.id);
      const match = this.socketToMatch.get(socket.id);
      if (match) {
        match.handleDisconnect(socket.id);
        this.socketToMatch.delete(socket.id);
        if (playerSessionId) {
          this.playerSessionToMatch.set(playerSessionId, match);
        }
      }
      this.socketToPlayerSessionId.delete(socket.id);
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
      const prev = this.lobbies[mode].get(socketId);
      if (this.lobbies[mode].delete(socketId)) {
        this.lockedParticipants[mode] = this.lockedParticipants[mode].filter((id) => id !== socketId);
        void this.io.sockets.sockets.get(socketId)?.leave(
          this.lobbyRoom(mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix"),
        );
        this.clearMatchStartTimerIfNeeded(mode);
        this.broadcastLobby(mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix");
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
    void this.io.sockets.sockets.get(socketId)?.leave(
      this.lobbyRoom(entry.mode, entry.subcategoryKey, entry.difficultyMode),
    );
    this.clearMatchStartTimerIfNeeded(entry.mode);
    this.broadcastLobby(entry.mode, entry.subcategoryKey, entry.difficultyMode);
  }

  private removeFromPrivateRoom(socketId: string): void {
    const roomCode = this.socketToPrivateRoomCode.get(socketId);
    if (!roomCode) return;
    this.socketToPrivateRoomCode.delete(socketId);
    const room = this.privateRooms.get(roomCode);
    if (!room) return;
    room.members.delete(socketId);
    room.lockedParticipants = room.lockedParticipants.filter((id) => id !== socketId);
    room.roomVersion += 1;
    void this.io.sockets.sockets.get(socketId)?.leave(this.privateLobbyRoom(roomCode));
    if (room.hostSocketId === socketId) {
      const nextHost = room.members.keys().next().value as string | undefined;
      if (nextHost) {
        room.hostSocketId = nextHost;
      room.roomVersion += 1;
      } else {
        if (room.matchStartTimer) {
          clearTimeout(room.matchStartTimer);
          room.matchStartTimer = null;
        }
        this.privateRooms.delete(roomCode);
        return;
      }
    }
    this.emitPrivateLobbyState(roomCode);
  }

  private async tryStartPrivateRoom(roomCode: string): Promise<void> {
    const room = this.privateRooms.get(roomCode);
    if (!room || room.matchStartTimer) return;
    const members = [...room.members.values()];
    if (members.length < 1) return;
    const allReady = members.every((m) => m.ready);
    if (!allReady) return;
    if (room.mode === "study_then_quiz") {
      const key = room.subcategoryKey ?? "general_default";
      const difficultyFilter = room.difficultyMode === "mix" ? null : room.difficultyMode;
      const total = await countQuestionsBySubcategory(getPool(), key, true, difficultyFilter);
      if (total < 30) {
        this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
          reason: "not_enough_questions",
          message: room.difficultyMode === "mix"
            ? "لا توجد أسئلة كافية في هذا التصنيف."
            : "لا توجد أسئلة كافية في مستوى الصعوبة هذا داخل التصنيف. جرّب اختيار مزيج.",
          difficultyMode: room.difficultyMode,
        });
        return;
      }
    }
    room.lockedParticipants = members.map((m) => m.socketId);
    room.countdownEndsAt = Date.now() + (this.matchFillWindowSeconds * 1000);
    room.roomVersion += 1;
    this.io.to(this.privateLobbyRoom(roomCode)).emit("match_starting", {
      seconds: Math.max(1, Math.ceil((room.countdownEndsAt - Date.now()) / 1000)),
      participantSocketIds: room.lockedParticipants,
    });
    this.emitPrivateLobbyState(roomCode);
    room.matchStartTimer = setTimeout(() => {
      room.matchStartTimer = null;
      room.countdownEndsAt = null;
      room.roomVersion += 1;
      void this.startPrivateRoomMatch(roomCode);
    }, this.matchFillWindowSeconds * 1000);
  }

  private async startPrivateRoomMatch(roomCode: string): Promise<void> {
    const room = this.privateRooms.get(roomCode);
    if (!room) return;
    const participants = room.lockedParticipants
      .map((id) => room.members.get(id))
      .filter((p): p is LobbyEntry => Boolean(p))
      .filter((p) => Boolean(this.io.sockets.sockets.get(p.socketId)?.connected && p.ready));
    if (participants.length < 1) {
      room.lockedParticipants = [];
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      return;
    }
    const matchId = randomUUID();
    const match = new Match(
      this.io,
      matchId,
      participants,
      room.mode,
      room.mode === "study_then_quiz" ? (room.subcategoryKey ?? "general_default") : null,
      room.difficultyMode,
      {
        questionMsOverride: room.settings.questionMs,
        studyPhaseMsOverride: room.settings.studyPhaseMs,
      },
    );
    await Promise.all(participants.map(async (p) => {
      room.members.delete(p.socketId);
      this.socketToPrivateRoomCode.delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.privateLobbyRoom(roomCode));
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
        this.socketToPlayerSessionId.set(p.socketId, p.playerSessionId);
        this.playerSessionToMatch.set(p.playerSessionId, match);
      }
    }));
    room.lockedParticipants = [];
    room.roomVersion += 1;
    this.runningMatches.set(matchId, match);
    this.emitPrivateLobbyState(roomCode);
    try {
      await match.run();
    } finally {
      for (const p of participants) {
        this.socketToMatch.delete(p.socketId);
        this.playerSessionToMatch.delete(p.playerSessionId);
        const s = this.io.sockets.sockets.get(p.socketId);
        if (s) {
          try {
            await Promise.resolve(s.leave(match.room));
          } catch {
            /* ignore */
          }
          if (s.connected && this.privateRooms.has(roomCode)) {
            const restoredEntry: LobbyEntry = {
              socketId: p.socketId,
              playerSessionId: p.playerSessionId,
              name: p.name,
              ready: false,
              readyOrder: null,
              mode: room.mode,
              subcategoryKey: room.subcategoryKey,
              difficultyMode: room.difficultyMode,
              roomCode,
            };
            room.members.set(p.socketId, restoredEntry);
            this.socketToPrivateRoomCode.set(p.socketId, roomCode);
            this.socketToPlayerSessionId.set(p.socketId, p.playerSessionId);
            try {
              await Promise.resolve(s.join(this.privateLobbyRoom(roomCode)));
            } catch {
              /* ignore */
            }
          }
        }
      }
      room.lockedParticipants = [];
      room.countdownEndsAt = null;
      if (!room.members.has(room.hostSocketId)) {
        const nextHost = room.members.keys().next().value as string | undefined;
        if (nextHost) {
          room.hostSocketId = nextHost;
        } else {
          this.privateRooms.delete(roomCode);
          this.runningMatches.delete(matchId);
          return;
        }
      }
      room.roomVersion += 1;
      this.runningMatches.delete(matchId);
      this.emitPrivateLobbyState(roomCode);
    }
  }

  private leaveMatchForSocket(socketId: string): void {
    const m = this.socketToMatch.get(socketId);
    if (!m) return;
    const playerSessionId = this.socketToPlayerSessionId.get(socketId);
    m.handleDisconnect(socketId);
    this.socketToMatch.delete(socketId);
    if (playerSessionId) {
      this.playerSessionToMatch.set(playerSessionId, m);
    }
    void this.io.sockets.sockets.get(socketId)?.leave(m.room);
  }

  private readyPlayers(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): LobbyEntry[] {
    return [...this.lobbies[mode].values()].filter(
      (p) =>
        p.ready &&
        p.difficultyMode === difficultyMode &&
        (mode !== "study_then_quiz" || p.subcategoryKey === (subcategoryKey ?? "general_default")),
    );
  }

  private sortedReadyPlayers(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): LobbyEntry[] {
    return this.readyPlayers(mode, subcategoryKey, difficultyMode).sort((a, b) => {
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

  private broadcastLobby(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): void {
    this.io
      .to(this.lobbyRoom(mode, subcategoryKey, difficultyMode))
      .emit("lobby_state", this.buildLobbyPayload(mode, subcategoryKey, difficultyMode));
  }

  private enqueueScheduleMatchStart(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): void {
    this.scheduleChain[mode] = this.scheduleChain[mode]
      .catch(() => undefined)
      .then(() => this.runScheduleMatchStart(mode, subcategoryKey, difficultyMode));
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
        this.countdownGroup[mode] = null;
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

  private emitMatchStarting(
    mode: GameMode,
    locked: string[],
    maxPlayers: number,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): void {
    const fillMs = this.matchFillWindowSeconds * 1000;
    const endsAt = this.countdownEndsAt[mode] ?? Date.now() + fillMs;
    const seconds = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));
    this.io.to(this.lobbyRoom(mode, subcategoryKey, difficultyMode)).emit("match_starting", {
      seconds,
      participantSocketIds: locked,
      maxPlayersPerMatch: maxPlayers,
      lockedCount: locked.length,
    });
  }

  private async updateRosterDuringCountdown(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): Promise<void> {
    const activeGroup = this.countdownGroup[mode];
    const normalizedSubcategory =
      mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null;
    if (activeGroup && activeGroup.subcategoryKey !== normalizedSubcategory) {
      return;
    }
    if (activeGroup && activeGroup.difficultyMode !== difficultyMode) {
      return;
    }
    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const locked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode)
      .slice(0, maxPlayers)
      .map((p) => p.socketId);
    if (locked.length < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
      }
      this.countdownEndsAt[mode] = null;
      this.countdownGroup[mode] = null;
      this.lockedParticipants[mode] = [];
      this.io.to(this.lobbyRoom(mode, subcategoryKey, difficultyMode)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(mode, subcategoryKey, difficultyMode);
      if (this.readyPlayers(mode, subcategoryKey, difficultyMode).length >= 2) {
        this.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode);
      }
      return;
    }
    this.lockedParticipants[mode] = locked;
    this.emitMatchStarting(mode, locked, maxPlayers, subcategoryKey, difficultyMode);
    this.broadcastLobby(mode, subcategoryKey, difficultyMode);
  }

  private async runScheduleMatchStart(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): Promise<void> {
    const ready = this.readyPlayers(mode, subcategoryKey, difficultyMode);
    if (ready.length < 2) {
      if (!this.matchStartTimers[mode]) {
        this.clearMatchStartTimerIfNeeded(mode);
      }
      return;
    }

    if (this.matchStartTimers[mode]) {
      const activeGroup = this.countdownGroup[mode];
      const normalizedSubcategory =
        mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null;
      if (
        activeGroup &&
        activeGroup.subcategoryKey === normalizedSubcategory &&
        activeGroup.difficultyMode === difficultyMode
      ) {
        await this.updateRosterDuringCountdown(mode, subcategoryKey, difficultyMode);
      }
      return;
    }

    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const fillSeconds = await this.loadMatchFillWindowSeconds();
    const fillMs = fillSeconds * 1000;
    const locked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode)
      .slice(0, maxPlayers)
      .map((p) => p.socketId);
    if (locked.length < 2) return;

    if (this.matchStartTimers[mode]) {
      await this.updateRosterDuringCountdown(mode, subcategoryKey, difficultyMode);
      return;
    }

    this.lockedParticipants[mode] = locked;
    this.countdownEndsAt[mode] = Date.now() + fillMs;
    this.countdownGroup[mode] = {
      subcategoryKey: mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
      difficultyMode,
    };
    this.emitMatchStarting(mode, locked, maxPlayers, subcategoryKey, difficultyMode);
    this.broadcastLobby(mode, subcategoryKey, difficultyMode);

    this.matchStartTimers[mode] = setTimeout(() => {
      this.matchStartTimers[mode] = null;
      this.countdownEndsAt[mode] = null;
      this.countdownGroup[mode] = null;
      void this.startMatchFromLobby(mode, subcategoryKey, difficultyMode);
    }, fillMs);
  }

  private async startMatchFromLobby(
    gameMode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
  ): Promise<void> {
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
      this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode);
      if (this.readyPlayers(gameMode, subcategoryKey, difficultyMode).length >= 2) {
        this.enqueueScheduleMatchStart(gameMode, subcategoryKey, difficultyMode);
      }
      return;
    }
    if (gameMode === "study_then_quiz") {
      const key = subcategoryKey ?? "general_default";
      const difficultyFilter = difficultyMode === "mix" ? null : difficultyMode;
      const total = await countQuestionsBySubcategory(getPool(), key, true, difficultyFilter);
      if (total < 30) {
        const isMix = difficultyMode === "mix";
        this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode)).emit("match_start_cancelled", {
          reason: "not_enough_questions",
          message: isMix
            ? "لا توجد أسئلة كافية في هذا التصنيف."
            : "لا توجد أسئلة كافية في مستوى الصعوبة هذا داخل التصنيف. جرّب اختيار مزيج.",
          difficultyMode,
        });
        this.broadcastLobby(gameMode, subcategoryKey, difficultyMode);
        return;
      }
    }
    this.lockedParticipants[gameMode] = [];
    const matchId = randomUUID();
    const match = new Match(
      this.io,
      matchId,
      participants,
      gameMode,
      gameMode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
      difficultyMode,
    );

    await Promise.all(participants.map(async (p) => {
      this.lobbies[gameMode].delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode));
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
        this.socketToPlayerSessionId.set(p.socketId, p.playerSessionId);
        this.playerSessionToMatch.set(p.playerSessionId, match);
      }
    }));
    const roomsReadyMs = Date.now() - startedAt;
    console.debug(`[matchmaking] lobby_to_match_rooms_ms=${roomsReadyMs} mode=${gameMode} participants=${participants.length}`);

    this.runningMatches.set(matchId, match);
    this.broadcastLobby(gameMode, subcategoryKey, difficultyMode);

    try {
      await match.run();
    } finally {
      for (const p of participants) {
        this.socketToMatch.delete(p.socketId);
        this.playerSessionToMatch.delete(p.playerSessionId);
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
