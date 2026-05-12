/** أنواع حمولة `private_room_state` — تطبيق المزامنة في `privateRoomStateApply.ts`. */
export type PrivateTeamLobbyTeamPayload = {
  teamId: string;
  displayName: string;
  captainParticipantId: string;
  memberParticipantIds: string[];
};

export type PrivateRoomStateClientPayload = {
  roomCode: string;
  hostParticipantId: string;
  mode: "direct" | "study_then_quiz" | "lesson";
  subcategoryKey: string | null;
  lessonId?: number | null;
  difficultyMode: "mix" | "easy" | "medium" | "hard";
  roomVersion: number;
  players: Array<{
    participantId: string;
    userId?: string | null;
    name: string;
    ready: boolean;
  }>;
  isStarting: boolean;
  participantIds: string[];
  countdownSecondsRemaining?: number;
  roomSettings: { questionMs: number; studyPhaseMs: number };
  teamPlayMode?: "individual" | "teams_first_answer" | "teams_captain_approval";
  heartsPerPlayer?: number;
  teamsLobby?: {
    desiredTeamCount: number;
    teamsLocked: boolean;
    teams: PrivateTeamLobbyTeamPayload[];
  };
  unassignedParticipantIds?: string[];
};
