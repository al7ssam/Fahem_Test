import { describe, expect, it } from "vitest";
import {
  gameOverNoQuestionsFixture,
  gameOverServerAbortedFixture,
  gameOverServerShutdownFixture,
  gameOverSoloIncompleteFixture,
  gameOverTeamMatchFixture,
} from "./fixtures/gameOverWire.fixtures";
import { expectGameOverParses } from "./testUtils/gameOverExpect";
import { safeParseGameOverWire } from "../../shared/gameOverPayload";

describe("gameOverWire — characterization fixtures", () => {
  it.each([
    ["no_questions", gameOverNoQuestionsFixture],
    ["server_shutdown", gameOverServerShutdownFixture],
    ["server_aborted", gameOverServerAbortedFixture],
    ["team_match", gameOverTeamMatchFixture],
    ["solo_incomplete", gameOverSoloIncompleteFixture],
  ] as const)("يقبل fixture %s", (_label, payload) => {
    expectGameOverParses(payload);
    const r = safeParseGameOverWire(payload);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.players).toBeDefined();
    expect(Array.isArray(r.data.players)).toBe(true);
    expect(r.data.outcomeType).toBe(payload.outcomeType);
  });

  it("no_questions — winner فارغ", () => {
    const r = safeParseGameOverWire(gameOverNoQuestionsFixture);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.outcomeType).toBe("no_questions");
    expect(r.data.winner).toBeNull();
  });

  it("team_match — يحتفظ بحقول إضافية عبر passthrough", () => {
    const r = safeParseGameOverWire(gameOverTeamMatchFixture);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.outcomeType).toBe("team_match");
    const extra = r.data as { teamLeaderboard?: unknown };
    expect(Array.isArray(extra.teamLeaderboard)).toBe(true);
  });
});
