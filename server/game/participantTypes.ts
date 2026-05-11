/**
 * مقعد لاعب عند إنشاء المباراة: participantId سلطة الحالة، connectionSocketId للنقل فقط.
 * userId للسياسات ولTeam Mode (اختياري إن لم يُعرَف المستخدم).
 */
export type MatchSeatInput = {
  participantId: string;
  connectionSocketId: string;
  name: string;
  playerSessionId: string;
  userId: string | null;
  /** وضع الفرق في الغرفة الخاصة فقط؛ null في اللوبي العام أو الفردي داخل المباراة. */
  teamId?: string | null;
  isCaptain?: boolean;
};
