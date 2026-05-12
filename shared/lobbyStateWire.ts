/**
 * شكل JSON لأحداث `lobby_state` و`private_room_state` على السلك.
 * يُبنى على الخادم عبر `server/game/payloads/buildLobbyWirePayloads.ts`.
 */

export type GameModeWire = "direct" | "study_then_quiz" | "lesson";

export type DifficultyModeWire = "mix" | "easy" | "medium" | "hard";

export type PrivateRoomTeamPlayModeWire =
  | "individual"
  | "teams_first_answer"
  | "teams_captain_approval";

export type PrivateRoomHeartsPerPlayerWire = 0 | 1 | 2 | 3 | 4 | 5;

export type PrivateRoomTeamLobbyPayloadWire = {
  teamId: string;
  displayName: string;
  captainParticipantId: string;
  memberParticipantIds: string[];
};

export type PrivateRoomTeamsLobbyPayloadWire = {
  desiredTeamCount: number;
  teamsLocked: boolean;
  teams: PrivateRoomTeamLobbyPayloadWire[];
};

export type LobbyStateWirePayload = {
  mode: GameModeWire;
  players: Array<{
    participantId: string;
    userId: string | null;
    name: string;
    ready: boolean;
    mode: GameModeWire;
    subcategoryKey: string | null;
    difficultyMode: DifficultyModeWire;
  }>;
  isStarting: boolean;
  participantIds: string[];
  maxPlayersPerMatch: number;
  countdownSecondsRemaining?: number;
  isPrivate?: boolean;
  roomCode?: string;
  hostParticipantId?: string;
  roomSettings?: {
    questionMs: number;
    studyPhaseMs: number;
  };
  teamPlayMode?: PrivateRoomTeamPlayModeWire;
  heartsPerPlayer?: PrivateRoomHeartsPerPlayerWire;
  teamsLobby?: PrivateRoomTeamsLobbyPayloadWire;
  unassignedParticipantIds?: string[];
};

export type PrivateRoomStateWirePayload = {
  roomCode: string;
  hostParticipantId: string;
  mode: GameModeWire;
  subcategoryKey: string | null;
  lessonId: number | null;
  difficultyMode: DifficultyModeWire;
  roomVersion: number;
  players: Array<{ participantId: string; userId: string | null; name: string; ready: boolean }>;
  isStarting: boolean;
  participantIds: string[];
  countdownSecondsRemaining?: number;
  roomSettings: {
    questionMs: number;
    studyPhaseMs: number;
  };
  teamPlayMode: PrivateRoomTeamPlayModeWire;
  heartsPerPlayer: PrivateRoomHeartsPerPlayerWire;
  teamsLobby?: PrivateRoomTeamsLobbyPayloadWire;
  unassignedParticipantIds?: string[];
};
