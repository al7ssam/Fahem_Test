import type { PrivateRoomStateClientPayload } from "./privateRoomFlow";

export type PrivateRoomStateApplyDeps = {
  getPrivateRoomCodeState: () => string | null;
  resetPrivateRoomSyncStateForNewSocketIntent: () => void;
  getPrivateRoomVersionState: () => number;
  setPrivateRoomVersionState: (v: number) => void;
  setPrivateRoomCodeState: (c: string) => void;
  setPrivateRoomHostParticipantId: (id: string) => void;
  setCurrentGameMode: (m: PrivateRoomStateClientPayload["mode"]) => void;
  setSelectedSubcategoryKey: (k: string | null) => void;
  applyLessonIdFromPrivateRoomPayload: (payload: PrivateRoomStateClientPayload) => void;
  setSelectedDifficultyMode: (d: PrivateRoomStateClientPayload["difficultyMode"]) => void;
  setPrivateRoomQuestionMs: (n: number) => void;
  setPrivateRoomStudyPhaseMs: (n: number) => void;
  setPrivateRoomTeamPlayModeState: (m: NonNullable<PrivateRoomStateClientPayload["teamPlayMode"]>) => void;
  setPrivateRoomHeartsPerPlayerState: (n: number) => void;
  setPrivateRoomTeamsLobbyState: (t: PrivateRoomStateClientPayload["teamsLobby"]) => void;
  setPrivateRoomUnassignedIds: (ids: string[]) => void;
  setLobbyPlayersList: (players: PrivateRoomStateClientPayload["players"]) => void;
  syncMyParticipantIdFromPlayers: (players: PrivateRoomStateClientPayload["players"]) => void;
  setPrivateReadyPending: (v: boolean) => void;
  setPrivateRoomInviteUrl: (url: string) => void;
  setLastPrivateRoomCode: (code: string) => void;
  setIsPrivateRoomSession: (v: boolean) => void;
  ensurePrivateQrDataUrl: (inviteUrl: string) => Promise<void>;
  getPhase: () => string;
  setPhase: (p: string) => void;
  isSelectedForMatchStart: (participantIds?: string[]) => boolean;
  setLobbyNotice: (msg: string) => void;
  render: () => void;
};

export async function applyPrivateRoomStateFromPayload(
  deps: PrivateRoomStateApplyDeps,
  payload: PrivateRoomStateClientPayload,
): Promise<void> {
  const prevRoomCode = deps.getPrivateRoomCodeState();
  if (prevRoomCode !== null && prevRoomCode !== payload.roomCode) {
    deps.resetPrivateRoomSyncStateForNewSocketIntent();
  }
  if (payload.roomVersion < deps.getPrivateRoomVersionState()) return;
  deps.setPrivateRoomVersionState(payload.roomVersion);
  deps.setPrivateRoomCodeState(payload.roomCode);
  deps.setPrivateRoomHostParticipantId(payload.hostParticipantId);
  deps.setCurrentGameMode(payload.mode);
  deps.setSelectedSubcategoryKey(payload.subcategoryKey);
  deps.applyLessonIdFromPrivateRoomPayload(payload);
  deps.setSelectedDifficultyMode(payload.difficultyMode);
  deps.setPrivateRoomQuestionMs(payload.roomSettings.questionMs);
  deps.setPrivateRoomStudyPhaseMs(payload.roomSettings.studyPhaseMs);
  deps.setPrivateRoomTeamPlayModeState(payload.teamPlayMode ?? "individual");
  deps.setPrivateRoomHeartsPerPlayerState(
    typeof payload.heartsPerPlayer === "number" ? payload.heartsPerPlayer : 3,
  );
  deps.setPrivateRoomTeamsLobbyState(payload.teamsLobby);
  deps.setPrivateRoomUnassignedIds(payload.unassignedParticipantIds ?? []);
  deps.setLobbyPlayersList(payload.players);
  deps.syncMyParticipantIdFromPlayers(payload.players);
  deps.setPrivateReadyPending(false);
  const inviteUrl = `${window.location.origin}?room=${payload.roomCode}`;
  deps.setPrivateRoomInviteUrl(inviteUrl);
  deps.setLastPrivateRoomCode(payload.roomCode);
  deps.setIsPrivateRoomSession(true);
  await deps.ensurePrivateQrDataUrl(inviteUrl);
  if (deps.getPhase() === "result") {
    return;
  }
  if (deps.getPhase() !== "countdown") {
    deps.setPhase("private_room_lobby");
  }
  if (payload.isStarting && deps.isSelectedForMatchStart(payload.participantIds)) {
    deps.setLobbyNotice("جاري بدء الجولة...");
  }
  deps.render();
}
