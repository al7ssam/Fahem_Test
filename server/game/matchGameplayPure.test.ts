import { describe, expect, it } from "vitest";
import {
  attachDenseRankAndMedal,
  attachOrdinalRankAndMedalForSoloStyleLeaderboard,
  clampAnswerWindowMs,
  hasEnoughActivePlayersForQuestionsPure,
  keysGrantedDeltaForStreakPure,
  shouldDeclareWinnerForActiveCountPure,
} from "./matchGameplayPure";

describe("matchGameplayPure — clampAnswerWindowMs", () => {
  it.each([
    [4_000, 5_000],
    [5_000, 5_000],
    [60_000, 60_000],
    [120_000, 120_000],
    [200_000, 120_000],
  ])("clamp(%i) === %i", (raw, expected) => {
    expect(clampAnswerWindowMs(raw)).toBe(expected);
  });
});

describe("matchGameplayPure — keysGrantedDeltaForStreakPure", () => {
  const cfg = {
    keysStreakPerKey: 3,
    keysMegaStreak: 10,
    keysSmallStreakReward: 1,
    keysMegaReward: 3,
    keysDropRate: 1,
  };

  it("streak <= 0 → 0", () => {
    expect(keysGrantedDeltaForStreakPure(0, cfg)).toBe(0);
    expect(keysGrantedDeltaForStreakPure(-1, cfg)).toBe(0);
  });

  it("عند 3 يمنح small فقط", () => {
    expect(keysGrantedDeltaForStreakPure(3, cfg)).toBe(1);
  });

  it("عند 30 يجمع small + mega (كلاهما يقسم المضاعف)", () => {
    expect(keysGrantedDeltaForStreakPure(30, cfg)).toBe(4);
  });

  it("عند 10 يمنح mega فقط", () => {
    expect(keysGrantedDeltaForStreakPure(10, cfg)).toBe(3);
  });

  it("keysDropRate يخفض النتيجة", () => {
    expect(keysGrantedDeltaForStreakPure(3, { ...cfg, keysDropRate: 0.5 })).toBe(0);
  });
});

describe("matchGameplayPure — shouldDeclareWinnerForActiveCountPure", () => {
  it.each([
    { hasPrivateTeams: true, activeTeams: 2, activeIndividuals: 5, isSoloMatch: false, exp: false },
    { hasPrivateTeams: true, activeTeams: 1, activeIndividuals: 5, isSoloMatch: false, exp: true },
    { hasPrivateTeams: true, activeTeams: 0, activeIndividuals: 5, isSoloMatch: false, exp: true },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 2, isSoloMatch: false, exp: false },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 1, isSoloMatch: false, exp: true },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 0, isSoloMatch: false, exp: true },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 1, isSoloMatch: true, exp: false },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 0, isSoloMatch: true, exp: true },
  ] as const)("table %#", (row) => {
    expect(
      shouldDeclareWinnerForActiveCountPure({
        hasPrivateTeams: row.hasPrivateTeams,
        activeTeams: row.activeTeams,
        activeIndividuals: row.activeIndividuals,
        isSoloMatch: row.isSoloMatch,
      }),
    ).toBe(row.exp);
  });
});

describe("matchGameplayPure — hasEnoughActivePlayersForQuestionsPure", () => {
  it.each([
    { hasPrivateTeams: true, activeTeams: 2, activeIndividuals: 0, isSoloMatch: false, exp: true },
    { hasPrivateTeams: true, activeTeams: 1, activeIndividuals: 0, isSoloMatch: false, exp: false },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 2, isSoloMatch: false, exp: true },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 1, isSoloMatch: false, exp: false },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 1, isSoloMatch: true, exp: true },
    { hasPrivateTeams: false, activeTeams: 0, activeIndividuals: 0, isSoloMatch: true, exp: false },
  ] as const)("table %#", (row) => {
    expect(
      hasEnoughActivePlayersForQuestionsPure({
        hasPrivateTeams: row.hasPrivateTeams,
        activeTeams: row.activeTeams,
        activeIndividuals: row.activeIndividuals,
        isSoloMatch: row.isSoloMatch,
      }),
    ).toBe(row.exp);
  });
});

describe("matchGameplayPure — attachDenseRankAndMedal", () => {
  it("متساوون في المركز الأول يشتركون rank 1", () => {
    const rows = [
      { id: "a", skillPoints: 10 },
      { id: "b", skillPoints: 10 },
      { id: "c", skillPoints: 5 },
    ];
    const out = attachDenseRankAndMedal(rows, (r) => r.skillPoints);
    expect(out[0].rank).toBe(1);
    expect(out[1].rank).toBe(1);
    expect(out[2].rank).toBe(3);
    expect(out[0].medal).toBe("gold");
    expect(out[1].medal).toBe("gold");
    expect(out[2].medal).toBe("bronze");
  });

  it("كل الصفر — ميداليات ذهب متعددة للرتبة 1", () => {
    const rows = [
      { id: "a", skillPoints: 0 },
      { id: "b", skillPoints: 0 },
    ];
    const out = attachDenseRankAndMedal(rows, (r) => r.skillPoints);
    expect(out[0].rank).toBe(1);
    expect(out[1].rank).toBe(1);
    expect(out[0].medal).toBe("gold");
    expect(out[1].medal).toBe("gold");
  });
});

describe("matchGameplayPure — attachOrdinalRankAndMedalForSoloStyleLeaderboard", () => {
  it("نفس النقاط لكن رتب تسلسلية 1 و 2 (سلوك solo_incomplete)", () => {
    const rows = [
      { participantId: "a", userId: null, name: "A", skillPoints: 10, hearts: 0, eliminated: true },
      { participantId: "b", userId: null, name: "B", skillPoints: 10, hearts: 0, eliminated: true },
    ];
    const out = attachOrdinalRankAndMedalForSoloStyleLeaderboard(rows);
    expect(out[0].rank).toBe(1);
    expect(out[1].rank).toBe(2);
    expect(out[0].medal).toBe("gold");
    expect(out[1].medal).toBe("silver");
  });
});
