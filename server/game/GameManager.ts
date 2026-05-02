import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getPool } from "../db/pool";
import { getPublishedLessonPlaybackById, type LessonPlaybackPayload } from "../db/lessons";
import { getCustomLessonPlayback } from "../customLessonSessions";
import { countQuestionsBySubcategory } from "../db/questions";
import { Match, type DifficultyMode, type GameMode } from "./Match";

const joinLobbySchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    mode: z.enum(["direct", "study_then_quiz", "lesson"]).default("direct"),
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    lessonId: z.number().int().positive().optional(),
    difficultyMode: z.enum(["mix", "easy", "medium", "hard"]).default("mix"),
    playerSessionId: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "lesson") {
      if (data.lessonId == null || !Number.isFinite(data.lessonId) || data.lessonId < 1) {
        ctx.addIssue({ code: "custom", path: ["lessonId"], message: "lesson_id_required" });
      }
    }
  });

/** غرفة خاصة + فردي عبر السيرفر: درس منشور أو درس مخصص برمز جلسة */
const joinLessonFlexibleSchema = z
  .object({
    name: z.string().trim().min(1).max(32),
    mode: z.enum(["direct", "study_then_quiz", "lesson"]).default("direct"),
    subcategoryKey: z.string().trim().min(1).max(120).optional(),
    lessonId: z.number().int().positive().optional(),
    customLessonToken: z.string().uuid().optional(),
    difficultyMode: z.enum(["mix", "easy", "medium", "hard"]).default("mix"),
    playerSessionId: z.string().trim().min(1).max(120).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "lesson") {
      const hasToken = Boolean(data.customLessonToken?.trim());
      const hasLesson = data.lessonId != null && Number.isFinite(data.lessonId) && data.lessonId >= 1;
      if (!hasToken && !hasLesson) {
        ctx.addIssue({ code: "custom", path: ["lessonId"], message: "lesson_id_or_token_required" });
      }
      if (hasToken && hasLesson) {
        ctx.addIssue({
          code: "custom",
          path: ["customLessonToken"],
          message: "lesson_token_and_id_conflict",
        });
      }
    }
  });

const answerSchema = z.object({
  questionId: z.number().int().positive(),
  choiceIndex: z.number().int().min(0),
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
  /** مطلوب عند mode === "lesson" */
  lessonId: number | null;
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
  lessonId: number | null;
  /** عند الدرس المخصص: حمولة جاهزة بدل القراءة من قاعدة البيانات */
  customLessonPlayback: LessonPlaybackPayload | null;
  customLessonToken: string | null;
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
  lessonId: number | null;
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
    lesson: new Map(),
  };
  private readonly matchStartTimers: Record<
    GameMode,
    ReturnType<typeof setTimeout> | null
  > = {
    direct: null,
    study_then_quiz: null,
    lesson: null,
  };
  private readonly countdownEndsAt: Record<GameMode, number | null> = {
    direct: null,
    study_then_quiz: null,
    lesson: null,
  };
  private readonly countdownGroup: Record<
    GameMode,
    { subcategoryKey: string | null; difficultyMode: DifficultyMode; lessonId: number | null } | null
  > = {
    direct: null,
    study_then_quiz: null,
    lesson: null,
  };
  private readonly scheduleChain: Record<GameMode, Promise<void>> = {
    direct: Promise.resolve(),
    study_then_quiz: Promise.resolve(),
    lesson: Promise.resolve(),
  };
  private readonly socketToMatch = new Map<string, Match>();
  private readonly socketToPlayerSessionId = new Map<string, string>();
  private readonly playerSessionToMatch = new Map<string, Match>();
  private readonly runningMatches = new Map<string, Match>();
  private readonly lockedParticipants: Record<GameMode, string[]> = {
    direct: [],
    study_then_quiz: [],
    lesson: [],
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
    lessonId?: number | null,
  ): string {
    if (mode === "direct") return `lobby:direct:${difficultyMode}`;
    if (mode === "lesson") return `lobby:lesson:${lessonId ?? 0}`;
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
    lessonId?: number | null,
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
            (mode !== "study_then_quiz" || p.subcategoryKey === (subcategoryKey ?? "general_default")) &&
            (mode !== "lesson" || p.lessonId === lessonId),
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
      lessonId: room.lessonId,
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
        const lessonId = mode === "lesson" ? (parsed.data.lessonId ?? null) : null;
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
          lessonId,
          difficultyMode,
        });
        this.socketToPlayerSessionId.set(socket.id, playerSessionId);
        await socket.join(this.lobbyRoom(mode, subcategoryKey, difficultyMode, lessonId));
        this.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);
        socket.emit("lobby_state", this.buildLobbyPayload(mode, subcategoryKey, difficultyMode, lessonId));
        this.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode, lessonId);
        cb?.({ ok: true });
      } catch {
        cb?.({ ok: false, error: "server" });
      }
    });

    socket.on("create_private_room", async (raw, cb) => {
      try {
        const parsed = joinLessonFlexibleSchema.safeParse(raw);
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
        const tokenRaw = String(d.customLessonToken ?? "").trim();
        let customLessonPlayback: LessonPlaybackPayload | null = null;
        let lessonId: number | null = mode === "lesson" ? (d.lessonId ?? null) : null;
        if (mode === "lesson") {
          if (tokenRaw) {
            customLessonPlayback = getCustomLessonPlayback(tokenRaw);
            if (!customLessonPlayback || customLessonPlayback.steps.length === 0) {
              cb?.({
                ok: false,
                error: "custom_lesson_expired",
                message: "انتهت صلاحية الدرس المخصص أو غير صالح. أعد التحقق من JSON ثم أنشئ جلسة جديدة.",
              });
              return;
            }
            lessonId = null;
          } else if (lessonId == null || lessonId < 1) {
            cb?.({ ok: false, error: "lesson_id_required", message: "اختر درساً صالحاً." });
            return;
          }
        }
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
          lessonId,
          difficultyMode: d.difficultyMode ?? "mix",
          roomCode,
        };
        const room: PrivateRoomState = {
          roomCode,
          hostSocketId: socket.id,
          mode,
          subcategoryKey,
          lessonId,
          customLessonPlayback,
          customLessonToken: tokenRaw || null,
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
          lessonId: room.lessonId,
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
          lessonId: room.lessonId,
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
          lessonId: room.lessonId,
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
        const parsed = joinLessonFlexibleSchema.safeParse(raw);
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
        const tokenSolo = String(parsed.data.customLessonToken ?? "").trim();
        let lessonId = mode === "lesson" ? (parsed.data.lessonId ?? null) : null;
        let lessonPlaybackForMatch: LessonPlaybackPayload | null = null;

        if (mode === "lesson") {
          if (tokenSolo) {
            lessonPlaybackForMatch = getCustomLessonPlayback(tokenSolo);
            if (!lessonPlaybackForMatch || lessonPlaybackForMatch.steps.length === 0) {
              cb?.({
                ok: false,
                error: "custom_lesson_expired",
                message: "انتهت صلاحية الدرس المخصص أو غير صالح.",
              });
              return;
            }
            lessonId = null;
          } else {
            if (lessonId == null || lessonId < 1) {
              cb?.({ ok: false, error: "lesson_id_required", message: "معرّف الدرس مطلوب." });
              return;
            }
            lessonPlaybackForMatch = await getPublishedLessonPlaybackById(lessonId);
            if (!lessonPlaybackForMatch || lessonPlaybackForMatch.steps.length === 0) {
              cb?.({
                ok: false,
                error: "lesson_not_found",
                message: "الدرس غير متاح أو غير منشور.",
              });
              return;
            }
          }
        }

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
          undefined,
          lessonPlaybackForMatch,
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
            for (const [sessionId, mappedMatch] of this.playerSessionToMatch.entries()) {
              if (mappedMatch === match) this.playerSessionToMatch.delete(sessionId);
            }
            for (const [socketId, mappedMatch] of this.socketToMatch.entries()) {
              if (mappedMatch === match) this.socketToMatch.delete(socketId);
            }
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
      this.broadcastLobby(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId);
      this.enqueueScheduleMatchStart(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId);
      cb?.({ ok: true });
    });

    socket.on("answer", (raw, cb) => {
      const match = this.socketToMatch.get(socket.id);
      const parsed = answerSchema.safeParse(raw);
      if (!match || !parsed.success) {
        cb?.({ ok: false });
        return;
      }
      if (!match.canAcceptChoice(parsed.data.questionId, parsed.data.choiceIndex)) {
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
    for (const mode of ["direct", "study_then_quiz", "lesson"] as const) {
      const e = this.lobbies[mode].get(socketId);
      if (e) return e;
    }
    return undefined;
  }

  private leaveLobbyEverywhere(socketId: string): void {
    for (const mode of ["direct", "study_then_quiz", "lesson"] as const) {
      const prev = this.lobbies[mode].get(socketId);
      if (this.lobbies[mode].delete(socketId)) {
        this.lockedParticipants[mode] = this.lockedParticipants[mode].filter((id) => id !== socketId);
        void this.io.sockets.sockets.get(socketId)?.leave(
          this.lobbyRoom(mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix", prev?.lessonId),
        );
        this.clearMatchStartTimerIfNeeded(mode);
        this.broadcastLobby(mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix", prev?.lessonId);
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
      this.lobbyRoom(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId),
    );
    this.clearMatchStartTimerIfNeeded(entry.mode);
    this.broadcastLobby(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId);
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
    if (members.length < 2) return;
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
    if (room.mode === "lesson") {
      if (room.customLessonPlayback) {
        if (room.customLessonPlayback.steps.length === 0) {
          this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
            reason: "lesson_invalid",
            message: "الدرس المخصص لا يحتوي على خطوات.",
          });
          return;
        }
      } else {
        const lid = room.lessonId;
        if (lid == null || lid < 1) {
          this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
            reason: "lesson_invalid",
            message: "غرفة الدرس لا تحتوي على معرّف درس صالح.",
          });
          return;
        }
        const lesson = await getPublishedLessonPlaybackById(lid);
        if (!lesson || lesson.steps.length === 0) {
          this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
            reason: "lesson_not_found",
            message: "الدرس غير متاح أو غير منشور.",
          });
          return;
        }
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
    if (participants.length < 2) {
      room.lockedParticipants = [];
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      return;
    }
    const matchId = randomUUID();
    const lessonPlayback =
      room.mode === "lesson" && room.customLessonPlayback
        ? room.customLessonPlayback
        : room.mode === "lesson" && room.lessonId != null
          ? await getPublishedLessonPlaybackById(room.lessonId)
          : null;
    if (room.mode === "lesson" && !lessonPlayback) {
      room.lockedParticipants = [];
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      return;
    }
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
      lessonPlayback,
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
              lessonId: room.lessonId,
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
      for (const [sessionId, mappedMatch] of this.playerSessionToMatch.entries()) {
        if (mappedMatch === match) this.playerSessionToMatch.delete(sessionId);
      }
      for (const [socketId, mappedMatch] of this.socketToMatch.entries()) {
        if (mappedMatch === match) this.socketToMatch.delete(socketId);
      }
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
    lessonId?: number | null,
  ): LobbyEntry[] {
    return [...this.lobbies[mode].values()].filter(
      (p) =>
        p.ready &&
        p.difficultyMode === difficultyMode &&
        (mode !== "study_then_quiz" || p.subcategoryKey === (subcategoryKey ?? "general_default")) &&
        (mode !== "lesson" || p.lessonId === lessonId),
    );
  }

  private sortedReadyPlayers(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
    lessonId?: number | null,
  ): LobbyEntry[] {
    return this.readyPlayers(mode, subcategoryKey, difficultyMode, lessonId).sort((a, b) => {
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
    lessonId?: number | null,
  ): void {
    this.io
      .to(this.lobbyRoom(mode, subcategoryKey, difficultyMode, lessonId))
      .emit("lobby_state", this.buildLobbyPayload(mode, subcategoryKey, difficultyMode, lessonId));
  }

  private enqueueScheduleMatchStart(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
    lessonId?: number | null,
  ): void {
    this.scheduleChain[mode] = this.scheduleChain[mode]
      .catch(() => undefined)
      .then(() => this.runScheduleMatchStart(mode, subcategoryKey, difficultyMode, lessonId));
  }

  private clearMatchStartTimerIfNeeded(mode: GameMode): void {
    const g = this.countdownGroup[mode];
    const sub = mode === "study_then_quiz" ? (g?.subcategoryKey ?? "general_default") : null;
    const diff = g?.difficultyMode ?? "mix";
    const lessonId = mode === "lesson" ? (g?.lessonId ?? null) : null;
    const effectiveReadyCount =
      this.lockedParticipants[mode].length > 0
        ? this.lockedParticipants[mode].length
        : this.readyPlayers(mode, sub, diff, lessonId).length;
    if (effectiveReadyCount < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
        this.countdownEndsAt[mode] = null;
        this.countdownGroup[mode] = null;
        this.lockedParticipants[mode] = [];
        this.io.to(this.lobbyRoom(mode, sub ?? undefined, diff, lessonId)).emit("match_start_cancelled", {
          reason: "not_enough_ready",
        });
        if (this.readyPlayers(mode, sub, diff, lessonId).length >= 2) {
          this.enqueueScheduleMatchStart(mode, sub, diff, lessonId);
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
    lessonId?: number | null,
  ): void {
    const fillMs = this.matchFillWindowSeconds * 1000;
    const endsAt = this.countdownEndsAt[mode] ?? Date.now() + fillMs;
    const seconds = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));
    this.io.to(this.lobbyRoom(mode, subcategoryKey, difficultyMode, lessonId)).emit("match_starting", {
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
    lessonId?: number | null,
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
    if (mode === "lesson" && activeGroup && activeGroup.lessonId !== lessonId) {
      return;
    }
    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const locked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode, lessonId)
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
      this.io.to(this.lobbyRoom(mode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);
      if (this.readyPlayers(mode, subcategoryKey, difficultyMode, lessonId).length >= 2) {
        this.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode, lessonId);
      }
      return;
    }
    this.lockedParticipants[mode] = locked;
    this.emitMatchStarting(mode, locked, maxPlayers, subcategoryKey, difficultyMode, lessonId);
    this.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);
  }

  private async runScheduleMatchStart(
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
    lessonId?: number | null,
  ): Promise<void> {
    const ready = this.readyPlayers(mode, subcategoryKey, difficultyMode, lessonId);
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
      let sameBucket = false;
      if (mode === "study_then_quiz") {
        sameBucket =
          Boolean(activeGroup) &&
          activeGroup!.subcategoryKey === normalizedSubcategory &&
          activeGroup!.difficultyMode === difficultyMode;
      } else if (mode === "lesson") {
        sameBucket =
          Boolean(activeGroup) &&
          activeGroup!.lessonId === lessonId &&
          activeGroup!.difficultyMode === difficultyMode;
      } else {
        sameBucket = Boolean(activeGroup) && activeGroup!.difficultyMode === difficultyMode;
      }
      if (sameBucket) {
        await this.updateRosterDuringCountdown(mode, subcategoryKey, difficultyMode, lessonId);
      }
      return;
    }

    const maxPlayers = await this.loadMaxPlayersPerMatch();
    const fillSeconds = await this.loadMatchFillWindowSeconds();
    const fillMs = fillSeconds * 1000;
    const locked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode, lessonId)
      .slice(0, maxPlayers)
      .map((p) => p.socketId);
    if (locked.length < 2) return;

    if (this.matchStartTimers[mode]) {
      await this.updateRosterDuringCountdown(mode, subcategoryKey, difficultyMode, lessonId);
      return;
    }

    this.lockedParticipants[mode] = locked;
    this.countdownEndsAt[mode] = Date.now() + fillMs;
    this.countdownGroup[mode] = {
      subcategoryKey: mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
      difficultyMode,
      lessonId: mode === "lesson" ? lessonId ?? null : null,
    };
    this.emitMatchStarting(mode, locked, maxPlayers, subcategoryKey, difficultyMode, lessonId);
    this.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);

    this.matchStartTimers[mode] = setTimeout(() => {
      this.matchStartTimers[mode] = null;
      this.countdownEndsAt[mode] = null;
      this.countdownGroup[mode] = null;
      void this.startMatchFromLobby(mode, subcategoryKey, difficultyMode, lessonId);
    }, fillMs);
  }

  private async startMatchFromLobby(
    gameMode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode: DifficultyMode = "mix",
    lessonId?: number | null,
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
      this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
      if (this.readyPlayers(gameMode, subcategoryKey, difficultyMode, lessonId).length >= 2) {
        this.enqueueScheduleMatchStart(gameMode, subcategoryKey, difficultyMode, lessonId);
      }
      return;
    }
    if (gameMode === "study_then_quiz") {
      const key = subcategoryKey ?? "general_default";
      const difficultyFilter = difficultyMode === "mix" ? null : difficultyMode;
      const total = await countQuestionsBySubcategory(getPool(), key, true, difficultyFilter);
      if (total < 30) {
        const isMix = difficultyMode === "mix";
        this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
          reason: "not_enough_questions",
          message: isMix
            ? "لا توجد أسئلة كافية في هذا التصنيف."
            : "لا توجد أسئلة كافية في مستوى الصعوبة هذا داخل التصنيف. جرّب اختيار مزيج.",
          difficultyMode,
        });
        this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
        return;
      }
    }
    let lessonPlaybackForLobby: Awaited<ReturnType<typeof getPublishedLessonPlaybackById>> = null;
    if (gameMode === "lesson") {
      const lid = lessonId ?? participants[0]?.lessonId ?? null;
      if (lid == null || lid < 1) {
        this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
          reason: "lesson_invalid",
          message: "معرّف الدرس غير صالح.",
        });
        this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
        return;
      }
      lessonPlaybackForLobby = await getPublishedLessonPlaybackById(lid);
      if (!lessonPlaybackForLobby || lessonPlaybackForLobby.steps.length === 0) {
        this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
          reason: "lesson_not_found",
          message: "الدرس غير متاح أو غير منشور.",
        });
        this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
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
      undefined,
      lessonPlaybackForLobby,
    );

    await Promise.all(participants.map(async (p) => {
      this.lobbies[gameMode].delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId));
        await s.join(match.room);
        this.socketToMatch.set(p.socketId, match);
        this.socketToPlayerSessionId.set(p.socketId, p.playerSessionId);
        this.playerSessionToMatch.set(p.playerSessionId, match);
      }
    }));
    const roomsReadyMs = Date.now() - startedAt;
    console.debug(`[matchmaking] lobby_to_match_rooms_ms=${roomsReadyMs} mode=${gameMode} participants=${participants.length}`);

    this.runningMatches.set(matchId, match);
    this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);

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
      for (const [sessionId, mappedMatch] of this.playerSessionToMatch.entries()) {
        if (mappedMatch === match) this.playerSessionToMatch.delete(sessionId);
      }
      for (const [socketId, mappedMatch] of this.socketToMatch.entries()) {
        if (mappedMatch === match) this.socketToMatch.delete(socketId);
      }
    }
  }
}
