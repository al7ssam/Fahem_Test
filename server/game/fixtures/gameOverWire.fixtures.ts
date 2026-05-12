/**
 * حمولات تمييزية لعقد game_over — تُستورد في الاختبارات فقط.
 * IDs وهمية؛ نصوص عربية ثابتة.
 */

export const gameOverNoQuestionsFixture = {
  reason: "no_questions",
  outcomeType: "no_questions" as const,
  winner: null,
  winners: [] as const,
  players: [
    {
      participantId: "p1",
      userId: null,
      name: "لاعب أ",
      hearts: 3,
      eliminated: false,
      skillPoints: 0,
    },
  ],
  resultMessages: { winner: "فاز", loser: "خسر", tie: "تعادل" },
};

export const gameOverServerShutdownFixture = {
  reason: "server_shutdown",
  outcomeType: "server_shutdown" as const,
  winner: null,
  winners: [] as const,
  players: [
    {
      participantId: "p1",
      userId: "u1",
      name: "لاعب",
      hearts: 2,
      eliminated: false,
    },
  ],
  resultMessages: { winner: "", loser: "", tie: "" },
};

export const gameOverServerAbortedFixture = {
  reason: "runtime_error",
  outcomeType: "server_aborted" as const,
  winner: null,
  winners: [] as const,
  players: [
    {
      participantId: "p1",
      userId: null,
      name: "لاعب",
      hearts: 1,
      eliminated: false,
    },
  ],
  resultMessages: { winner: "فاز", loser: "خسر", tie: "تعادل" },
};

export const gameOverTeamMatchFixture = {
  reason: "finished",
  outcomeType: "team_match" as const,
  winner: null,
  winners: [] as const,
  players: [],
  teamLeaderboard: [
    { rank: 1, teamId: "t1", displayName: "الفريق أ", teamScore: 120, medal: "gold" as const },
    { rank: 2, teamId: "t2", displayName: "الفريق ب", teamScore: 80, medal: "silver" as const },
  ],
  starsOfTheMatch: [],
  winningTeams: [{ teamId: "t1", displayName: "الفريق أ", teamScore: 120 }],
  resultMessages: { winner: "فاز", loser: "خسر", tie: "تعادل" },
  leaderboard: [
    {
      participantId: "p1",
      userId: null,
      name: "أحمد",
      skillPoints: 50,
      rank: 1,
      medal: "gold" as const,
    },
  ],
};

export const gameOverSoloIncompleteFixture = {
  reason: "eliminated",
  outcomeType: "solo_incomplete" as const,
  winner: null,
  winners: [] as const,
  players: [
    {
      participantId: "solo1",
      userId: null,
      name: "سولو",
      hearts: 0,
      eliminated: true,
      skillPoints: 10,
    },
  ],
  resultMessages: { winner: "فاز", loser: "خسر", tie: "تعادل" },
  leaderboard: [
    {
      participantId: "solo1",
      userId: null,
      name: "سولو",
      skillPoints: 10,
      rank: 1,
      medal: "gold" as const,
    },
  ],
};
