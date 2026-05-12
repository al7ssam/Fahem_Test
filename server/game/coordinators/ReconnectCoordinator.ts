import type { Socket } from "socket.io";
import { resumeMatchSchema, continueSpectatorSchema } from "../socketSchemas";
import { MATCH_RECONNECT_GRACE_MS } from "../reconnectConfig";
import type { Match } from "../Match";
import { matchReconnectSnapshotSchema } from "../../../shared/matchReconnectSnapshot";
import { Ack } from "../../../shared/socketAckErrorCodes";
import { fahemStructuredLog } from "../../runtime/fahemStructuredLog";

export type ReconnectSocketDeps = {
  isDraining: () => boolean;
  logReconnectEvent: (p: Record<string, unknown>) => void;
  checkResumeMatchRateLimit: (socketId: string) => boolean;
  clearPendingReconnect: (participantId: string, source?: string) => void;
  getParticipantIdToSocket: () => Map<string, string>;
  clearSocketMatchBinding: (socketId: string) => void;
  disconnectSocket: (socketId: string) => void;
  tagSocketMatchBinding: (socketId: string, matchId: string) => void;
  setSocketToParticipant: (socketId: string, participantId: string) => void;
  setParticipantToSocket: (participantId: string, socketId: string) => void;
  setParticipantToMatch: (participantId: string, match: Match) => void;
  deleteSocketToParticipant: (socketId: string) => void;
  getRunningMatch: (matchId: string) => Match | undefined;
  getParticipantIdToMatch: (participantId: string) => Match | undefined;
  getSocketToParticipant: (socketId: string) => string | undefined;
  getSocketDataMatchId: (socket: Socket) => string | undefined;
};

export function attachReconnectSocketHandlers(deps: ReconnectSocketDeps, socket: Socket): void {
  socket.on("continue_as_spectator", async (raw, cb) => {
    const logBase: Record<string, unknown> = { socketId: socket.id, event: "continue_spectator_result" };
    try {
      if (deps.isDraining()) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.server_draining });
        cb?.({ ok: false, error: Ack.server_draining });
        return;
      }
      const parsed = continueSpectatorSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.invalid_body });
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      let participantId = parsed.data.participantId;
      const mid = deps.getSocketDataMatchId(socket);
      const match = mid ? deps.getRunningMatch(mid) : undefined;
      if (!match || match.isFinished()) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.no_match, matchId: mid });
        cb?.({ ok: false, error: Ack.no_match });
        return;
      }
      if (!participantId) {
        participantId = deps.getSocketToParticipant(socket.id);
      }
      if (!participantId || deps.getParticipantIdToMatch(participantId) !== match) {
        deps.logReconnectEvent({
          ...logBase,
          ok: false,
          error: Ack.unknown_seat,
          matchId: match.matchId,
          participantId: participantId ?? null,
        });
        cb?.({ ok: false, error: Ack.unknown_seat });
        return;
      }
      if (!match.canContinueAsSpectator(participantId)) {
        deps.logReconnectEvent({
          ...logBase,
          ok: false,
          error: Ack.not_spectator,
          matchId: match.matchId,
          participantId,
        });
        cb?.({ ok: false, error: Ack.not_spectator });
        return;
      }
      match.syncParticipantSocket(participantId, socket.id);
      await socket.join(match.room);
      match.emitKeysRoomStateToSocketForParticipant(socket.id, participantId);
      const snapshot = match.buildMatchStateSnapshot(participantId);
      deps.logReconnectEvent({
        ...logBase,
        ok: true,
        matchId: match.matchId,
        participantId,
      });
      cb?.({ ok: true, snapshot: snapshot ?? null });
    } catch {
      deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.server });
      cb?.({ ok: false, error: Ack.server });
    }
  });

  socket.on("resume_match", async (raw, cb) => {
    const logBase: Record<string, unknown> = { socketId: socket.id, event: "resume_match_result" };
    try {
      if (deps.isDraining()) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.server_draining });
        cb?.({ ok: false, error: Ack.server_draining });
        return;
      }
      if (!deps.checkResumeMatchRateLimit(socket.id)) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.rate_limited });
        cb?.({ ok: false, error: Ack.rate_limited });
        return;
      }
      const parsed = resumeMatchSchema.safeParse(raw);
      if (!parsed.success) {
        deps.logReconnectEvent({ ...logBase, ok: false, error: Ack.invalid_body });
        cb?.({ ok: false, error: Ack.invalid_body });
        return;
      }
      const { matchId, participantId, resumeSecret } = parsed.data;
      const match = deps.getRunningMatch(matchId);
      if (!match || match.isFinished()) {
        deps.logReconnectEvent({ ...logBase, participantId, matchId, ok: false, error: Ack.no_match });
        cb?.({ ok: false, error: Ack.no_match });
        return;
      }
      if (!match.allowsTransportReconnect()) {
        deps.logReconnectEvent({
          ...logBase,
          participantId,
          matchId,
          ok: false,
          error: Ack.solo_no_transport_reconnect,
        });
        cb?.({ ok: false, error: Ack.solo_no_transport_reconnect });
        return;
      }
      if (deps.getParticipantIdToMatch(participantId) !== match) {
        deps.logReconnectEvent({ ...logBase, participantId, matchId, ok: false, error: Ack.seat_not_in_match });
        cb?.({ ok: false, error: Ack.seat_not_in_match });
        return;
      }
      if (!match.verifyResumeSecret(participantId, resumeSecret)) {
        deps.logReconnectEvent({ ...logBase, participantId, matchId, ok: false, error: Ack.bad_token });
        cb?.({ ok: false, error: Ack.bad_token });
        return;
      }
      if (!match.canResumeTransport(participantId)) {
        deps.logReconnectEvent({ ...logBase, participantId, matchId, ok: false, error: Ack.cannot_resume });
        cb?.({ ok: false, error: Ack.cannot_resume });
        return;
      }
      deps.clearPendingReconnect(participantId, "resume_match");
      const prevSid = deps.getParticipantIdToSocket().get(participantId);
      if (prevSid && prevSid !== socket.id) {
        deps.deleteSocketToParticipant(prevSid);
        deps.clearSocketMatchBinding(prevSid);
        deps.disconnectSocket(prevSid);
      }
      match.syncParticipantSocket(participantId, socket.id);
      deps.setSocketToParticipant(socket.id, participantId);
      deps.setParticipantToSocket(participantId, socket.id);
      deps.setParticipantToMatch(participantId, match);
      deps.tagSocketMatchBinding(socket.id, match.matchId);
      await socket.join(match.room);
      match.emitCaptainTeamVoteResyncToRoom();
      const newSecret = match.rotateResumeSecret(participantId);
      if (newSecret && match.allowsTransportReconnect()) {
        const expiresAt = Date.now() + MATCH_RECONNECT_GRACE_MS;
        socket.emit("match_resume_token", {
          matchId: match.matchId,
          participantId,
          resumeSecret: newSecret,
          reconnectGraceMs: MATCH_RECONNECT_GRACE_MS,
          expiresAt,
        });
      }
      const snapshot = match.buildMatchStateSnapshot(participantId);
      if (snapshot != null) {
        const snapOk = matchReconnectSnapshotSchema.safeParse(snapshot);
        if (!snapOk.success) {
          fahemStructuredLog("warn", {
            cat: "reconnect",
            event: "resume_match_snapshot_invalid",
            socketId: socket.id,
            participantId,
            matchId,
            flatten: snapOk.error.flatten(),
          });
        }
      }
      deps.logReconnectEvent({ ...logBase, participantId, matchId, ok: true });
      cb?.({ ok: true, snapshot: snapshot ?? null });
    } catch {
      deps.logReconnectEvent({
        socketId: socket.id,
        event: "resume_match_result",
        ok: false,
        error: Ack.server,
      });
      cb?.({ ok: false, error: Ack.server });
    }
  });
}
