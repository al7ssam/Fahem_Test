import { describe, expect, it } from "vitest";
import {
  answerSchema,
  abilityHeartAttackSchema,
  ignoredClientBodySchema,
  joinLobbySchema,
  resumeMatchSchema,
} from "./socketSchemas";
import { matchReconnectSnapshotSchema } from "../../shared/matchReconnectSnapshot";

describe("joinLobbySchema", () => {
  it("accepts valid direct lobby join", () => {
    const r = joinLobbySchema.safeParse({
      name: "Test",
      mode: "direct",
      difficultyMode: "mix",
    });
    expect(r.success).toBe(true);
  });

  it("rejects lesson mode without lessonId", () => {
    const r = joinLobbySchema.safeParse({
      name: "Test",
      mode: "lesson",
      difficultyMode: "mix",
    });
    expect(r.success).toBe(false);
  });
});

describe("matchReconnectSnapshotSchema (wire)", () => {
  it("يرفض كائناً فارغاً", () => {
    const r = matchReconnectSnapshotSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});

describe("answerSchema", () => {
  it("accepts valid answer", () => {
    const r = answerSchema.safeParse({ questionId: 1, choiceIndex: 0 });
    expect(r.success).toBe(true);
  });

  it("rejects non-positive questionId", () => {
    const r = answerSchema.safeParse({ questionId: 0, choiceIndex: 0 });
    expect(r.success).toBe(false);
  });

  it("rejects negative choiceIndex", () => {
    const r = answerSchema.safeParse({ questionId: 1, choiceIndex: -1 });
    expect(r.success).toBe(false);
  });
});

describe("abilityHeartAttackSchema", () => {
  it("accepts non-empty target id", () => {
    const r = abilityHeartAttackSchema.safeParse({ targetParticipantId: "pid-1" });
    expect(r.success).toBe(true);
  });

  it("rejects empty target", () => {
    const r = abilityHeartAttackSchema.safeParse({ targetParticipantId: "" });
    expect(r.success).toBe(false);
  });
});

describe("ignoredClientBodySchema", () => {
  it("accepts undefined and arbitrary objects", () => {
    expect(ignoredClientBodySchema.safeParse(undefined).success).toBe(true);
    expect(ignoredClientBodySchema.safeParse({}).success).toBe(true);
    expect(ignoredClientBodySchema.safeParse(null).success).toBe(true);
  });
});

describe("resumeMatchSchema", () => {
  it("accepts valid resume payload", () => {
    const r = resumeMatchSchema.safeParse({
      matchId: "550e8400-e29b-41d4-a716-446655440000",
      participantId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      resumeSecret: "abc",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid uuid matchId", () => {
    const r = resumeMatchSchema.safeParse({
      matchId: "not-a-uuid",
      participantId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      resumeSecret: "x",
    });
    expect(r.success).toBe(false);
  });

  it("accepts the same valid payload on repeated parse (schema layer idempotency)", () => {
    const body = {
      matchId: "550e8400-e29b-41d4-a716-446655440000",
      participantId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      resumeSecret: "abc",
    };
    const a = resumeMatchSchema.safeParse(body);
    const b = resumeMatchSchema.safeParse(body);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});
