import { z } from "zod";

/** أنواع النتيجة المعروفة في العميل والخادم (مع مسار solo_study_incomplete المحتمل من منطق قديم). */
export const gameOverOutcomeTypeSchema = z.enum([
  "no_questions",
  "server_aborted",
  "server_shutdown",
  "single_winner",
  "shared_winners",
  "tie_all_zero",
  "solo_incomplete",
  "solo_study_incomplete",
  "team_match",
]);

const winnerWireSchema = z
  .object({
    participantId: z.string().optional(),
    userId: z.string().nullable().optional(),
    name: z.string(),
  })
  .passthrough();

const resultMessagesWireSchema = z
  .object({
    winner: z.string(),
    loser: z.string(),
    tie: z.string(),
    winnerTitle: z.string().optional(),
    loserTitle: z.string().optional(),
    tieTitle: z.string().optional(),
  })
  .passthrough();

const playerRowWireSchema = z
  .object({
    participantId: z.string().optional(),
    userId: z.string().nullable().optional(),
    name: z.string(),
    hearts: z.number(),
    eliminated: z.boolean(),
    skillPoints: z.number().optional(),
    lastAward: z.number().optional(),
    isSpectator: z.boolean().optional(),
    keys: z.number().optional(),
    skillBoostStacks: z.number().optional(),
    teamId: z.string().nullable().optional(),
    isCaptain: z.boolean().optional(),
  })
  .passthrough();

/**
 * شكل حرج لـ game_over مع passthrough للحقول الإضافية (leaderboard، lessonReview، …).
 */
export const gameOverWireSchema = z
  .object({
    outcomeType: gameOverOutcomeTypeSchema,
    players: z.array(playerRowWireSchema),
    reason: z.string().optional(),
    winner: winnerWireSchema.nullable().optional(),
    winners: z.array(winnerWireSchema).optional(),
    resultMessages: resultMessagesWireSchema.optional(),
  })
  .passthrough();

export type GameOverWirePayload = z.infer<typeof gameOverWireSchema>;

export function safeParseGameOverWire(
  raw: unknown,
): { success: true; data: GameOverWirePayload } | { success: false; error: z.ZodError } {
  return gameOverWireSchema.safeParse(raw);
}
