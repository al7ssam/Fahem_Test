import { z } from "zod";

export const matchPhaseHintSchema = z.enum(["idle", "study", "between", "question"]);

const abilityCostsSchema = z
  .object({
    skillBoost: z.number(),
    skipQuestion: z.number(),
    heartAttack: z.number(),
    reveal: z.number(),
  })
  .passthrough();

const abilityTogglesSchema = z
  .object({
    skillBoost: z.boolean(),
    skipQuestion: z.boolean(),
    heartAttack: z.boolean(),
    reveal: z.boolean(),
  })
  .passthrough();

const matchPlayerPublicSchema = z
  .object({
    participantId: z.string(),
    userId: z.string().nullable(),
    name: z.string(),
    hearts: z.number(),
    eliminated: z.boolean(),
    isSpectator: z.boolean(),
    skillPoints: z.number(),
    lastAward: z.number(),
    keys: z.number(),
    skillBoostStacks: z.number(),
    teamId: z.string().nullable(),
    isCaptain: z.boolean(),
  })
  .passthrough();

const gameStartedSliceSchema = z
  .object({
    matchId: z.string(),
    gameMode: z.enum(["direct", "study_then_quiz", "lesson"]),
    difficultyMode: z.enum(["mix", "easy", "medium", "hard"]),
    players: z.array(matchPlayerPublicSchema),
    revealKeysActive: z.boolean(),
    keysAttacksEnabled: z.boolean(),
    abilityCosts: abilityCostsSchema,
    abilityToggles: abilityTogglesSchema,
  })
  .passthrough();

const keysRoomStateSchema = z
  .object({
    revealKeysActive: z.boolean(),
    macroRound: z.number(),
    players: z.array(matchPlayerPublicSchema),
    abilityCosts: abilityCostsSchema,
    abilityToggles: abilityTogglesSchema,
    keysAttacksEnabled: z.boolean(),
  })
  .passthrough();

const questionSliceSchema = z
  .object({
    questionId: z.number(),
    prompt: z.string(),
    options: z.array(z.string()),
    endsAt: z.number(),
    abilityGraceEndsAt: z.number(),
    serverNow: z.number(),
    round: z.number(),
    macroRound: z.number(),
    keysAttacksEnabled: z.boolean(),
    abilityCosts: abilityCostsSchema,
    abilityToggles: abilityTogglesSchema,
    revealKeysActive: z.boolean(),
  })
  .passthrough();

const studySliceSchema = z
  .object({
    study_phase: z.record(z.unknown()),
    round_ready_window: z.record(z.unknown()),
    round_ready_state: z
      .object({
        roundToken: z.string(),
        macroRound: z.number(),
        readyParticipantIds: z.array(z.string()),
        totalActive: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

const teamVoteResyncEntrySchema = z
  .object({
    teamId: z.string(),
    votes: z.record(z.number()),
    captainAwaitingSecondOn: z.number().nullable(),
  })
  .passthrough();

/**
 * لقطة مزامنة إعادة الربط — جذر بـ passthrough() لحقول إضافية مستقبلية دون كسر عملاء قدامى.
 */
export const matchReconnectSnapshotSchema = z
  .object({
    serverNow: z.number(),
    reconnectGraceMs: z.number(),
    reconnectExpiresAt: z.number(),
    matchPhaseHint: matchPhaseHintSchema,
    gameStarted: gameStartedSliceSchema,
    keysRoomState: keysRoomStateSchema,
    question: questionSliceSchema.nullable(),
    study: studySliceSchema.nullable(),
    teamVoteResync: z.array(teamVoteResyncEntrySchema).nullable(),
  })
  .passthrough();

export type MatchReconnectSnapshot = z.infer<typeof matchReconnectSnapshotSchema>;

export function safeParseMatchReconnectSnapshot(
  raw: unknown,
): { success: true; data: MatchReconnectSnapshot } | { success: false; error: z.ZodError } {
  return matchReconnectSnapshotSchema.safeParse(raw);
}
