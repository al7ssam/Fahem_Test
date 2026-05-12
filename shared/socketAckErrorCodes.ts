/**
 * رموز خطأ موحّدة لـ ACK وللسجلات — القيم النصية ثابتة (العميل يعتمد عليها).
 * استخدم `Ack.*` بدل الحرف النصي لتقليل أخطاء الكتابة وتسهيل البحث.
 */
export const Ack = {
  server_draining: "server_draining",
  invalid_name: "invalid_name",
  invalid_body: "invalid_body",
  server: "server",
  custom_lesson_expired: "custom_lesson_expired",
  lesson_id_required: "lesson_id_required",
  lesson_not_found: "lesson_not_found",
  not_enough_questions: "not_enough_questions",
  not_in_match: "not_in_match",
  not_in_lobby: "not_in_lobby",
  no_match: "no_match",
  unknown_seat: "unknown_seat",
  not_spectator: "not_spectator",
  rate_limited: "rate_limited",
  solo_no_transport_reconnect: "solo_no_transport_reconnect",
  seat_not_in_match: "seat_not_in_match",
  bad_token: "bad_token",
  cannot_resume: "cannot_resume",
  room_not_found: "room_not_found",
  not_in_private_room: "not_in_private_room",
  forbidden: "forbidden",
  countdown_started: "countdown_started",
  non_empty_team: "non_empty_team",
  max_teams: "max_teams",
  min_teams: "min_teams",
  team_not_empty: "team_not_empty",
  invalid_captain: "invalid_captain",
  teams_disabled: "teams_disabled",
  teams_locked: "teams_locked",
  team_not_found: "team_not_found",
  not_member: "not_member",
  not_in_team: "not_in_team",
} as const;

export type AckErrorCode = (typeof Ack)[keyof typeof Ack];
