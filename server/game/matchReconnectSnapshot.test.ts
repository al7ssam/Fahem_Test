import { describe, expect, it } from "vitest";
import { matchReconnectSnapshotSchema } from "../../shared/matchReconnectSnapshot";

const goldenSnapshot = {
  serverNow: 1_700_000_000_000,
  reconnectGraceMs: 120_000,
  reconnectExpiresAt: 1_700_000_120_000,
  matchPhaseHint: "question",
  gameStarted: {
    matchId: "550e8400-e29b-41d4-a716-446655440000",
    gameMode: "study_then_quiz",
    teamPlayMode: "teams_first_answer",
    heartsPerPlayer: 3,
    subcategoryKey: "general_default",
    difficultyMode: "mix",
    players: [
      {
        participantId: "660e8400-e29b-41d4-a716-446655440001",
        userId: "u1",
        name: "أحمد",
        hearts: 3,
        eliminated: false,
        isSpectator: false,
        skillPoints: 10,
        lastAward: 0,
        keys: 1,
        skillBoostStacks: 0,
        teamId: "770e8400-e29b-41d4-a716-446655440002",
        isCaptain: true,
      },
    ],
    revealKeysActive: false,
    keysAttacksEnabled: true,
    abilityCosts: { skillBoost: 1, skipQuestion: 1, heartAttack: 2, reveal: 1 },
    abilityToggles: { skillBoost: true, skipQuestion: true, heartAttack: true, reveal: true },
  },
  keysRoomState: {
    revealKeysActive: false,
    macroRound: 1,
    players: [
      {
        participantId: "660e8400-e29b-41d4-a716-446655440001",
        userId: "u1",
        name: "أحمد",
        hearts: 3,
        eliminated: false,
        isSpectator: false,
        skillPoints: 10,
        lastAward: 0,
        keys: 1,
        skillBoostStacks: 0,
        teamId: "770e8400-e29b-41d4-a716-446655440002",
        isCaptain: true,
      },
    ],
    abilityCosts: { skillBoost: 1, skipQuestion: 1, heartAttack: 2, reveal: 1 },
    abilityToggles: { skillBoost: true, skipQuestion: true, heartAttack: true, reveal: true },
    keysAttacksEnabled: true,
  },
  question: {
    questionId: 42,
    prompt: "سؤال؟",
    options: ["أ", "ب", "ج", "د"],
    endsAt: 1_700_000_030_000,
    abilityGraceEndsAt: 1_700_000_030_500,
    serverNow: 1_700_000_000_000,
    round: 1,
    macroRound: 1,
    keysAttacksEnabled: true,
    abilityCosts: { skillBoost: 1, skipQuestion: 1, heartAttack: 2, reveal: 1 },
    abilityToggles: { skillBoost: true, skipQuestion: true, heartAttack: true, reveal: true },
    revealKeysActive: false,
  },
  study: null,
  teamVoteResync: null,
};

describe("matchReconnectSnapshotSchema", () => {
  it("يقبل لقطة ذهبية كاملة", () => {
    const r = matchReconnectSnapshotSchema.safeParse(goldenSnapshot);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.serverNow).toBe(goldenSnapshot.serverNow);
      expect(r.data.gameStarted.matchId).toBe(goldenSnapshot.gameStarted.matchId);
    }
  });

  it("يقبل حقولاً إضافية على الجذر (passthrough)", () => {
    const r = matchReconnectSnapshotSchema.safeParse({
      ...goldenSnapshot,
      futureField: { x: 1 },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { futureField?: { x: number } }).futureField?.x).toBe(1);
    }
  });

  it("يرفض matchPhaseHint غير صالح", () => {
    const r = matchReconnectSnapshotSchema.safeParse({
      ...goldenSnapshot,
      matchPhaseHint: "invalid_phase",
    });
    expect(r.success).toBe(false);
  });

  it("يرفض غياب gameStarted", () => {
    const { gameStarted: _g, ...rest } = goldenSnapshot;
    const r = matchReconnectSnapshotSchema.safeParse(rest);
    expect(r.success).toBe(false);
  });
});
