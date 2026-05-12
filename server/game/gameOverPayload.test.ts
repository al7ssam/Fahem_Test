import { describe, expect, it } from "vitest";
import { gameOverWireSchema } from "../../shared/gameOverPayload";

describe("gameOverWireSchema", () => {
  it("يقبل game_over أساسياً", () => {
    const r = gameOverWireSchema.safeParse({
      outcomeType: "single_winner",
      reason: "finished",
      winner: { participantId: "p1", userId: null, name: "لاعب" },
      winners: [{ participantId: "p1", userId: null, name: "لاعب" }],
      players: [
        {
          participantId: "p1",
          userId: null,
          name: "لاعب",
          hearts: 2,
          eliminated: false,
          skillPoints: 100,
        },
      ],
      resultMessages: { winner: "فاز", loser: "خسر", tie: "تعادل" },
    });
    expect(r.success).toBe(true);
  });

  it("يقبل حقولاً إضافية (leaderboard)", () => {
    const r = gameOverWireSchema.safeParse({
      outcomeType: "team_match",
      players: [],
      teamLeaderboard: [{ rank: 1, teamId: "t1", displayName: "A", teamScore: 10, medal: "gold" }],
    });
    expect(r.success).toBe(true);
  });

  it("يرفض outcomeType غير معروف", () => {
    const r = gameOverWireSchema.safeParse({
      outcomeType: "unknown_outcome",
      players: [],
    });
    expect(r.success).toBe(false);
  });
});
