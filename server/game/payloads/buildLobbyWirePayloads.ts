import type { LobbyStateWirePayload, PrivateRoomStateWirePayload } from "../../../shared/lobbyStateWire";
import type { GameMode, DifficultyMode } from "../Match";
import type {
  PrivateRoomHeartsPerPlayer,
  PrivateRoomTeamPlayMode,
  PrivateRoomTeamsLobbyPayload,
} from "../privateRoomTeamTypes";

export function countdownSecondsRemainingFrom(
  isStarting: boolean,
  countdownEndsAt: number | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (!isStarting || countdownEndsAt == null) return undefined;
  return Math.max(1, Math.ceil((countdownEndsAt - nowMs) / 1000));
}

type LobbyWirePlayerRow = LobbyStateWirePayload["players"][number];

export function buildPublicLobbyWirePayload(args: {
  mode: GameMode;
  players: LobbyWirePlayerRow[];
  lockedParticipantIds: string[];
  maxPlayersPerMatch: number;
  matchStartTimerActive: boolean;
  countdownEndsAt: number | null;
  /** للاختبارات فقط — افتراضياً `Date.now()`. */
  nowMs?: number;
}): LobbyStateWirePayload {
  return {
    mode: args.mode,
    players: args.players,
    isStarting: args.matchStartTimerActive,
    participantIds: args.lockedParticipantIds,
    maxPlayersPerMatch: args.maxPlayersPerMatch,
    countdownSecondsRemaining: countdownSecondsRemainingFrom(
      args.matchStartTimerActive,
      args.countdownEndsAt,
      args.nowMs,
    ),
  };
}

export function buildPrivateRoomWirePayloadPair(args: {
  roomCode: string;
  hostParticipantId: string;
  mode: GameMode;
  subcategoryKey: string | null;
  lessonId: number | null;
  difficultyMode: DifficultyMode;
  roomVersion: number;
  lobbyPlayerRows: LobbyWirePlayerRow[];
  privatePlayerRows: PrivateRoomStateWirePayload["players"];
  lockedParticipantIds: string[];
  matchStartTimerActive: boolean;
  countdownEndsAt: number | null;
  roomSettings: { questionMs: number; studyPhaseMs: number };
  teamPlayMode: PrivateRoomTeamPlayMode;
  heartsPerPlayer: PrivateRoomHeartsPerPlayer;
  teamsLobby?: PrivateRoomTeamsLobbyPayload;
  unassignedParticipantIds?: string[];
  maxPlayersForPrivateLobby: number;
  /** للاختبارات فقط — افتراضياً `Date.now()`. */
  nowMs?: number;
}): { lobby: LobbyStateWirePayload; privateRoom: PrivateRoomStateWirePayload } {
  const countdownSecondsRemaining = countdownSecondsRemainingFrom(
    args.matchStartTimerActive,
    args.countdownEndsAt,
    args.nowMs,
  );
  const hasTeamWire = args.teamPlayMode !== "individual" && args.teamsLobby != null;
  const teamSide = hasTeamWire
    ? {
        teamPlayMode: args.teamPlayMode,
        heartsPerPlayer: args.heartsPerPlayer,
        teamsLobby: args.teamsLobby!,
        unassignedParticipantIds: args.unassignedParticipantIds ?? [],
      }
    : {
        teamPlayMode: args.teamPlayMode,
        heartsPerPlayer: args.heartsPerPlayer,
      };
  const lobby: LobbyStateWirePayload = {
    mode: args.mode,
    players: args.lobbyPlayerRows,
    isStarting: args.matchStartTimerActive,
    participantIds: args.lockedParticipantIds,
    maxPlayersPerMatch: args.maxPlayersForPrivateLobby,
    countdownSecondsRemaining,
    isPrivate: true,
    roomCode: args.roomCode,
    hostParticipantId: args.hostParticipantId,
    roomSettings: { ...args.roomSettings },
    ...teamSide,
  };
  const privateRoom: PrivateRoomStateWirePayload = {
    roomCode: args.roomCode,
    hostParticipantId: args.hostParticipantId,
    mode: args.mode,
    subcategoryKey: args.subcategoryKey,
    lessonId: args.lessonId,
    difficultyMode: args.difficultyMode,
    roomVersion: args.roomVersion,
    players: args.privatePlayerRows,
    isStarting: args.matchStartTimerActive,
    participantIds: args.lockedParticipantIds,
    countdownSecondsRemaining,
    roomSettings: { ...args.roomSettings },
    ...teamSide,
  };
  return { lobby, privateRoom };
}
