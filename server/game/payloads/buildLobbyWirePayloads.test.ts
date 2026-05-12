import { describe, expect, it } from "vitest";
import type { LobbyStateWirePayload } from "../../../shared/lobbyStateWire";
import {
  buildPrivateRoomWirePayloadPair,
  buildPublicLobbyWirePayload,
  countdownSecondsRemainingFrom,
} from "./buildLobbyWirePayloads";
import type { PrivateRoomTeamsLobbyPayload } from "../privateRoomTeamTypes";

const sampleLobbyPlayer: LobbyStateWirePayload["players"][number] = {
  participantId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  userId: null,
  name: "A",
  ready: false,
  mode: "direct",
  subcategoryKey: null,
  difficultyMode: "mix",
};

describe("countdownSecondsRemainingFrom", () => {
  it("returns undefined when not starting", () => {
    expect(countdownSecondsRemainingFrom(false, 12_000, 10_000)).toBeUndefined();
  });

  it("returns undefined when countdown end missing", () => {
    expect(countdownSecondsRemainingFrom(true, null, 10_000)).toBeUndefined();
  });

  it("ceil seconds remaining and floors at 1", () => {
    expect(countdownSecondsRemainingFrom(true, 12_000, 10_000)).toBe(2);
    expect(countdownSecondsRemainingFrom(true, 12_000, 15_000)).toBe(1);
  });
});

describe("buildPublicLobbyWirePayload", () => {
  it("matches stable fixture shape", () => {
    const payload = buildPublicLobbyWirePayload({
      mode: "direct",
      players: [sampleLobbyPlayer],
      lockedParticipantIds: [sampleLobbyPlayer.participantId],
      maxPlayersPerMatch: 8,
      matchStartTimerActive: true,
      countdownEndsAt: 12_000,
      nowMs: 10_000,
    });
    expect(payload).toEqual({
      mode: "direct",
      players: [sampleLobbyPlayer],
      isStarting: true,
      participantIds: [sampleLobbyPlayer.participantId],
      maxPlayersPerMatch: 8,
      countdownSecondsRemaining: 2,
    });
  });
});

describe("buildPrivateRoomWirePayloadPair", () => {
  const teamsLobby: PrivateRoomTeamsLobbyPayload = {
    desiredTeamCount: 2,
    teamsLocked: false,
    teams: [
      {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        displayName: "T1",
        captainParticipantId: sampleLobbyPlayer.participantId,
        memberParticipantIds: [sampleLobbyPlayer.participantId],
      },
    ],
  };

  it("includes team fields on lobby and private payloads when team mode active", () => {
    const { lobby, privateRoom } = buildPrivateRoomWirePayloadPair({
      roomCode: "AB12",
      hostParticipantId: sampleLobbyPlayer.participantId,
      mode: "direct",
      subcategoryKey: null,
      lessonId: null,
      difficultyMode: "mix",
      roomVersion: 3,
      lobbyPlayerRows: [sampleLobbyPlayer],
      privatePlayerRows: [
        {
          participantId: sampleLobbyPlayer.participantId,
          userId: null,
          name: "A",
          ready: false,
        },
      ],
      lockedParticipantIds: [],
      matchStartTimerActive: false,
      countdownEndsAt: null,
      roomSettings: { questionMs: 15000, studyPhaseMs: 8000 },
      teamPlayMode: "teams_first_answer",
      heartsPerPlayer: 3,
      teamsLobby,
      unassignedParticipantIds: [],
      maxPlayersForPrivateLobby: 6,
    });
    expect(lobby.isPrivate).toBe(true);
    expect(lobby.roomCode).toBe("AB12");
    expect(lobby.teamPlayMode).toBe("teams_first_answer");
    expect(lobby.teamsLobby).toEqual(teamsLobby);
    expect(lobby.unassignedParticipantIds).toEqual([]);
    expect(privateRoom.roomVersion).toBe(3);
    expect(privateRoom.teamPlayMode).toBe("teams_first_answer");
    expect(privateRoom.teamsLobby).toEqual(teamsLobby);
    expect(privateRoom.unassignedParticipantIds).toEqual([]);
  });

  it("omits teamsLobby wire block for individual mode", () => {
    const { lobby, privateRoom } = buildPrivateRoomWirePayloadPair({
      roomCode: "XY99",
      hostParticipantId: sampleLobbyPlayer.participantId,
      mode: "lesson",
      subcategoryKey: null,
      lessonId: 5,
      difficultyMode: "hard",
      roomVersion: 1,
      lobbyPlayerRows: [sampleLobbyPlayer],
      privatePlayerRows: [
        {
          participantId: sampleLobbyPlayer.participantId,
          userId: null,
          name: "A",
          ready: true,
        },
      ],
      lockedParticipantIds: [sampleLobbyPlayer.participantId],
      matchStartTimerActive: true,
      countdownEndsAt: 50_000,
      roomSettings: { questionMs: 10000, studyPhaseMs: 5000 },
      teamPlayMode: "individual",
      heartsPerPlayer: 2,
      maxPlayersForPrivateLobby: 4,
      nowMs: 48_000,
    });
    expect(lobby.teamsLobby).toBeUndefined();
    expect(lobby.unassignedParticipantIds).toBeUndefined();
    expect(privateRoom.teamsLobby).toBeUndefined();
    expect(privateRoom.unassignedParticipantIds).toBeUndefined();
    expect(lobby.countdownSecondsRemaining).toBe(2);
  });
});
