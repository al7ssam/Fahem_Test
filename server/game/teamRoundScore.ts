/** حساب نقاط السرعة للجولة (نفس صيغة Match.runTeamRoundScoring / finishRound الفردي). */
export function computeSpeedScoredBase(
  questionStartedAt: number,
  answerDeadline: number,
  answeredAt: number,
): number {
  const totalWindow = Math.max(1, answerDeadline - questionStartedAt);
  const progress = Math.min(1, Math.max(0, (answeredAt - questionStartedAt) / totalWindow));
  return Math.round(100 - progress * 99);
}

export function applySkillBoostToAwardPure(
  base: number,
  stacks: number,
  cfg: { maxMultiplier: number; percent: number },
): number {
  if (base <= 0 || stacks <= 0) return base;
  const mult = Math.min(cfg.maxMultiplier, 2 ** stacks * (cfg.percent / 100));
  return Math.round(base * (1 + mult));
}
