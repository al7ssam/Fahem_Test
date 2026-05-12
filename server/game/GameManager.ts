import type { Server, Socket } from "socket.io";
import { randomUUID } from "crypto";
import type {
  ClientToServerEvents,
  FahemSocketData,
  InterServerEvents,
  ServerToClientEvents,
} from "../../shared/socketEvents";
import { getPool } from "../db/pool";
import { getPublishedLessonPlaybackById, type LessonPlaybackPayload } from "../db/lessons";
import { getCustomLessonPlayback } from "../customLessonSessions";
import { countQuestionsBySubcategory, getStudyModeTimingOverridesBySubcategoryKey } from "../db/questions";
import { Match, type DifficultyMode, type GameMode } from "./Match";
import { registerPrivateRoomSocketHandlers } from "./privateRoomSocketHandlers";
import { MATCH_RECONNECT_GRACE_MS } from "./reconnectConfig";
import type { MatchSeatInput } from "./participantTypes";
import type {
  MatchPrivateRuntimeOptions,
  MatchPrivateTeamsStartConfig,
  PrivateRoomHeartsPerPlayer,
  PrivateRoomTeamPlayMode,
  PrivateRoomTeamsLobbyPayload,
  PrivateRoomTeamsLobbyState,
} from "./privateRoomTeamTypes";
import {
  allRoomMembersAssignedToTeams,
  clampDesiredTeamCount,
  createEmptyTeamsLobbyState,
  defaultTeamDisplayName,
  listUnassignedParticipantIds,
  nonEmptyTeamSnapshots,
  teamsLobbyToPayload,
} from "./privateRoomTeamTypes";
import {
  clampGameQuestionMs,
  clampGameStudyPhaseMs,
  fetchGameTimingFromAppSettings,
} from "./runtimeGameTiming";
import {
  abilityHeartAttackSchema,
  answerSchema,
  ignoredClientBodySchema,
  joinLessonFlexibleSchema,
} from "./socketSchemas";
import {
  attachJoinLobbySocketHandler,
  attachPlayerReadySocketHandler,
  type LobbySocketDeps,
} from "./coordinators/LobbyCoordinator";
import { attachReconnectSocketHandlers, type ReconnectSocketDeps } from "./coordinators/ReconnectCoordinator";
import { fahemStructuredLog, isFahemDebugRealtime } from "../runtime/fahemStructuredLog";
import { InMemoryRuntimeStats } from "../runtime/inMemoryRuntimeStats";
import { Ack } from "../../shared/socketAckErrorCodes";
import type { LobbyStateWirePayload, PrivateRoomStateWirePayload } from "../../shared/lobbyStateWire";
import {
  buildPrivateRoomWirePayloadPair,
  buildPublicLobbyWirePayload,
} from "./payloads/buildLobbyWirePayloads";

const RESUME_MATCH_RATE_WINDOW_MS = 60_000;
const RESUME_MATCH_RATE_MAX = 25;

const DEFAULT_MATCH_FILL_WINDOW_SECONDS = 5;
const DEFAULT_MAX_PLAYERS_PER_MATCH = 10;
const MATCH_SETTINGS_CACHE_MS = 15_000;

export type LobbyEntry = {
  participantId: string;
  /** مقبس النقل الحالي لهذا المقعد (يُحدَّد عند reconnect عبر GameManager). */
  socketId: string;
  userId: string | null;
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

type LobbyStatePayload = LobbyStateWirePayload;
type PrivateRoomStatePayload = PrivateRoomStateWirePayload;

export type PrivateRoomSettings = {
  questionMs: number;
  studyPhaseMs: number;
};

export type PrivateRoomState = {
  roomCode: string;
  hostParticipantId: string;
  mode: GameMode;
  subcategoryKey: string | null;
  lessonId: number | null;
  /** عند الدرس المخصص: حمولة جاهزة بدل القراءة من قاعدة البيانات */
  customLessonPlayback: LessonPlaybackPayload | null;
  customLessonToken: string | null;
  difficultyMode: DifficultyMode;
  settings: PrivateRoomSettings;
  /** مفتاح: participantId */
  members: Map<string, LobbyEntry>;
  lockedParticipantIds: string[];
  countdownEndsAt: number | null;
  matchStartTimer: ReturnType<typeof setTimeout> | null;
  roomVersion: number;
  teamPlayMode: PrivateRoomTeamPlayMode;
  heartsPerPlayer: PrivateRoomHeartsPerPlayer;
  /** غير null عند teamPlayMode !== "individual" */
  teamsLobby: PrivateRoomTeamsLobbyState | null;
  lastActivityAt: number;
  /** بعد انتهاء المباراة: نافذة بقاء قصيرة للغرفة حتى لو لم يبقَ أعضاء متصلون. */
  postMatchExpiresAt: number | null;
  /** true أثناء تشغيل مباراة انطلقت من هذه الغرفة (يمنع مسح الغرفة بالخطأ). */
  privateRoomMatchRunning: boolean;
};

/**
 * واجهة ضيّقة لمسجّل مقبس الغرفة الخاصة — تُمرَّر ككائن حرفي من attachSocket.
 * ملكية الحالة: GameManager يملك الخرائط والمؤقتات؛ منسّقو إعادة الربط/اللوبي يملكون المسارات المذكورة في تعليق رأس الصنف.
 */
export interface PrivateRoomGameManagerFacade {
  isDraining(): boolean;
  resolvePlayerSessionId(raw: unknown, socketId: string): string;
  allocateUniqueRoomCode(): string;
  leaveMatchForSocket(socketId: string): void;
  leaveLobbyEverywhere(socketId: string): void;
  removeFromPrivateRoom(socketId: string): void;
  readUserId(socket: Socket): string | null;
  privateRooms: Map<string, PrivateRoomState>;
  socketToPrivateRoomCode: Map<string, string>;
  socketToPrivateParticipantId: Map<string, string>;
  privateLobbyRoom(roomCode: string): string;
  emitPrivateLobbyState(roomCode: string): void;
  evictDuplicatePrivateMember(room: PrivateRoomState, incomingSocket: Socket, playerSessionId: string): void;
  io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, FahemSocketData>;
  tryStartPrivateRoom(roomCode: string): Promise<void>;
  isPrivateRoomHost(room: PrivateRoomState, participantId: string | undefined): boolean;
  shufflePrivateRoomTeams(room: PrivateRoomState): void;
  joinTeamForParticipant(
    room: PrivateRoomState,
    participantId: string,
    teamId: string,
  ): { ok: true } | { ok: false; error: string };
  leaveTeamForParticipant(
    room: PrivateRoomState,
    participantId: string,
  ): { ok: true } | { ok: false; error: string };
}

/**
 * ملكية الحالة: خرائط اللوبي العام، الغرف الخاصة، المباريات النشطة، ونوافذ إعادة الربط.
 * مسارات المقبس: منسِّق اللوبي (`LobbyCoordinator`)، الغرف الخاصة (`privateRoomSocketHandlers`)، إعادة الربط (`ReconnectCoordinator`).
 *
 * Phase E — عقود أحادية العقدة ودورة الحياة (وثائق فقط): راجع `docs/RUNTIME_SINGLE_NODE_CONTRACT.md` و`docs/RUNTIME_LIFECYCLE_SHUTDOWN.md` و`docs/RUNTIME_TIMER_OWNERSHIP.md`.
 */
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
  /** مقبس عام → مرجع اللوبي العام (مفتاح اللوبي = participantId). */
  private readonly socketToPublicLobbyRef = new Map<string, { mode: GameMode; participantId: string }>();
  /** مقبس → participantId داخل الغرفة الخاصة الحالية. */
  private readonly socketToPrivateParticipantId = new Map<string, string>();
  /** مقعد المباراة النشط ↔ المقبس الحالي (نقل؛ يُحدَّث عند reconnect لاحقًا). */
  private readonly socketToParticipantId = new Map<string, string>();
  private readonly participantIdToSocket = new Map<string, string>();
  private readonly participantIdToMatch = new Map<string, Match>();
  private readonly runningMatches = new Map<string, Match>();
  /** مهلة إقصاء المقعد بعد انقطاع النقل دون استئناف. */
  private readonly pendingReconnectByParticipantId = new Map<string, ReturnType<typeof setTimeout>>();
  /** حد معدل طلبات resume_match لكل مقبس (نافذة زمنية). */
  private readonly resumeMatchRateBySocketId = new Map<
    string,
    { count: number; windowStart: number }
  >();
  private readonly lockedParticipantIds: Record<GameMode, string[]> = {
    direct: [],
    study_then_quiz: [],
    lesson: [],
  };
  private readyOrderCounter = 0;
  private maxPlayersPerMatch = DEFAULT_MAX_PLAYERS_PER_MATCH;
  private matchFillWindowSeconds = DEFAULT_MATCH_FILL_WINDOW_SECONDS;
  private maxPlayersLoadedAtMs = 0;
  private fillWindowLoadedAtMs = 0;
  /** يمنع انضمامات جديدة أثناء تصريف العملية (SIGTERM). */
  private draining = false;
  /** وقت بدء التصريف — لحقل drainingSinceMs في لقطة الصحة. */
  private drainingBeganAt: number | null = null;
  private readonly runtimeStats = new InMemoryRuntimeStats();
  private privateRoomGcInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly io: Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, FahemSocketData>,
  ) {
    const idlePrivateRoomMs = 6 * 60 * 60 * 1000;
    this.privateRoomGcInterval = setInterval(() => {
      const now = Date.now();
      try {
        fahemStructuredLog("info", {
          cat: "private_room",
          event: "gc_tick_metrics",
          privateRooms: this.privateRooms.size,
          runningMatches: this.runningMatches.size,
        });
      } catch {
        /* ignore */
      }
      for (const [code, room] of [...this.privateRooms.entries()]) {
        if (room.members.size > 0) continue;
        if (room.matchStartTimer != null || room.privateRoomMatchRunning) continue;
        if (room.postMatchExpiresAt != null) {
          if (now < room.postMatchExpiresAt) continue;
          this.privateRooms.delete(code);
          continue;
        }
        if (now - room.lastActivityAt < idlePrivateRoomMs) continue;
        this.privateRooms.delete(code);
      }
    }, 12 * 60 * 1000);
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** يُستدعى من `index.ts` عند SIGTERM قبل إغلاق المقابس. */
  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.drainingBeganAt = Date.now();
    this.io.emit("server_draining", {
      serverNow: Date.now(),
      messageAr: "الخادم يُحدَّث أو يُغلق مؤقتًا. لن يُقبل انضمام جديد؛ المباريات النشطة ستُنهى.",
    });
  }

  stopPeriodicTasks(): void {
    if (this.privateRoomGcInterval != null) {
      clearInterval(this.privateRoomGcInterval);
      this.privateRoomGcInterval = null;
    }
  }

  /** إنهاء كل المباريات النشطة ومسح مؤقتات إعادة الربط وجداول الانطلاق. */
  abortAllMatchesForShutdown(): void {
    const matches = [...this.runningMatches.values()];
    for (const m of matches) {
      try {
        m.abortDueToServerShutdown();
      } catch (e) {
        console.error("[shutdown] abort_match_failed", e);
      }
      this.unregisterMatchRoutingForMatch(m);
    }
    this.runningMatches.clear();
    for (const [, t] of [...this.pendingReconnectByParticipantId.entries()]) {
      clearTimeout(t);
    }
    this.pendingReconnectByParticipantId.clear();
    for (const mode of ["direct", "study_then_quiz", "lesson"] as const) {
      const t = this.matchStartTimers[mode];
      if (t != null) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
      }
      this.countdownEndsAt[mode] = null;
      this.countdownGroup[mode] = null;
      this.lockedParticipantIds[mode] = [];
    }
    let privateRoomsCountdownCleared = 0;
    for (const [roomCode, room] of this.privateRooms.entries()) {
      let dirty = false;
      if (room.matchStartTimer != null) {
        clearTimeout(room.matchStartTimer);
        room.matchStartTimer = null;
        dirty = true;
      }
      if (room.countdownEndsAt != null) {
        room.countdownEndsAt = null;
        dirty = true;
      }
      if (room.lockedParticipantIds.length > 0) {
        room.lockedParticipantIds = [];
        dirty = true;
      }
      if (dirty) {
        privateRoomsCountdownCleared += 1;
        room.roomVersion += 1;
        this.emitPrivateLobbyState(roomCode);
      }
    }
    if (privateRoomsCountdownCleared > 0) {
      fahemStructuredLog("info", {
        cat: "shutdown",
        event: "private_room_countdown_cleared_shutdown",
        rooms: privateRoomsCountdownCleared,
      });
    }
  }

  getOperationalSnapshot(): {
    draining: boolean;
    drainingSinceMs: number | null;
    activeMatches: number;
    lobbyPlayersApprox: number;
    privateRooms: number;
    uptimeMs: number;
    connectedSocketsApprox: number;
    stats: ReturnType<InMemoryRuntimeStats["snapshot"]>;
  } {
    const lobbyPlayersApprox =
      this.lobbies.direct.size + this.lobbies.study_then_quiz.size + this.lobbies.lesson.size;
    const engine = this.io.engine as unknown as { clientsCount?: number };
    const connectedSocketsApprox =
      typeof engine.clientsCount === "number" && Number.isFinite(engine.clientsCount)
        ? engine.clientsCount
        : this.io.sockets?.sockets?.size ?? 0;
    return {
      draining: this.draining,
      drainingSinceMs:
        this.draining && this.drainingBeganAt != null ? Date.now() - this.drainingBeganAt : null,
      activeMatches: this.runningMatches.size,
      lobbyPlayersApprox,
      privateRooms: this.privateRooms.size,
      uptimeMs: Math.floor(process.uptime() * 1000),
      connectedSocketsApprox,
      stats: this.runtimeStats.snapshot(),
    };
  }

  private logReconnectEvent(payload: Record<string, unknown>): void {
    try {
      this.runtimeStats.recordReconnectPayload(payload);
      fahemStructuredLog("info", {
        ...payload,
        cat: "reconnect",
        event: typeof payload.event === "string" ? payload.event : "reconnect_event",
      });
    } catch {
      /* ignore */
    }
  }

  private checkResumeMatchRateLimit(socketId: string): boolean {
    const now = Date.now();
    const row = this.resumeMatchRateBySocketId.get(socketId);
    if (!row || now - row.windowStart > RESUME_MATCH_RATE_WINDOW_MS) {
      this.resumeMatchRateBySocketId.set(socketId, { count: 1, windowStart: now });
      return true;
    }
    if (row.count >= RESUME_MATCH_RATE_MAX) return false;
    row.count += 1;
    return true;
  }

  private clearResumeMatchRateLimit(socketId: string): void {
    this.resumeMatchRateBySocketId.delete(socketId);
  }

  private readUserId(socket: Socket): string | null {
    const u = (socket.data as FahemSocketData).auth?.userId;
    return typeof u === "string" && u.trim() ? u.trim() : null;
  }

  /** يُبقى fahemMatchId على المقبس بعد disconnect لتمكين continue_as_spectator حتى انتهاء المباراة. */
  private tagSocketMatchBinding(socketId: string, matchId: string): void {
    const s = this.io.sockets.sockets.get(socketId);
    if (s) (s.data as { fahemMatchId?: string }).fahemMatchId = matchId;
  }

  private clearSocketMatchBinding(socketId: string): void {
    const s = this.io.sockets.sockets.get(socketId);
    if (s) delete (s.data as { fahemMatchId?: string }).fahemMatchId;
  }

  /** مباراة نشطة لهذا المقبس: عبر تعيين المقعد أو وسم المباراة (مشاهد بعد انقطاع التعيين). */
  private getMatchForConnectedSocket(socketId: string): Match | undefined {
    const pid = this.socketToParticipantId.get(socketId);
    if (pid) {
      const m = this.participantIdToMatch.get(pid);
      if (m) return m;
    }
    const mid = (this.io.sockets.sockets.get(socketId)?.data as { fahemMatchId?: string } | undefined)
      ?.fahemMatchId;
    return mid ? this.runningMatches.get(mid) : undefined;
  }

  private resolvePlayerSessionId(raw: unknown, socketId: string): string {
    const authUserId = String((raw as { __authUserId?: unknown })?.__authUserId ?? "").trim();
    if (authUserId) return `uid:${authUserId}`;
    const value = String((raw as { playerSessionId?: unknown })?.playerSessionId ?? "").trim();
    if (value) return value.slice(0, 120);
    return `sid:${socketId}`;
  }

  private registerMatchRouting(seats: MatchSeatInput[], match: Match): void {
    for (const s of seats) {
      this.socketToParticipantId.set(s.connectionSocketId, s.participantId);
      this.participantIdToSocket.set(s.participantId, s.connectionSocketId);
      this.participantIdToMatch.set(s.participantId, match);
      this.tagSocketMatchBinding(s.connectionSocketId, match.matchId);
    }
  }

  private unregisterMatchRoutingForMatch(match: Match): void {
    for (const pid of match.getParticipantIds()) {
      this.clearPendingReconnect(pid);
      const sid = this.participantIdToSocket.get(pid);
      if (sid) {
        this.clearSocketMatchBinding(sid);
        this.socketToParticipantId.delete(sid);
      }
      this.participantIdToSocket.delete(pid);
      this.participantIdToMatch.delete(pid);
    }
  }

  private clearPendingReconnect(participantId: string, source?: string): void {
    const t = this.pendingReconnectByParticipantId.get(participantId);
    if (t) {
      clearTimeout(t);
      this.pendingReconnectByParticipantId.delete(participantId);
      if (source) {
        this.logReconnectEvent({ event: "grace_cleared", participantId, source });
      }
    }
  }

  /** يزيل ربط المقبس فقط ويؤجّل إقصاء المقعد حتى انتهاء نافذة الاستئناف. */
  private scheduleMatchDisconnectAfterGrace(
    participantId: string,
    disconnectedSocketId: string,
  ): void {
    this.clearPendingReconnect(participantId);
    this.socketToParticipantId.delete(disconnectedSocketId);
    this.participantIdToSocket.delete(participantId);
    const m0 = this.participantIdToMatch.get(participantId);
    this.logReconnectEvent({
      event: "grace_started",
      participantId,
      disconnectedSocketId,
      matchId: m0?.matchId,
      graceMs: MATCH_RECONNECT_GRACE_MS,
    });
    const timer = setTimeout(() => {
      this.pendingReconnectByParticipantId.delete(participantId);
      const m = this.participantIdToMatch.get(participantId);
      this.logReconnectEvent({
        event: "grace_expired_eliminate",
        participantId,
        matchId: m?.matchId,
        ranEliminate: Boolean(m && !m.isFinished()),
      });
      if (!m || m.isFinished()) return;
      m.handleDisconnect(participantId);
    }, MATCH_RECONNECT_GRACE_MS);
    this.pendingReconnectByParticipantId.set(participantId, timer);
  }

  private resolveParticipantIdForSocket(socketId: string): string | undefined {
    return this.socketToParticipantId.get(socketId);
  }

  private removeParticipantFromLockedGroup(mode: GameMode, participantId: string): void {
    const ids = this.lockedParticipantIds[mode];
    const idx = ids.indexOf(participantId);
    if (idx >= 0) ids.splice(idx, 1);
  }

  /** طرد مقبس آخر لنفس الحساب أو نفس الجلسة المنطقية داخل نفس سلة اللوبي. */
  private evictDuplicateLobbySocket(
    incomingSocket: Socket,
    playerSessionId: string,
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ): void {
    const incomingSocketId = incomingSocket.id;
    const incomingUserId = this.readUserId(incomingSocket);
    for (const [, e] of this.lobbies[mode]) {
      if (e.socketId === incomingSocketId) continue;
      const sameAccount =
        incomingUserId != null && e.userId != null && incomingUserId === e.userId;
      if (!sameAccount && e.playerSessionId !== playerSessionId) continue;
      if (e.difficultyMode !== difficultyMode) continue;
      if (mode === "study_then_quiz" && e.subcategoryKey !== (subcategoryKey ?? "general_default")) continue;
      if (mode === "lesson" && e.lessonId !== lessonId) continue;
      this.io.sockets.sockets.get(e.socketId)?.disconnect(true);
    }
  }

  /** طرد عضو آخر لنفس الحساب أو نفس الجلسة المنطقية داخل الغرفة الخاصة. */
  private evictDuplicatePrivateMember(room: PrivateRoomState, incomingSocket: Socket, playerSessionId: string): void {
    const incomingSocketId = incomingSocket.id;
    const incomingUserId = this.readUserId(incomingSocket);
    for (const [, m] of room.members) {
      if (m.socketId === incomingSocketId) continue;
      const sameAccount =
        incomingUserId != null && m.userId != null && incomingUserId === m.userId;
      if (!sameAccount && m.playerSessionId !== playerSessionId) continue;
      this.io.sockets.sockets.get(m.socketId)?.disconnect(true);
    }
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
    const players = [...this.lobbies[mode].values()]
      .filter(
        (p) =>
          p.difficultyMode === difficultyMode &&
          (mode !== "study_then_quiz" || p.subcategoryKey === (subcategoryKey ?? "general_default")) &&
          (mode !== "lesson" || p.lessonId === lessonId),
      )
      .map((p) => ({
        participantId: p.participantId,
        userId: p.userId,
        name: p.name,
        ready: p.ready,
        mode: p.mode,
        subcategoryKey: p.subcategoryKey,
        difficultyMode: p.difficultyMode,
      }));
    return buildPublicLobbyWirePayload({
      mode,
      players,
      lockedParticipantIds: [...this.lockedParticipantIds[mode]],
      maxPlayersPerMatch: this.maxPlayersPerMatch,
      matchStartTimerActive: Boolean(this.matchStartTimers[mode]),
      countdownEndsAt: this.countdownEndsAt[mode],
    });
  }

  private emitPrivateLobbyState(roomCode: string): void {
    const room = this.privateRooms.get(roomCode);
    if (!room) return;
    room.lastActivityAt = Date.now();
    if (room.members.size > 0) {
      room.postMatchExpiresAt = null;
    }
    const memberIds = new Set(room.members.keys());
    const teamsLobbyPayload =
      room.teamPlayMode !== "individual" && room.teamsLobby
        ? teamsLobbyToPayload(room.teamsLobby)
        : undefined;
    const unassignedIds =
      room.teamPlayMode !== "individual" && room.teamsLobby
        ? listUnassignedParticipantIds(memberIds, room.teamsLobby)
        : undefined;
    const lobbyPlayerRows = [...room.members.values()].map((p) => ({
      participantId: p.participantId,
      userId: p.userId,
      name: p.name,
      ready: p.ready,
      mode: p.mode,
      subcategoryKey: p.subcategoryKey,
      difficultyMode: p.difficultyMode,
    }));
    const privatePlayerRows = [...room.members.values()].map((p) => ({
      participantId: p.participantId,
      userId: p.userId,
      name: p.name,
      ready: p.ready,
    }));
    const { lobby: payload, privateRoom: privatePayload } = buildPrivateRoomWirePayloadPair({
      roomCode: room.roomCode,
      hostParticipantId: room.hostParticipantId,
      mode: room.mode,
      subcategoryKey: room.subcategoryKey,
      lessonId: room.lessonId,
      difficultyMode: room.difficultyMode,
      roomVersion: room.roomVersion,
      lobbyPlayerRows,
      privatePlayerRows,
      lockedParticipantIds: [...room.lockedParticipantIds],
      matchStartTimerActive: Boolean(room.matchStartTimer),
      countdownEndsAt: room.countdownEndsAt,
      roomSettings: {
        questionMs: room.settings.questionMs,
        studyPhaseMs: room.settings.studyPhaseMs,
      },
      teamPlayMode: room.teamPlayMode,
      heartsPerPlayer: room.heartsPerPlayer,
      teamsLobby: teamsLobbyPayload,
      unassignedParticipantIds: unassignedIds,
      maxPlayersForPrivateLobby: 100,
    });
    this.io.to(this.privateLobbyRoom(roomCode)).emit("lobby_state", payload);
    this.io.to(this.privateLobbyRoom(roomCode)).emit("private_room_state", privatePayload);
  }

  private isPrivateRoomHost(room: PrivateRoomState, participantId: string | undefined): boolean {
    return Boolean(participantId && room.hostParticipantId === participantId);
  }

  private removeParticipantFromAllTeamsInRoom(room: PrivateRoomState, participantId: string): void {
    if (!room.teamsLobby) return;
    for (const team of room.teamsLobby.teams.values()) {
      const idx = team.memberParticipantIds.indexOf(participantId);
      if (idx >= 0) {
        team.memberParticipantIds.splice(idx, 1);
        if (team.captainParticipantId === participantId) {
          team.captainParticipantId = team.memberParticipantIds[0] ?? "";
        }
      }
    }
  }

  private joinTeamForParticipant(
    room: PrivateRoomState,
    participantId: string,
    teamId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!room.teamsLobby) return { ok: false, error: Ack.teams_disabled };
    if (room.teamsLobby.teamsLocked) return { ok: false, error: Ack.teams_locked };
    const team = room.teamsLobby.teams.get(teamId);
    if (!team) return { ok: false, error: Ack.team_not_found };
    if (!room.members.has(participantId)) return { ok: false, error: Ack.not_member };
    this.removeParticipantFromAllTeamsInRoom(room, participantId);
    const becomesCaptain = team.memberParticipantIds.length === 0;
    team.memberParticipantIds.push(participantId);
    if (becomesCaptain) team.captainParticipantId = participantId;
    return { ok: true };
  }

  private leaveTeamForParticipant(
    room: PrivateRoomState,
    participantId: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!room.teamsLobby) return { ok: false, error: Ack.teams_disabled };
    if (room.teamsLobby.teamsLocked) return { ok: false, error: Ack.teams_locked };
    for (const team of room.teamsLobby.teams.values()) {
      const idx = team.memberParticipantIds.indexOf(participantId);
      if (idx >= 0) {
        team.memberParticipantIds.splice(idx, 1);
        if (team.captainParticipantId === participantId) {
          team.captainParticipantId = team.memberParticipantIds[0] ?? "";
        }
        return { ok: true };
      }
    }
    return { ok: false, error: Ack.not_in_team };
  }

  private shufflePrivateRoomTeams(room: PrivateRoomState): void {
    if (!room.teamsLobby) return;
    const all = [...room.members.keys()];
    for (const t of room.teamsLobby.teams.values()) {
      t.memberParticipantIds = [];
      t.captainParticipantId = "";
    }
    const teamList = [...room.teamsLobby.teams.values()].sort((a, b) => a.teamId.localeCompare(b.teamId));
    if (teamList.length === 0) return;
    for (let i = 0; i < all.length; i++) {
      const pid = all[i]!;
      const team = teamList[i % teamList.length]!;
      const first = team.memberParticipantIds.length === 0;
      team.memberParticipantIds.push(pid);
      if (first) team.captainParticipantId = pid;
    }
  }

  private asPrivateRoomFacade(): PrivateRoomGameManagerFacade {
    return {
      isDraining: () => this.isDraining(),
      resolvePlayerSessionId: (raw, sid) => this.resolvePlayerSessionId(raw, sid),
      allocateUniqueRoomCode: () => this.allocateUniqueRoomCode(),
      leaveMatchForSocket: (sid) => this.leaveMatchForSocket(sid),
      leaveLobbyEverywhere: (sid) => this.leaveLobbyEverywhere(sid),
      removeFromPrivateRoom: (sid) => this.removeFromPrivateRoom(sid),
      readUserId: (s) => this.readUserId(s),
      privateRooms: this.privateRooms,
      socketToPrivateRoomCode: this.socketToPrivateRoomCode,
      socketToPrivateParticipantId: this.socketToPrivateParticipantId,
      privateLobbyRoom: (code) => this.privateLobbyRoom(code),
      emitPrivateLobbyState: (code) => this.emitPrivateLobbyState(code),
      evictDuplicatePrivateMember: (room, incoming, psid) => this.evictDuplicatePrivateMember(room, incoming, psid),
      io: this.io,
      tryStartPrivateRoom: (code) => this.tryStartPrivateRoom(code),
      isPrivateRoomHost: (room, pid) => this.isPrivateRoomHost(room, pid),
      shufflePrivateRoomTeams: (room) => this.shufflePrivateRoomTeams(room),
      joinTeamForParticipant: (room, pid, tid) => this.joinTeamForParticipant(room, pid, tid),
      leaveTeamForParticipant: (room, pid) => this.leaveTeamForParticipant(room, pid),
    };
  }

  private createLobbySocketDeps(): LobbySocketDeps {
    return {
      isDraining: () => this.isDraining(),
      resolvePlayerSessionId: (raw, sid) => this.resolvePlayerSessionId(raw, sid),
      evictDuplicateLobbySocket: (incoming, psid, mode, sub, diff, lesson) =>
        this.evictDuplicateLobbySocket(incoming, psid, mode, sub, diff, lesson),
      leaveMatchForSocket: (sid) => this.leaveMatchForSocket(sid),
      leaveLobbyEverywhere: (sid) => this.leaveLobbyEverywhere(sid),
      removeFromPrivateRoom: (sid) => this.removeFromPrivateRoom(sid),
      readUserId: (s) => this.readUserId(s),
      takeNextReadyOrder: () => ++this.readyOrderCounter,
      setLobbyEntry: (mode, pid, entry) => {
        this.lobbies[mode].set(pid, entry);
      },
      setPublicLobbyRef: (socketId, ref) => {
        this.socketToPublicLobbyRef.set(socketId, ref);
      },
      joinLobbyRoom: async (socket, mode, sub, diff, lesson) => {
        await socket.join(this.lobbyRoom(mode, sub, diff, lesson));
      },
      broadcastLobby: (mode, sub, diff, lesson) => this.broadcastLobby(mode, sub, diff, lesson),
      buildLobbyPayload: (mode, sub, diff, lesson) => this.buildLobbyPayload(mode, sub, diff, lesson),
      emitLobbyStateToSocket: (socket, mode, sub, diff, lesson) => {
        socket.emit("lobby_state", this.buildLobbyPayload(mode, sub, diff, lesson));
      },
      enqueueScheduleMatchStart: (mode, sub, diff, lesson) =>
        this.enqueueScheduleMatchStart(mode, sub, diff, lesson),
      findLobbyEntry: (sid) => this.findLobbyEntry(sid),
    };
  }

  private createReconnectSocketDeps(): ReconnectSocketDeps {
    return {
      isDraining: () => this.isDraining(),
      logReconnectEvent: (p) => this.logReconnectEvent(p),
      checkResumeMatchRateLimit: (sid) => this.checkResumeMatchRateLimit(sid),
      clearPendingReconnect: (pid, src) => this.clearPendingReconnect(pid, src),
      getParticipantIdToSocket: () => this.participantIdToSocket,
      clearSocketMatchBinding: (sid) => this.clearSocketMatchBinding(sid),
      disconnectSocket: (sid) => {
        this.io.sockets.sockets.get(sid)?.disconnect(true);
      },
      tagSocketMatchBinding: (sid, mid) => this.tagSocketMatchBinding(sid, mid),
      setSocketToParticipant: (sid, pid) => this.socketToParticipantId.set(sid, pid),
      setParticipantToSocket: (pid, sid) => this.participantIdToSocket.set(pid, sid),
      setParticipantToMatch: (pid, m) => this.participantIdToMatch.set(pid, m),
      deleteSocketToParticipant: (sid) => this.socketToParticipantId.delete(sid),
      getRunningMatch: (mid) => this.runningMatches.get(mid),
      getParticipantIdToMatch: (pid) => this.participantIdToMatch.get(pid),
      getSocketToParticipant: (sid) => this.socketToParticipantId.get(sid),
      getSocketDataMatchId: (s) => (s.data as { fahemMatchId?: string }).fahemMatchId,
    };
  }

  attachSocket(
    socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, FahemSocketData>,
  ): void {
    const lobbyDeps = this.createLobbySocketDeps();
    const reconnectDeps = this.createReconnectSocketDeps();
    attachJoinLobbySocketHandler(lobbyDeps, socket);
    registerPrivateRoomSocketHandlers(this.asPrivateRoomFacade(), socket);

    socket.on("start_solo_match", async (raw, cb) => {
      if (this.draining) {
        cb?.({ ok: false, error: Ack.server_draining });
        return;
      }
      try {
        const parsed = joinLessonFlexibleSchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: Ack.invalid_name });
          return;
        }
        const { name, mode } = parsed.data;
        const playerSessionId = this.resolvePlayerSessionId(
          { ...(raw as Record<string, unknown>), __authUserId: socket.data?.auth?.userId },
          socket.id,
        );
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
                error: Ack.custom_lesson_expired,
                message: "انتهت صلاحية الدرس المخصص أو غير صالح.",
              });
              return;
            }
            lessonId = null;
          } else {
            if (lessonId == null || lessonId < 1) {
              cb?.({ ok: false, error: Ack.lesson_id_required, message: "معرّف الدرس مطلوب." });
              return;
            }
            lessonPlaybackForMatch = await getPublishedLessonPlaybackById(lessonId);
            if (!lessonPlaybackForMatch || lessonPlaybackForMatch.steps.length === 0) {
              cb?.({
                ok: false,
                error: Ack.lesson_not_found,
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
              error: Ack.not_enough_questions,
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

        const studyTimeOverrides =
          mode === "study_then_quiz"
            ? (await getStudyModeTimingOverridesBySubcategoryKey(
                getPool(),
                subcategoryKey ?? "general_default",
              )) ?? undefined
            : undefined;

        const soloParticipantId = randomUUID();
        const soloSeat: MatchSeatInput = {
          participantId: soloParticipantId,
          connectionSocketId: socket.id,
          name,
          playerSessionId,
          userId: this.readUserId(socket),
        };
        const match = new Match(
          this.io,
          matchId,
          [soloSeat],
          mode,
          mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
          difficultyMode,
          studyTimeOverrides,
          lessonPlaybackForMatch,
          null,
        );

        await socket.join(match.room);
        this.registerMatchRouting([soloSeat], match);
        this.runningMatches.set(matchId, match);
        this.runtimeStats.matchStarted();
        cb?.({ ok: true });

        void (async () => {
          try {
            await match.run();
          } catch (err) {
            this.runtimeStats.matchmakingSoloRunUnhandled += 1;
            fahemStructuredLog("error", {
              cat: "matchmaking",
              event: "solo_match_run_unhandled",
              matchId,
              err: err instanceof Error ? err.message : String(err),
            });
            match.abortDueToRuntimeFailure();
          } finally {
            const s = this.io.sockets.sockets.get(socket.id);
            if (s) {
              try {
                await Promise.resolve(s.leave(match.room));
              } catch {
                /* ignore */
              }
            }
            this.runningMatches.delete(matchId);
            this.unregisterMatchRoutingForMatch(match);
            this.runtimeStats.matchEnded();
          }
        })().catch((err) => {
          this.runtimeStats.matchmakingSoloOuterFatal += 1;
          fahemStructuredLog("error", {
            cat: "matchmaking",
            event: "solo_match_outer_fatal",
            matchId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      } catch {
        cb?.({ ok: false, error: Ack.server });
      }
    });

    attachPlayerReadySocketHandler(lobbyDeps, socket);

    socket.on("answer", (raw, cb) => {
      const match = this.getMatchForConnectedSocket(socket.id);
      const parsed = answerSchema.safeParse(raw);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !parsed.success || !participantId) {
        cb?.({ ok: false });
        return;
      }
      if (!match.canAcceptChoice(parsed.data.questionId, parsed.data.choiceIndex)) {
        cb?.({ ok: false });
        return;
      }
      match.recordAnswer(participantId, parsed.data.questionId, parsed.data.choiceIndex);
      cb?.({ ok: true });
    });

    socket.on("round_ready", (raw, cb) => {
      void ignoredClientBodySchema.safeParse(raw);
      const match = this.getMatchForConnectedSocket(socket.id);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !participantId) {
        cb?.({ ok: false });
        return;
      }
      match.markRoundReady(participantId);
      cb?.({ ok: true });
    });

    attachReconnectSocketHandlers(reconnectDeps, socket);

    socket.on("ability_skill_boost", (raw, cb) => {
      void ignoredClientBodySchema.safeParse(raw);
      const match = this.getMatchForConnectedSocket(socket.id);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !participantId) {
        cb?.({ ok: false, error: Ack.not_in_match });
        return;
      }
      const r = match.tryAbilitySkillBoost(participantId);
      cb?.(r);
    });

    socket.on("ability_skip_question", (raw, cb) => {
      void ignoredClientBodySchema.safeParse(raw);
      const match = this.getMatchForConnectedSocket(socket.id);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !participantId) {
        cb?.({ ok: false, error: Ack.not_in_match });
        return;
      }
      const r = match.tryAbilitySkipQuestion(participantId);
      cb?.(r);
    });

    socket.on("ability_heart_attack", (raw, cb) => {
      const match = this.getMatchForConnectedSocket(socket.id);
      const attackerPid = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !attackerPid) {
        cb?.({ ok: false, error: Ack.not_in_match });
        return;
      }
      const parsed = abilityHeartAttackSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const victimPid = parsed.data.targetParticipantId.trim();
      const r = match.tryAbilityHeartAttack(attackerPid, victimPid);
      cb?.(r);
    });

    socket.on("ability_reveal_keys", (raw, cb) => {
      void ignoredClientBodySchema.safeParse(raw);
      const match = this.getMatchForConnectedSocket(socket.id);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      if (!match || !participantId) {
        cb?.({ ok: false, error: Ack.not_in_match });
        return;
      }
      const r = match.tryAbilityRevealKeys(participantId);
      cb?.(r);
    });

    socket.on("disconnect", () => {
      this.clearResumeMatchRateLimit(socket.id);
      this.removeFromLobby(socket.id);
      this.removeFromPrivateRoom(socket.id);
      const participantId = this.resolveParticipantIdForSocket(socket.id);
      const match = this.getMatchForConnectedSocket(socket.id);
      if (match && participantId) {
        if (!match.isFinished()) {
          this.scheduleMatchDisconnectAfterGrace(participantId, socket.id);
          return;
        }
        this.clearPendingReconnect(participantId);
        this.socketToParticipantId.delete(socket.id);
        this.participantIdToSocket.delete(participantId);
        return;
      }
    });
  }

  private findLobbyEntry(socketId: string): LobbyEntry | undefined {
    const ref = this.socketToPublicLobbyRef.get(socketId);
    if (!ref) return undefined;
    return this.lobbies[ref.mode].get(ref.participantId);
  }

  private leaveLobbyEverywhere(socketId: string): void {
    const ref = this.socketToPublicLobbyRef.get(socketId);
    if (!ref) return;
    const prev = this.lobbies[ref.mode].get(ref.participantId);
    this.lobbies[ref.mode].delete(ref.participantId);
    this.socketToPublicLobbyRef.delete(socketId);
    this.removeParticipantFromLockedGroup(ref.mode, ref.participantId);
    void this.io.sockets.sockets.get(socketId)?.leave(
      this.lobbyRoom(ref.mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix", prev?.lessonId),
    );
    this.clearMatchStartTimerIfNeeded(ref.mode);
    this.broadcastLobby(ref.mode, prev?.subcategoryKey, prev?.difficultyMode ?? "mix", prev?.lessonId);
  }

  private removeFromLobby(socketId: string): void {
    const entry = this.findLobbyEntry(socketId);
    if (!entry) return;
    const ref = this.socketToPublicLobbyRef.get(socketId);
    this.lobbies[entry.mode].delete(entry.participantId);
    if (ref) this.socketToPublicLobbyRef.delete(socketId);
    this.removeParticipantFromLockedGroup(entry.mode, entry.participantId);
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
    const participantId = this.socketToPrivateParticipantId.get(socketId);
    this.socketToPrivateParticipantId.delete(socketId);
    const room = this.privateRooms.get(roomCode);
    if (!room) return;
    if (participantId) {
      this.removeParticipantFromAllTeamsInRoom(room, participantId);
      room.members.delete(participantId);
      const lpIdx = room.lockedParticipantIds.indexOf(participantId);
      if (lpIdx >= 0) room.lockedParticipantIds.splice(lpIdx, 1);
    }
    room.roomVersion += 1;
    void this.io.sockets.sockets.get(socketId)?.leave(this.privateLobbyRoom(roomCode));
    if (participantId && room.hostParticipantId === participantId) {
      const nextPid = room.members.keys().next().value as string | undefined;
      if (nextPid) {
        const nextEntry = room.members.get(nextPid);
        if (nextEntry) room.hostParticipantId = nextEntry.participantId;
        room.roomVersion += 1;
      } else {
        if (room.postMatchExpiresAt != null && Date.now() < room.postMatchExpiresAt) {
          return;
        }
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
    if (this.draining) return;
    const members = [...room.members.values()];
    if (members.length < 2) return;
    const allReady = members.every((m) => m.ready);
    if (!allReady) return;
    if (room.teamPlayMode !== "individual" && room.teamsLobby) {
      const ids = new Set(members.map((m) => m.participantId));
      if (!allRoomMembersAssignedToTeams(ids, room.teamsLobby)) return;
    }
    if (room.mode === "study_then_quiz") {
      const key = room.subcategoryKey ?? "general_default";
      const difficultyFilter = room.difficultyMode === "mix" ? null : room.difficultyMode;
      const total = await countQuestionsBySubcategory(getPool(), key, true, difficultyFilter);
      if (this.draining) return;
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
        if (this.draining) return;
        if (!lesson || lesson.steps.length === 0) {
          this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
            reason: "lesson_not_found",
            message: "الدرس غير متاح أو غير منشور.",
          });
          return;
        }
      }
    }
    if (this.draining) return;
    room.lockedParticipantIds = members.map((m) => m.participantId);
    room.countdownEndsAt = Date.now() + (this.matchFillWindowSeconds * 1000);
    room.roomVersion += 1;
    this.io.to(this.privateLobbyRoom(roomCode)).emit("match_starting", {
      seconds: Math.max(1, Math.ceil((room.countdownEndsAt - Date.now()) / 1000)),
      participantIds: room.lockedParticipantIds,
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
    if (this.draining) return;
    const participants = room.lockedParticipantIds
      .map((id) => room.members.get(id))
      .filter((p): p is LobbyEntry => Boolean(p))
      .filter((p) => Boolean(this.io.sockets.sockets.get(p.socketId)?.connected && p.ready));
    if (participants.length < 2) {
      room.lockedParticipantIds = [];
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
      room.lockedParticipantIds = [];
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      return;
    }
    if (room.teamPlayMode !== "individual" && !room.teamsLobby) {
      room.lockedParticipantIds = [];
      room.roomVersion += 1;
      this.emitPrivateLobbyState(roomCode);
      this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
        reason: "teams_lobby_missing",
        message: "وضع الفرق غير مكتمل. اضبط الفرق من اللوبي ثم أعد المحاولة.",
      });
      return;
    }
    if (room.teamPlayMode !== "individual" && room.teamsLobby) {
      const snaps = nonEmptyTeamSnapshots(room.teamsLobby);
      if (snaps.length < 2) {
        room.lockedParticipantIds = [];
        room.roomVersion += 1;
        this.emitPrivateLobbyState(roomCode);
        this.io.to(this.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
          reason: "not_enough_teams",
          message: "يجب أن يكون هناك فريقان على الأقل بأعضاء لبدء وضع الفرق.",
        });
        return;
      }
    }
    const participantToTeam = new Map<string, { teamId: string; isCaptain: boolean }>();
    if (room.teamPlayMode !== "individual" && room.teamsLobby) {
      for (const snap of nonEmptyTeamSnapshots(room.teamsLobby)) {
        for (const pid of snap.memberParticipantIds) {
          participantToTeam.set(pid, {
            teamId: snap.teamId,
            isCaptain: snap.captainParticipantId === pid,
          });
        }
      }
    }
    const matchSeats: MatchSeatInput[] = participants.map((p) => {
      const tr = participantToTeam.get(p.participantId);
      return {
        participantId: p.participantId,
        connectionSocketId: p.socketId,
        name: p.name,
        playerSessionId: p.playerSessionId,
        userId: p.userId,
        teamId: tr?.teamId ?? null,
        isCaptain: tr?.isCaptain ?? false,
      };
    });
    let teamsStart: MatchPrivateTeamsStartConfig | null = null;
    if (room.teamPlayMode !== "individual" && room.teamsLobby) {
      teamsStart = {
        teamPlayMode: room.teamPlayMode,
        teams: nonEmptyTeamSnapshots(room.teamsLobby),
        heartsPerPlayer: room.heartsPerPlayer,
      };
    }
    const privateRuntime: MatchPrivateRuntimeOptions = {
      teamPlayMode: room.teamPlayMode,
      heartsPerPlayer: room.heartsPerPlayer,
      teams: teamsStart,
    };
    const match = new Match(
      this.io,
      matchId,
      matchSeats,
      room.mode,
      room.mode === "study_then_quiz" ? (room.subcategoryKey ?? "general_default") : null,
      room.difficultyMode,
      {
        questionMsOverride: room.settings.questionMs,
        studyPhaseMsOverride: room.settings.studyPhaseMs,
      },
      lessonPlayback,
      privateRuntime,
    );
    await Promise.all(participants.map(async (p) => {
      room.members.delete(p.participantId);
      this.socketToPrivateRoomCode.delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.privateLobbyRoom(roomCode));
        await s.join(match.room);
      }
    }));
    this.registerMatchRouting(matchSeats, match);
    room.lockedParticipantIds = [];
    room.roomVersion += 1;
    this.runningMatches.set(matchId, match);
    this.runtimeStats.matchStarted();
    room.privateRoomMatchRunning = true;
    room.postMatchExpiresAt = null;
    this.emitPrivateLobbyState(roomCode);
    try {
      await match.run();
    } catch (err) {
      this.runtimeStats.matchmakingPrivateRoomRunUnhandled += 1;
      fahemStructuredLog("error", {
        cat: "matchmaking",
        event: "private_room_match_run_unhandled",
        matchId,
        roomCode,
        err: err instanceof Error ? err.message : String(err),
      });
      match.abortDueToRuntimeFailure();
    } finally {
      const postMatchKeepAliveMs = 5 * 60 * 1000;
      room.privateRoomMatchRunning = false;
      for (const p of participants) {
        const s = this.io.sockets.sockets.get(p.socketId);
        if (s) {
          try {
            await Promise.resolve(s.leave(match.room));
          } catch {
            /* ignore */
          }
          if (s.connected && this.privateRooms.has(roomCode)) {
            const restoredEntry: LobbyEntry = {
              participantId: p.participantId,
              socketId: p.socketId,
              userId: p.userId,
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
            room.members.set(p.participantId, restoredEntry);
            this.socketToPrivateRoomCode.set(p.socketId, roomCode);
            this.socketToPrivateParticipantId.set(p.socketId, p.participantId);
            try {
              await Promise.resolve(s.join(this.privateLobbyRoom(roomCode)));
            } catch {
              /* ignore */
            }
          }
        }
      }
      room.lockedParticipantIds = [];
      room.countdownEndsAt = null;
      this.runningMatches.delete(matchId);
      this.unregisterMatchRoutingForMatch(match);
      this.runtimeStats.matchEnded();
      if (![...room.members.values()].some((m) => m.participantId === room.hostParticipantId)) {
        const nextPid = room.members.keys().next().value as string | undefined;
        if (nextPid) {
          const nextEntry = room.members.get(nextPid);
          if (nextEntry) room.hostParticipantId = nextEntry.participantId;
        } else {
          room.postMatchExpiresAt = Date.now() + postMatchKeepAliveMs;
          room.lastActivityAt = Date.now();
          room.roomVersion += 1;
          return;
        }
      }
      room.roomVersion += 1;
      room.postMatchExpiresAt = room.members.size === 0 ? Date.now() + postMatchKeepAliveMs : null;
      this.emitPrivateLobbyState(roomCode);
    }
  }

  private leaveMatchForSocket(socketId: string): void {
    const m = this.getMatchForConnectedSocket(socketId);
    if (!m) return;
    const participantId = this.resolveParticipantIdForSocket(socketId);
    if (participantId) {
      this.clearPendingReconnect(participantId);
      m.handleDisconnect(participantId);
      this.participantIdToSocket.delete(participantId);
    }
    this.socketToParticipantId.delete(socketId);
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
        `SELECT value FROM public.app_settings WHERE key = 'max_players_per_match' LIMIT 1`,
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
        `SELECT value FROM public.app_settings WHERE key = 'match_fill_window_seconds' LIMIT 1`,
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
      this.lockedParticipantIds[mode].length > 0
        ? this.lockedParticipantIds[mode].length
        : this.readyPlayers(mode, sub, diff, lessonId).length;
    if (effectiveReadyCount < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
        this.countdownEndsAt[mode] = null;
        this.countdownGroup[mode] = null;
        this.lockedParticipantIds[mode] = [];
        this.io.to(this.lobbyRoom(mode, sub ?? undefined, diff, lessonId)).emit("match_start_cancelled", {
          reason: "not_enough_ready",
        });
        if (!this.draining && this.readyPlayers(mode, sub, diff, lessonId).length >= 2) {
          this.enqueueScheduleMatchStart(mode, sub, diff, lessonId);
        }
      }
    }
  }

  private emitMatchStarting(
    mode: GameMode,
    lockedParticipantIds: string[],
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
      participantIds: lockedParticipantIds,
      maxPlayersPerMatch: maxPlayers,
      lockedCount: lockedParticipantIds.length,
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
    if (this.draining) return;
    const picked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode, lessonId).slice(0, maxPlayers);
    const lockedParticipantIds = picked.map((p) => p.participantId);
    if (lockedParticipantIds.length < 2) {
      const t = this.matchStartTimers[mode];
      if (t) {
        clearTimeout(t);
        this.matchStartTimers[mode] = null;
      }
      this.countdownEndsAt[mode] = null;
      this.countdownGroup[mode] = null;
      this.lockedParticipantIds[mode] = [];
      this.io.to(this.lobbyRoom(mode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);
      if (!this.draining && this.readyPlayers(mode, subcategoryKey, difficultyMode, lessonId).length >= 2) {
        this.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode, lessonId);
      }
      return;
    }
    if (this.draining) return;
    this.lockedParticipantIds[mode] = lockedParticipantIds;
    this.emitMatchStarting(mode, lockedParticipantIds, maxPlayers, subcategoryKey, difficultyMode, lessonId);
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
        if (this.draining) return;
      }
      return;
    }

    const maxPlayers = await this.loadMaxPlayersPerMatch();
    if (this.draining) return;
    const fillSeconds = await this.loadMatchFillWindowSeconds();
    if (this.draining) return;
    const fillMs = fillSeconds * 1000;
    const picked = this.sortedReadyPlayers(mode, subcategoryKey, difficultyMode, lessonId).slice(0, maxPlayers);
    const lockedParticipantIds = picked.map((p) => p.participantId);
    if (lockedParticipantIds.length < 2) return;

    if (this.matchStartTimers[mode]) {
      await this.updateRosterDuringCountdown(mode, subcategoryKey, difficultyMode, lessonId);
      if (this.draining) return;
      return;
    }

    if (this.draining) return;

    this.lockedParticipantIds[mode] = lockedParticipantIds;
    this.countdownEndsAt[mode] = Date.now() + fillMs;
    this.countdownGroup[mode] = {
      subcategoryKey: mode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
      difficultyMode,
      lessonId: mode === "lesson" ? lessonId ?? null : null,
    };
    this.emitMatchStarting(mode, lockedParticipantIds, maxPlayers, subcategoryKey, difficultyMode, lessonId);
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
    if (this.draining) return;
    const startedAt = Date.now();
    const lockedIds = this.lockedParticipantIds[gameMode];
    const participants = lockedIds
      .map((participantId) => this.lobbies[gameMode].get(participantId))
      .filter((p): p is LobbyEntry => Boolean(p))
      .filter((p) => {
        const s = this.io.sockets.sockets.get(p.socketId);
        return Boolean(s?.connected && p.ready);
      });
    if (participants.length < 2) {
      this.lockedParticipantIds[gameMode] = [];
      this.io.to(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId)).emit("match_start_cancelled", {
        reason: "not_enough_ready",
      });
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
      if (!this.draining && this.readyPlayers(gameMode, subcategoryKey, difficultyMode, lessonId).length >= 2) {
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
    if (this.draining) {
      this.lockedParticipantIds[gameMode] = [];
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
      return;
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
    if (this.draining) {
      this.lockedParticipantIds[gameMode] = [];
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
      return;
    }
    this.lockedParticipantIds[gameMode] = [];
    const matchId = randomUUID();

    const lobbyStudyOverrides =
      gameMode === "study_then_quiz"
        ? (await getStudyModeTimingOverridesBySubcategoryKey(
            getPool(),
            subcategoryKey ?? "general_default",
          )) ?? undefined
        : undefined;

    if (this.draining) {
      this.lockedParticipantIds[gameMode] = [];
      this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);
      return;
    }

    const matchSeats: MatchSeatInput[] = participants.map((p) => ({
      participantId: p.participantId,
      connectionSocketId: p.socketId,
      name: p.name,
      playerSessionId: p.playerSessionId,
      userId: p.userId,
    }));
    const match = new Match(
      this.io,
      matchId,
      matchSeats,
      gameMode,
      gameMode === "study_then_quiz" ? (subcategoryKey ?? "general_default") : null,
      difficultyMode,
      lobbyStudyOverrides,
      lessonPlaybackForLobby,
      null,
    );

    await Promise.all(participants.map(async (p) => {
      this.lobbies[gameMode].delete(p.participantId);
      this.socketToPublicLobbyRef.delete(p.socketId);
      const s = this.io.sockets.sockets.get(p.socketId);
      if (s) {
        await s.leave(this.lobbyRoom(gameMode, subcategoryKey, difficultyMode, lessonId));
        await s.join(match.room);
      }
    }));
    this.registerMatchRouting(matchSeats, match);
    const roomsReadyMs = Date.now() - startedAt;
    if (isFahemDebugRealtime()) {
      fahemStructuredLog("info", {
        cat: "matchmaking",
        event: "lobby_to_match_rooms_ms",
        roomsReadyMs,
        mode: gameMode,
        participants: participants.length,
      });
    }

    this.runningMatches.set(matchId, match);
    this.runtimeStats.matchStarted();
    this.broadcastLobby(gameMode, subcategoryKey, difficultyMode, lessonId);

    try {
      await match.run();
    } catch (err) {
      this.runtimeStats.matchmakingLobbyRunUnhandled += 1;
      fahemStructuredLog("error", {
        cat: "matchmaking",
        event: "lobby_match_run_unhandled",
        matchId,
        mode: gameMode,
        err: err instanceof Error ? err.message : String(err),
      });
      match.abortDueToRuntimeFailure();
    } finally {
      for (const p of participants) {
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
      this.unregisterMatchRoutingForMatch(match);
      this.runtimeStats.matchEnded();
    }
  }
}
