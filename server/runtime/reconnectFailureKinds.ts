/**
 * أسباب فشل معروفة لـ resume_match (مرجع تشغيلي — العميل يعتمد على نفس السلاسل).
 * لا تُحذف قيماً دون توافق مع العميل.
 */
export const RECONNECT_RESUME_FAILURE_REASONS = [
  "server_draining",
  "rate_limited",
  "invalid_body",
  "no_match",
  "solo_no_transport_reconnect",
  "seat_not_in_match",
  "bad_token",
  "cannot_resume",
  "server",
] as const;

export type ReconnectResumeFailureReason = (typeof RECONNECT_RESUME_FAILURE_REASONS)[number];

export const CONTINUE_SPECTATOR_FAILURE_REASONS = [
  "invalid_body",
  "no_match",
  "unknown_seat",
  "not_spectator",
  "server",
] as const;

export type ContinueSpectatorFailureReason = (typeof CONTINUE_SPECTATOR_FAILURE_REASONS)[number];
