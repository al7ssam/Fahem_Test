import type { GameOverWirePayload } from "./gameOverPayload";
import type { MatchResumeTokenWirePayload } from "./matchResumeTokenWire";
import type { MatchReconnectSnapshot } from "./matchReconnectSnapshot";
import type { LobbyStateWirePayload, PrivateRoomStateWirePayload } from "./lobbyStateWire";
import type {
  AbilitySocketAck,
  PrivateRoomMutationAck,
  SimpleBooleanAck,
  StandardOkErrorAck,
  StartSoloMatchAck,
} from "./socketAcks";

/** أحداث بين الخوادم — غير مستخدمة حالياً. */
export interface InterServerEvents {}

/** بيانات إضافية على المقبس (مصادقة، ربط مباراة). */
export interface FahemSocketData {
  auth?: {
    userId: string;
    sessionId: string;
    roles: string[];
  };
  fahemMatchId?: string;
}

export interface ServerToClientEvents {
  server_draining: (payload: { serverNow: number; messageAr: string }) => void;
  release_updated: (payload: { releaseVersion: string; serverNow: number }) => void;
  lobby_state: (payload: LobbyStateWirePayload) => void;
  private_room_state: (payload: PrivateRoomStateWirePayload) => void;
  game_started: (payload: Record<string, unknown>) => void;
  game_over: (payload: GameOverWirePayload) => void;
  question: (payload: unknown) => void;
  question_result: (payload: unknown) => void;
  keys_room_state: (payload: unknown) => void;
  match_resume_token: (payload: MatchResumeTokenWirePayload) => void;
  match_starting: (payload: unknown) => void;
  match_start_cancelled: (payload: unknown) => void;
  study_phase: (payload: unknown) => void;
  study_phase_end: (payload: unknown) => void;
  round_ready_window: (payload: unknown) => void;
  round_ready_state: (payload: unknown) => void;
  round_ready_closed: (payload: unknown) => void;
  player_eliminated: (payload: unknown) => void;
  spectator_offer: (payload: unknown) => void;
  team_vote_update: (payload: unknown) => void;
  team_captain_changed: (payload: { teamId: string; captainParticipantId: string }) => void;
  team_answer_locked: (payload: unknown) => void;
  team_submitted: (payload: unknown) => void;
  ability_heart_resolved: (payload: unknown) => void;
}

export type ResumeMatchAck =
  | { ok: true; snapshot?: MatchReconnectSnapshot | null }
  | { ok: false; error?: string };

export interface ClientToServerEvents {
  join_lobby: (raw: unknown, cb?: (ack: StandardOkErrorAck) => void) => void;
  start_solo_match: (raw: unknown, cb?: (ack: StartSoloMatchAck) => void) => void;
  player_ready: (raw: unknown, cb?: (ack: StandardOkErrorAck) => void) => void;
  answer: (raw: unknown, cb?: (ack: SimpleBooleanAck) => void) => void;
  round_ready: (raw: unknown, cb?: (ack: SimpleBooleanAck) => void) => void;
  continue_as_spectator: (raw: unknown, cb?: (ack: ResumeMatchAck) => void) => void;
  resume_match: (raw: unknown, cb?: (ack: ResumeMatchAck) => void) => void;
  ability_skill_boost: (raw: unknown, cb?: (ack: AbilitySocketAck) => void) => void;
  ability_skip_question: (raw: unknown, cb?: (ack: AbilitySocketAck) => void) => void;
  ability_heart_attack: (raw: unknown, cb?: (ack: AbilitySocketAck) => void) => void;
  ability_reveal_keys: (raw: unknown, cb?: (ack: AbilitySocketAck) => void) => void;
  create_private_room: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  join_private_room: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_update_settings: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_set_ready: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_set_play_mode: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_set_hearts: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_set_desired_team_count: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_add_team: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_remove_team: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_shuffle_teams: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_lock_teams: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_admin_set_captain: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_join_team: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_leave_team: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
  private_room_update_team_name: (raw: unknown, cb?: (ack: PrivateRoomMutationAck) => void) => void;
}
