import { randomUUID } from "crypto";

/** وضع اللعب في الغرفة الخاصة (يختاره المضيف قبل البدء). */
export type PrivateRoomTeamPlayMode =
  | "individual"
  | "teams_first_answer"
  | "teams_captain_approval";

/**
 * قلوب لكل لاعب عند بدء المباراة.
 * 0 = تعطيل القلوب: لا خسارة من إجابات خاطئة ولا مشاهد بسبب القلوب؛ الإقصاء عند disconnect كالحالي.
 */
export type PrivateRoomHeartsPerPlayer = 0 | 1 | 2 | 3 | 4 | 5;

/** فريق في لوبي الغرفة الخاصة. */
export type PrivateRoomTeamLobby = {
  teamId: string;
  displayName: string;
  memberParticipantIds: string[];
  captainParticipantId: string;
};

/** حالة الفرق في اللوبي (مصدر الحقيقة: Map على السيرفر فقط). */
export type PrivateRoomTeamsLobbyState = {
  desiredTeamCount: number;
  teamsLocked: boolean;
  teams: Map<string, PrivateRoomTeamLobby>;
};

export type PrivateRoomTeamLobbyPayload = {
  teamId: string;
  displayName: string;
  captainParticipantId: string;
  memberParticipantIds: string[];
};

export type PrivateRoomTeamsLobbyPayload = {
  desiredTeamCount: number;
  teamsLocked: boolean;
  teams: PrivateRoomTeamLobbyPayload[];
};

/** لقطة فرق عند بدء المباراة (بدون Map). */
export type MatchTeamSnapshot = {
  teamId: string;
  displayName: string;
  captainParticipantId: string;
  memberParticipantIds: string[];
};

export type MatchPrivateTeamsStartConfig = {
  teamPlayMode: "teams_first_answer" | "teams_captain_approval";
  teams: MatchTeamSnapshot[];
  heartsPerPlayer: PrivateRoomHeartsPerPlayer;
};

/** خيارات غرفة خاصة تُمرَّر إلى Match (null في اللوبي العام). */
export type MatchPrivateRuntimeOptions = {
  teamPlayMode: PrivateRoomTeamPlayMode;
  heartsPerPlayer: PrivateRoomHeartsPerPlayer;
  teams: MatchPrivateTeamsStartConfig | null;
};

export function defaultTeamDisplayName(index: number): string {
  return `فريق ${index + 1}`;
}

const MIN_TEAMS = 2;
const MAX_TEAMS = 12;

export function clampDesiredTeamCount(n: number): number {
  return Math.min(MAX_TEAMS, Math.max(MIN_TEAMS, Math.floor(n)));
}

export function createEmptyTeamsLobbyState(desiredTeamCount: number): PrivateRoomTeamsLobbyState {
  const n = clampDesiredTeamCount(desiredTeamCount);
  const teams = new Map<string, PrivateRoomTeamLobby>();
  for (let i = 0; i < n; i++) {
    const teamId = randomUUID();
    teams.set(teamId, {
      teamId,
      displayName: defaultTeamDisplayName(i),
      memberParticipantIds: [],
      captainParticipantId: "",
    });
  }
  return {
    desiredTeamCount: n,
    teamsLocked: false,
    teams,
  };
}

export function teamsLobbyToPayload(tl: PrivateRoomTeamsLobbyState): PrivateRoomTeamsLobbyPayload {
  const teams = [...tl.teams.values()].map((t) => ({
    teamId: t.teamId,
    displayName: t.displayName,
    captainParticipantId: t.captainParticipantId,
    memberParticipantIds: [...t.memberParticipantIds],
  }));
  return {
    desiredTeamCount: tl.desiredTeamCount,
    teamsLocked: tl.teamsLocked,
    teams,
  };
}

export function listUnassignedParticipantIds(
  roomMemberIds: Iterable<string>,
  teamsLobby: PrivateRoomTeamsLobbyState,
): string[] {
  const assigned = new Set<string>();
  for (const t of teamsLobby.teams.values()) {
    for (const id of t.memberParticipantIds) assigned.add(id);
  }
  return [...roomMemberIds].filter((id) => !assigned.has(id));
}

export function allRoomMembersAssignedToTeams(
  roomMemberIds: Set<string>,
  teamsLobby: PrivateRoomTeamsLobbyState | null | undefined,
): boolean {
  if (!teamsLobby) return true;
  return listUnassignedParticipantIds(roomMemberIds, teamsLobby).length === 0;
}

/** فرق غير فارغة فقط — للّقطة عند بدء المباراة. */
export function nonEmptyTeamSnapshots(teamsLobby: PrivateRoomTeamsLobbyState): MatchTeamSnapshot[] {
  const out: MatchTeamSnapshot[] = [];
  for (const t of teamsLobby.teams.values()) {
    if (t.memberParticipantIds.length === 0) continue;
    out.push({
      teamId: t.teamId,
      displayName: t.displayName,
      captainParticipantId: t.captainParticipantId,
      memberParticipantIds: [...t.memberParticipantIds],
    });
  }
  return out;
}
