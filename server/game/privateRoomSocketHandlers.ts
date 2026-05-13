import type { Socket } from "socket.io";
import { randomUUID } from "crypto";
import { z } from "zod";
import { getPool } from "../db/pool";
import { getPublishedLessonPlaybackById, type LessonPlaybackPayload } from "../db/lessons";
import { getCustomLessonPlayback } from "../customLessonSessions";
import { countQuestionsBySubcategory, getStudyModeTimingOverridesBySubcategoryKey } from "../db/questions";
import { Match } from "./Match";
import type {
  MatchPrivateRuntimeOptions,
  MatchPrivateTeamsStartConfig,
  PrivateRoomHeartsPerPlayer,
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
import { Ack } from "../../shared/socketAckErrorCodes";
import { joinLessonFlexibleSchema } from "./socketSchemas";
import type {
  LobbyEntry,
  PrivateRoomGameManagerFacade,
  PrivateRoomSettings,
  PrivateRoomState,
} from "./GameManager";

const teamPlayModeSchema = z.enum(["individual", "teams_first_answer", "teams_captain_approval"]);
const privateRoomJoinTeamSchema = z.object({ teamId: z.string().uuid() });
const privateRoomUpdateTeamNameSchema = z.object({
  teamId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(48),
});
const privateRoomLockTeamsSchema = z.object({ locked: z.boolean() });
const privateRoomSetCaptainSchema = z.object({
  teamId: z.string().uuid(),
  captainParticipantId: z.string().uuid(),
});
const privateRoomSetHeartsSchema = z.object({
  heartsPerPlayer: z.number().int().min(0).max(5),
});
const privateRoomSetPlayModeSchema = z.object({ playMode: teamPlayModeSchema });
const privateRoomSetDesiredTeamCountSchema = z.object({
  desiredTeamCount: z.number().int().min(2).max(12),
});
const privateRoomRemoveTeamSchema = z.object({ teamId: z.string().uuid() });

export function registerPrivateRoomSocketHandlers(
  gameManager: PrivateRoomGameManagerFacade,
  socket: Socket,
): void {
  const g = gameManager;

    socket.on("create_private_room", async (raw, cb) => {
      try {
        if (typeof g.isDraining === "function" && g.isDraining()) {
          cb?.({ ok: false, error: Ack.server_draining });
          return;
        }
        const parsed = joinLessonFlexibleSchema.safeParse(raw);
        if (!parsed.success) {
          cb?.({ ok: false, error: Ack.invalid_body });
          return;
        }
        const d = parsed.data;
        const playerSessionId = g.resolvePlayerSessionId(
          { ...(raw as Record<string, unknown>), __authUserId: socket.data?.auth?.userId },
          socket.id,
        );
        const roomCode = g.allocateUniqueRoomCode();
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
                error: Ack.custom_lesson_expired,
                message: "انتهت صلاحية الدرس المخصص أو غير صالح. أعد التحقق من JSON ثم أنشئ جلسة جديدة.",
              });
              return;
            }
            lessonId = null;
          } else if (lessonId == null || lessonId < 1) {
            cb?.({ ok: false, error: Ack.lesson_id_required, message: "اختر درساً صالحاً." });
            return;
          }
        }
        const timingDefaults = await fetchGameTimingFromAppSettings(getPool());
        const rawBody = raw as Record<string, unknown>;
        const hasQuestionMs =
          rawBody != null &&
          typeof rawBody === "object" &&
          "questionMs" in rawBody &&
          rawBody.questionMs !== undefined &&
          rawBody.questionMs !== null;
        const hasStudyPhaseMs =
          rawBody != null &&
          typeof rawBody === "object" &&
          "studyPhaseMs" in rawBody &&
          rawBody.studyPhaseMs !== undefined &&
          rawBody.studyPhaseMs !== null;
        const questionMsRaw = hasQuestionMs ? Number(rawBody.questionMs) : timingDefaults.questionMs;
        const studyPhaseMsRaw = hasStudyPhaseMs ? Number(rawBody.studyPhaseMs) : timingDefaults.studyPhaseMs;
        const settings: PrivateRoomSettings = {
          questionMs: clampGameQuestionMs(
            Number.isFinite(questionMsRaw) ? questionMsRaw : timingDefaults.questionMs,
          ),
          studyPhaseMs: clampGameStudyPhaseMs(
            Number.isFinite(studyPhaseMsRaw) ? studyPhaseMsRaw : timingDefaults.studyPhaseMs,
          ),
        };
        if (mode === "study_then_quiz" && subcategoryKey) {
          const subOv = await getStudyModeTimingOverridesBySubcategoryKey(getPool(), subcategoryKey);
          if (subOv?.questionMsOverride != null) settings.questionMs = subOv.questionMsOverride;
          if (subOv?.studyPhaseMsOverride != null) settings.studyPhaseMs = subOv.studyPhaseMsOverride;
        }
        g.leaveMatchForSocket(socket.id);
        g.leaveLobbyEverywhere(socket.id);
        g.removeFromPrivateRoom(socket.id);
        const participantId = randomUUID();
        const userId = g.readUserId(socket);
        const entry: LobbyEntry = {
          participantId,
          socketId: socket.id,
          userId,
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
          hostParticipantId: participantId,
          mode,
          subcategoryKey,
          lessonId,
          customLessonPlayback,
          customLessonToken: tokenRaw || null,
          difficultyMode: d.difficultyMode ?? "mix",
          settings,
          members: new Map([[participantId, entry]]),
          lockedParticipantIds: [],
          countdownEndsAt: null,
          matchStartTimer: null,
          roomVersion: 1,
          teamPlayMode: "individual",
          heartsPerPlayer: 3,
          teamsLobby: null,
          lastActivityAt: Date.now(),
          postMatchExpiresAt: null,
          privateRoomMatchRunning: false,
        };
        g.privateRooms.set(roomCode, room);
        g.socketToPrivateRoomCode.set(socket.id, roomCode);
        g.socketToPrivateParticipantId.set(socket.id, participantId);
        await socket.join(g.privateLobbyRoom(roomCode));
        g.emitPrivateLobbyState(roomCode);
        const origin = String((raw as { origin?: unknown }).origin ?? "").trim();
        const inviteUrl = origin ? `${origin}?room=${roomCode}` : `?room=${roomCode}`;
        cb?.({
          ok: true,
          participantId,
          roomCode,
          inviteUrl,
          hostParticipantId: participantId,
          mode,
          subcategoryKey,
          lessonId: room.lessonId,
          difficultyMode: d.difficultyMode ?? "mix",
          roomSettings: settings,
          roomVersion: room.roomVersion,
        });
      } catch {
        cb?.({ ok: false, error: Ack.server });
      }
    });

    socket.on("join_private_room", async (raw, cb) => {
      try {
        if (typeof g.isDraining === "function" && g.isDraining()) {
          cb?.({ ok: false, error: Ack.server_draining });
          return;
        }
        const name = String((raw as { name?: unknown }).name ?? "").trim();
        const playerSessionId = g.resolvePlayerSessionId(
          { ...(raw as Record<string, unknown>), __authUserId: socket.data?.auth?.userId },
          socket.id,
        );
        const roomCode = String((raw as { roomCode?: unknown }).roomCode ?? "").trim().toUpperCase();
        if (!name || !roomCode) {
          cb?.({ ok: false, error: Ack.invalid_body });
          return;
        }
        const room = g.privateRooms.get(roomCode);
        if (!room) {
          cb?.({ ok: false, error: Ack.room_not_found, message: "الغرفة غير موجودة." });
          return;
        }
        if (room.matchStartTimer) {
          cb?.({
            ok: false,
            error: Ack.countdown_started,
            message: "بدأ العد التنازلي بالفعل. انتظر الجولة التالية ثم انضم.",
          });
          return;
        }
        if (
          room.members.size === 0 &&
          room.matchStartTimer == null &&
          !room.privateRoomMatchRunning &&
          typeof room.postMatchExpiresAt === "number" &&
          Date.now() >= room.postMatchExpiresAt
        ) {
          g.privateRooms.delete(roomCode);
          cb?.({ ok: false, error: Ack.room_not_found, message: "انتهت صلاحية الغرفة الخاصة." });
          return;
        }
        g.evictDuplicatePrivateMember(room, socket, playerSessionId);
        g.leaveMatchForSocket(socket.id);
        g.leaveLobbyEverywhere(socket.id);
        g.removeFromPrivateRoom(socket.id);
        const participantId = randomUUID();
        const userId = g.readUserId(socket);
        const entry: LobbyEntry = {
          participantId,
          socketId: socket.id,
          userId,
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
        room.members.set(participantId, entry);
        if (room.members.size === 1) {
          room.hostParticipantId = participantId;
        }
        room.postMatchExpiresAt = null;
        room.roomVersion += 1;
        g.socketToPrivateRoomCode.set(socket.id, roomCode);
        g.socketToPrivateParticipantId.set(socket.id, participantId);
        await socket.join(g.privateLobbyRoom(roomCode));
        g.emitPrivateLobbyState(roomCode);
        cb?.({
          ok: true,
          participantId,
          roomCode,
          hostParticipantId: room.hostParticipantId,
          mode: room.mode,
          subcategoryKey: room.subcategoryKey,
          lessonId: room.lessonId,
          difficultyMode: room.difficultyMode,
          roomSettings: room.settings,
          roomVersion: room.roomVersion,
        });
      } catch {
        cb?.({ ok: false, error: Ack.server });
      }
    });

    socket.on("private_room_update_settings", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      if (!roomCode) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      const room = g.privateRooms.get(roomCode);
      if (!room) {
        cb?.({ ok: false, error: Ack.room_not_found });
        return;
      }
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const hostEntry = myPid ? room.members.get(myPid) : undefined;
      if (!hostEntry || hostEntry.participantId !== room.hostParticipantId) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const qRaw = Number((raw as { questionMs?: unknown }).questionMs ?? room.settings.questionMs);
      const sRaw = Number((raw as { studyPhaseMs?: unknown }).studyPhaseMs ?? room.settings.studyPhaseMs);
      room.settings.questionMs = Math.min(120_000, Math.max(5_000, Number.isFinite(qRaw) ? qRaw : room.settings.questionMs));
      room.settings.studyPhaseMs = Math.min(300_000, Math.max(10_000, Number.isFinite(sRaw) ? sRaw : room.settings.studyPhaseMs));
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode);
      cb?.({ ok: true, roomSettings: room.settings, roomVersion: room.roomVersion });
    });

    socket.on("private_room_set_ready", async (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      if (!roomCode) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      const room = g.privateRooms.get(roomCode);
      if (!room) {
        cb?.({ ok: false, error: Ack.room_not_found });
        return;
      }
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const entry = myPid ? room.members.get(myPid) : undefined;
      if (!entry) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      if (typeof g.isDraining === "function" && g.isDraining()) {
        cb?.({ ok: false, error: Ack.server_draining });
        return;
      }
      const ready = Boolean((raw as { ready?: unknown }).ready);
      entry.ready = ready;
      if (room.matchStartTimer && ![...room.members.values()].every((m) => m.ready)) {
        clearTimeout(room.matchStartTimer);
        room.matchStartTimer = null;
        room.countdownEndsAt = null;
        room.lockedParticipantIds = [];
        g.io.to(g.privateLobbyRoom(roomCode)).emit("match_start_cancelled", {
          reason: "not_all_ready",
          message: "تم إلغاء البدء لأن أحد اللاعبين ألغى الجاهزية.",
        });
      }
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode);
      cb?.({ ok: true, ready, roomVersion: room.roomVersion });
      await g.tryStartPrivateRoom(roomCode);
    });

    socket.on("private_room_admin_set_play_mode", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid)) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomSetPlayModeSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const mode = parsed.data.playMode;
      room.teamPlayMode = mode;
      if (mode === "individual") {
        room.teamsLobby = null;
      } else {
        room.teamsLobby = createEmptyTeamsLobbyState(room.teamsLobby?.desiredTeamCount ?? 2);
      }
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion, teamPlayMode: room.teamPlayMode });
    });

    socket.on("private_room_admin_set_hearts", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid)) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomSetHeartsSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      room.heartsPerPlayer = parsed.data.heartsPerPlayer as PrivateRoomHeartsPerPlayer;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion, heartsPerPlayer: room.heartsPerPlayer });
    });

    socket.on("private_room_admin_set_desired_team_count", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomSetDesiredTeamCountSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const target = clampDesiredTeamCount(parsed.data.desiredTeamCount);
      const teams = room.teamsLobby.teams;
      while (teams.size < target) {
        const teamId = randomUUID();
        teams.set(teamId, {
          teamId,
          displayName: defaultTeamDisplayName(teams.size),
          memberParticipantIds: [],
          captainParticipantId: "",
        });
      }
      while (teams.size > target) {
        const last = [...teams.keys()].pop();
        if (!last) break;
        const t = teams.get(last);
        if (t && t.memberParticipantIds.length > 0) {
          cb?.({ ok: false, error: Ack.non_empty_team, message: "أفرغ الفرق الزائدة يدوياً قبل تقليل العدد." });
          return;
        }
        teams.delete(last);
      }
      room.teamsLobby.desiredTeamCount = target;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_admin_add_team", (_raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      if (room.teamsLobby.teams.size >= 12) {
        cb?.({ ok: false, error: Ack.max_teams });
        return;
      }
      const teamId = randomUUID();
      room.teamsLobby.teams.set(teamId, {
        teamId,
        displayName: defaultTeamDisplayName(room.teamsLobby.teams.size),
        memberParticipantIds: [],
        captainParticipantId: "",
      });
      room.teamsLobby.desiredTeamCount = room.teamsLobby.teams.size;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_admin_remove_team", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomRemoveTeamSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      if (room.teamsLobby.teams.size <= 2) {
        cb?.({ ok: false, error: Ack.min_teams });
        return;
      }
      const t = room.teamsLobby.teams.get(parsed.data.teamId);
      if (!t) {
        cb?.({ ok: false, error: Ack.team_not_found });
        return;
      }
      if (t.memberParticipantIds.length > 0) {
        cb?.({ ok: false, error: Ack.team_not_empty });
        return;
      }
      room.teamsLobby.teams.delete(parsed.data.teamId);
      room.teamsLobby.desiredTeamCount = room.teamsLobby.teams.size;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_admin_shuffle_teams", (_raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      g.shufflePrivateRoomTeams(room);
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_admin_lock_teams", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomLockTeamsSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      room.teamsLobby.teamsLocked = parsed.data.locked;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion, teamsLocked: room.teamsLobby.teamsLocked });
    });

    socket.on("private_room_admin_set_captain", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !g.isPrivateRoomHost(room, myPid) || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomSetCaptainSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const team = room.teamsLobby.teams.get(parsed.data.teamId);
      if (!team || !team.memberParticipantIds.includes(parsed.data.captainParticipantId)) {
        cb?.({ ok: false, error: Ack.invalid_captain });
        return;
      }
      team.captainParticipantId = parsed.data.captainParticipantId;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_join_team", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !myPid) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomJoinTeamSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const r = g.joinTeamForParticipant(room, myPid, parsed.data.teamId);
      if (!r.ok) {
        cb?.({ ok: false, error: r.error });
        return;
      }
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_leave_team", (_raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !myPid) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const r = g.leaveTeamForParticipant(room, myPid);
      if (!r.ok) {
        cb?.({ ok: false, error: r.error });
        return;
      }
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

    socket.on("private_room_update_team_name", (raw, cb) => {
      const roomCode = g.socketToPrivateRoomCode.get(socket.id);
      const myPid = g.socketToPrivateParticipantId.get(socket.id);
      const room = roomCode ? g.privateRooms.get(roomCode) : undefined;
      if (!room || !myPid || !room.teamsLobby) {
        cb?.({ ok: false, error: Ack.not_in_private_room });
        return;
      }
      if (room.matchStartTimer) {
        cb?.({ ok: false, error: Ack.countdown_started });
        return;
      }
      const parsed = privateRoomUpdateTeamNameSchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const team = room.teamsLobby.teams.get(parsed.data.teamId);
      if (!team || team.captainParticipantId !== myPid) {
        cb?.({ ok: false, error: Ack.forbidden });
        return;
      }
      team.displayName = parsed.data.displayName;
      room.roomVersion += 1;
      g.emitPrivateLobbyState(roomCode!);
      cb?.({ ok: true, roomVersion: room.roomVersion });
    });

}
