/** منطق لعب خالص مستخرج من Match — بدون IO؛ يُحافظ على نفس الصيغ الحالية. */

export function clampAnswerWindowMs(rawMs: number): number {
  return Math.min(120_000, Math.max(5_000, rawMs));
}

export type KeysGrantConfig = {
  keysStreakPerKey: number;
  keysMegaStreak: number;
  keysSmallStreakReward: number;
  keysMegaReward: number;
  keysDropRate: number;
};

/**
 * عدد المفاتيح الممنوحة لهذه الجولة قبل تطبيق السقف على اللاعب.
 * يطابق منطق applyKeyGrants السابق (بدون Math.min مع keysMaxPerPlayer).
 */
export function keysGrantedDeltaForStreakPure(streak: number, cfg: KeysGrantConfig): number {
  if (streak <= 0) return 0;
  let add = 0;
  if (streak % cfg.keysStreakPerKey === 0) add += cfg.keysSmallStreakReward;
  if (streak % cfg.keysMegaStreak === 0) add += cfg.keysMegaReward;
  if (add <= 0) return 0;
  const scaled = Math.floor(add * cfg.keysDropRate);
  if (scaled <= 0) return 0;
  return scaled;
}

export function shouldDeclareWinnerForActiveCountPure(opts: {
  hasPrivateTeams: boolean;
  activeTeams: number;
  activeIndividuals: number;
  isSoloMatch: boolean;
}): boolean {
  if (opts.hasPrivateTeams) return opts.activeTeams <= 1;
  const active = opts.activeIndividuals;
  return opts.isSoloMatch ? active <= 0 : active <= 1;
}

export function hasEnoughActivePlayersForQuestionsPure(opts: {
  hasPrivateTeams: boolean;
  activeTeams: number;
  activeIndividuals: number;
  isSoloMatch: boolean;
}): boolean {
  if (opts.hasPrivateTeams) return opts.activeTeams > 1;
  const active = opts.activeIndividuals;
  return opts.isSoloMatch ? active > 0 : active > 1;
}

export type Medal = "gold" | "silver" | "bronze" | null;

/**
 * ترتيب كثيف (dense): نفس الرتبة للمتساوين بالنقاط — كما في نهاية المباراة الجماعية ولوحة الفرق.
 */
export function attachDenseRankAndMedal<T>(
  rowsSortedDesc: readonly T[],
  getScore: (row: T) => number,
): Array<T & { rank: number; medal: Medal }> {
  let lastScore: number | null = null;
  let lastRank = 0;
  return rowsSortedDesc.map((row, idx) => {
    const sc = getScore(row);
    if (lastScore === null || sc !== lastScore) {
      lastRank = idx + 1;
      lastScore = sc;
    }
    const medal: Medal =
      lastRank === 1 ? "gold" : lastRank === 2 ? "silver" : lastRank === 3 ? "bronze" : null;
    return { ...row, rank: lastRank, medal };
  });
}

/** ترتيب تسلسلي بالفهرس (1..n) — كما في solo_incomplete و single_winner في Match. */
export function attachOrdinalRankAndMedalForSoloStyleLeaderboard<
  T extends {
    participantId: string;
    userId: string | null;
    name: string;
    skillPoints: number;
  },
>(rowsSortedDesc: readonly T[]): Array<{
  participantId: string;
  userId: string | null;
  name: string;
  skillPoints: number;
  rank: number;
  medal: Medal;
}> {
  return rowsSortedDesc.map((row, idx) => ({
    participantId: row.participantId,
    userId: row.userId,
    name: row.name,
    skillPoints: row.skillPoints,
    rank: idx + 1,
    medal: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : null,
  }));
}
