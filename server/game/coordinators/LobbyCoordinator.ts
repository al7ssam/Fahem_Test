import type { Socket } from "socket.io";
import { randomUUID } from "crypto";
import { Ack } from "../../../shared/socketAckErrorCodes";
import { joinLobbySchema } from "../socketSchemas";
import type { GameMode } from "../Match";
import type { DifficultyMode } from "../Match";
import type { LobbyEntry } from "../GameManager";

/**
 * اعتمادات أحداث اللوبي العام — تُبنى داخل GameManager لتمرير مراجع ضيقة دون كشف خرائط كاملة.
 */
export type LobbySocketDeps = {
  isDraining: () => boolean;
  resolvePlayerSessionId: (raw: unknown, socketId: string) => string;
  evictDuplicateLobbySocket: (
    incomingSocket: Socket,
    playerSessionId: string,
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ) => void;
  leaveMatchForSocket: (socketId: string) => void;
  leaveLobbyEverywhere: (socketId: string) => void;
  removeFromPrivateRoom: (socketId: string) => void;
  readUserId: (socket: Socket) => string | null;
  takeNextReadyOrder: () => number;
  setLobbyEntry: (mode: GameMode, participantId: string, entry: LobbyEntry) => void;
  setPublicLobbyRef: (socketId: string, ref: { mode: GameMode; participantId: string }) => void;
  joinLobbyRoom: (
    socket: Socket,
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ) => Promise<void>;
  broadcastLobby: (
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ) => void;
  buildLobbyPayload: (
    mode: GameMode,
    subcategoryKey?: string | null,
    difficultyMode?: DifficultyMode,
    lessonId?: number | null,
  ) => unknown;
  emitLobbyStateToSocket: (
    socket: Socket,
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ) => void;
  enqueueScheduleMatchStart: (
    mode: GameMode,
    subcategoryKey: string | null,
    difficultyMode: DifficultyMode,
    lessonId: number | null,
  ) => void;
  findLobbyEntry: (socketId: string) => LobbyEntry | undefined;
};

export function attachJoinLobbySocketHandler(deps: LobbySocketDeps, socket: Socket): void {
  socket.on("join_lobby", async (raw, cb) => {
    if (deps.isDraining()) {
      cb?.({ ok: false, error: Ack.server_draining });
      return;
    }
    try {
      const parsed = joinLobbySchema.safeParse(raw);
      if (!parsed.success) {
        cb?.({ ok: false, error: Ack.invalid_name });
        return;
      }
      const { name, mode } = parsed.data;
      const playerSessionId = deps.resolvePlayerSessionId(
        { ...(raw as Record<string, unknown>), __authUserId: socket.data?.auth?.userId },
        socket.id,
      );
      const difficultyMode = parsed.data.difficultyMode ?? "mix";
      const subcategoryKey =
        mode === "study_then_quiz"
          ? String(parsed.data.subcategoryKey ?? "general_default").trim()
          : null;
      const lessonId = mode === "lesson" ? (parsed.data.lessonId ?? null) : null;
      deps.evictDuplicateLobbySocket(socket, playerSessionId, mode, subcategoryKey, difficultyMode, lessonId);
      deps.leaveMatchForSocket(socket.id);
      deps.leaveLobbyEverywhere(socket.id);
      deps.removeFromPrivateRoom(socket.id);
      const participantId = randomUUID();
      const userId = deps.readUserId(socket);
      const entry: LobbyEntry = {
        participantId,
        socketId: socket.id,
        userId,
        playerSessionId,
        name,
        ready: true,
        readyOrder: deps.takeNextReadyOrder(),
        mode,
        subcategoryKey,
        lessonId,
        difficultyMode,
      };
      deps.setLobbyEntry(mode, participantId, entry);
      deps.setPublicLobbyRef(socket.id, { mode, participantId });
      await deps.joinLobbyRoom(socket, mode, subcategoryKey, difficultyMode, lessonId);
      deps.broadcastLobby(mode, subcategoryKey, difficultyMode, lessonId);
      deps.emitLobbyStateToSocket(socket, mode, subcategoryKey, difficultyMode, lessonId);
      deps.enqueueScheduleMatchStart(mode, subcategoryKey, difficultyMode, lessonId);
      cb?.({ ok: true });
    } catch {
      cb?.({ ok: false, error: Ack.server });
    }
  });
}

export function attachPlayerReadySocketHandler(deps: LobbySocketDeps, socket: Socket): void {
  socket.on("player_ready", (_payload, cb) => {
    const entry = deps.findLobbyEntry(socket.id);
    if (!entry) {
      cb?.({ ok: false, error: Ack.not_in_lobby });
      return;
    }
    if (!entry.ready) {
      entry.ready = true;
      entry.readyOrder = deps.takeNextReadyOrder();
    }
    deps.broadcastLobby(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId);
    deps.enqueueScheduleMatchStart(entry.mode, entry.subcategoryKey, entry.difficultyMode, entry.lessonId);
    cb?.({ ok: true });
  });
}
