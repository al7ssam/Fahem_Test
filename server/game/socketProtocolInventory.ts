/**
 * جرد Phase D0 — مرجع داخلي لأحداث المقبس وACK ومسارات التنظيف.
 * لا يُستورد من مسار حرج للأداء؛ للتوثيق والبحث فقط.
 */

export type SocketDirection = "C2S" | "S2C";

export type CleanupPath =
  | "none"
  | "leaveMatchForSocket"
  | "leaveLobbyEverywhere"
  | "removeFromPrivateRoom"
  | "combo_join_lobby"
  | "combo_start_solo"
  | "disconnect_chain";

export type ProtocolRow = {
  event: string;
  direction: SocketDirection;
  /** أين يُسجَّل المعالج الأساسي */
  handlerModule: string;
  zodSchema: string | null;
  ackNotes: string;
  cleanupOnJoinLikePaths: CleanupPath;
};

/**
 * ملخص — ليس مُنشأ آلياً؛ حدّث عند إضافة أحداث.
 * `combo_join_lobby`: يترك المباراة واللوبي والغرفة الخاصة قبل الانضمام (انظر LobbyCoordinator).
 */
export const SOCKET_PROTOCOL_INVENTORY: readonly ProtocolRow[] = [
  { event: "join_lobby", direction: "C2S", handlerModule: "LobbyCoordinator", zodSchema: "joinLobbySchema", ackNotes: "{ ok, error? }", cleanupOnJoinLikePaths: "combo_join_lobby" },
  { event: "player_ready", direction: "C2S", handlerModule: "LobbyCoordinator", zodSchema: null, ackNotes: "{ ok, error? }", cleanupOnJoinLikePaths: "none" },
  { event: "start_solo_match", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "joinLessonFlexibleSchema", ackNotes: "{ ok, error?, message? }", cleanupOnJoinLikePaths: "combo_start_solo" },
  { event: "answer", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "answerSchema", ackNotes: "SimpleBooleanAck (reason? عند الفشل)", cleanupOnJoinLikePaths: "none" },
  { event: "round_ready", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "ignoredClientBodySchema", ackNotes: "{ ok: boolean }", cleanupOnJoinLikePaths: "none" },
  { event: "resume_match", direction: "C2S", handlerModule: "ReconnectCoordinator", zodSchema: "resumeMatchSchema", ackNotes: "ResumeMatchAck", cleanupOnJoinLikePaths: "none" },
  { event: "continue_as_spectator", direction: "C2S", handlerModule: "ReconnectCoordinator", zodSchema: "continueSpectatorSchema", ackNotes: "ResumeMatchAck", cleanupOnJoinLikePaths: "none" },
  { event: "ability_skill_boost", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "ignoredClientBodySchema", ackNotes: "AbilitySocketAck", cleanupOnJoinLikePaths: "none" },
  { event: "ability_skip_question", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "ignoredClientBodySchema", ackNotes: "AbilitySocketAck", cleanupOnJoinLikePaths: "none" },
  { event: "ability_heart_attack", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "abilityHeartAttackSchema", ackNotes: "AbilitySocketAck", cleanupOnJoinLikePaths: "none" },
  { event: "ability_reveal_keys", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: "ignoredClientBodySchema", ackNotes: "AbilitySocketAck", cleanupOnJoinLikePaths: "none" },
  { event: "create_private_room", direction: "C2S", handlerModule: "privateRoomSocketHandlers", zodSchema: "joinLessonFlexibleSchema + local", ackNotes: "{ ok, error?, message? }", cleanupOnJoinLikePaths: "none" },
  { event: "join_private_room", direction: "C2S", handlerModule: "privateRoomSocketHandlers", zodSchema: "local", ackNotes: "PrivateRoomMutationAck", cleanupOnJoinLikePaths: "none" },
  { event: "disconnect", direction: "C2S", handlerModule: "GameManager.attachSocket", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "disconnect_chain" },
  { event: "lobby_state", direction: "S2C", handlerModule: "GameManager.emit", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "none" },
  { event: "private_room_state", direction: "S2C", handlerModule: "GameManager.emitPrivateLobbyState", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "none" },
  { event: "game_started", direction: "S2C", handlerModule: "Match", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "none" },
  { event: "game_over", direction: "S2C", handlerModule: "Match", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "none" },
  { event: "match_resume_token", direction: "S2C", handlerModule: "Match / ReconnectCoordinator", zodSchema: null, ackNotes: "MatchResumeTokenWirePayload", cleanupOnJoinLikePaths: "none" },
  { event: "server_draining", direction: "S2C", handlerModule: "runtime", zodSchema: null, ackNotes: "n/a", cleanupOnJoinLikePaths: "none" },
] as const;
