/**
 * حمولة `match_resume_token` على السلك — يجب أن تبقى متوافقة مع `Match` و`ReconnectCoordinator`.
 */
export type MatchResumeTokenWirePayload = {
  matchId: string;
  participantId: string;
  resumeSecret: string;
  reconnectGraceMs: number;
  expiresAt: number;
};
