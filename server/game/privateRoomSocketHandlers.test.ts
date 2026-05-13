import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import type { PrivateRoomGameManagerFacade, PrivateRoomState, LobbyEntry } from "./GameManager";
import { registerPrivateRoomSocketHandlers } from "./privateRoomSocketHandlers";
import { Ack } from "../../shared/socketAckErrorCodes";

type SocketHandler = (raw: unknown, cb?: (ack: Record<string, unknown>) => void) => void | Promise<void>;

function makeSocketHarness(): {
  socket: Socket;
  handlers: Map<string, SocketHandler>;
} {
  const handlers = new Map<string, SocketHandler>();
  const stub = {
    id: "sock-join",
    data: {},
    on: (event: string, handler: SocketHandler) => {
      handlers.set(event, handler);
      return stub;
    },
    join: vi.fn(async () => undefined),
  };
  return { socket: stub as unknown as Socket, handlers };
}

function makeRoom(roomCode: string, matchStartTimer: ReturnType<typeof setTimeout> | null): PrivateRoomState {
  const host: LobbyEntry = {
    participantId: "host-pid",
    socketId: "host-socket",
    userId: null,
    playerSessionId: "host-session",
    name: "Host",
    ready: false,
    readyOrder: null,
    mode: "direct",
    subcategoryKey: null,
    lessonId: null,
    difficultyMode: "mix",
    roomCode,
  };
  return {
    roomCode,
    hostParticipantId: host.participantId,
    mode: "direct",
    subcategoryKey: null,
    lessonId: null,
    customLessonPlayback: null,
    customLessonToken: null,
    difficultyMode: "mix",
    settings: { questionMs: 15_000, studyPhaseMs: 60_000 },
    members: new Map([[host.participantId, host]]),
    lockedParticipantIds: [],
    countdownEndsAt: null,
    matchStartTimer,
    roomVersion: 1,
    teamPlayMode: "individual",
    heartsPerPlayer: 3,
    teamsLobby: null,
    lastActivityAt: Date.now(),
    postMatchExpiresAt: null,
    privateRoomMatchRunning: false,
  };
}

function makeFacade(privateRoom: PrivateRoomState): PrivateRoomGameManagerFacade {
  return {
    isDraining: () => false,
    resolvePlayerSessionId: () => "guest-session",
    allocateUniqueRoomCode: () => "ROOM01",
    leaveMatchForSocket: vi.fn(),
    leaveLobbyEverywhere: vi.fn(),
    removeFromPrivateRoom: vi.fn(),
    readUserId: () => null,
    privateRooms: new Map([[privateRoom.roomCode, privateRoom]]),
    socketToPrivateRoomCode: new Map<string, string>(),
    socketToPrivateParticipantId: new Map<string, string>(),
    privateLobbyRoom: (roomCode) => `lobby:private:${roomCode}`,
    emitPrivateLobbyState: vi.fn(),
    evictDuplicatePrivateMember: vi.fn(),
    io: {
      to: () => ({ emit: vi.fn() }),
    } as unknown as PrivateRoomGameManagerFacade["io"],
    tryStartPrivateRoom: vi.fn(async () => undefined),
    isPrivateRoomHost: () => false,
    shufflePrivateRoomTeams: vi.fn(),
    joinTeamForParticipant: () => ({ ok: true }),
    leaveTeamForParticipant: () => ({ ok: true }),
  };
}

describe("registerPrivateRoomSocketHandlers/join_private_room", () => {
  it("يرفض الانضمام أثناء العد التنازلي برسالة واضحة", async () => {
    const timer = setTimeout(() => undefined, 60_000);
    const room = makeRoom("ROOM42", timer);
    const facade = makeFacade(room);
    const { socket, handlers } = makeSocketHarness();
    registerPrivateRoomSocketHandlers(facade, socket);
    const joinHandler = handlers.get("join_private_room");
    expect(joinHandler).toBeTypeOf("function");

    let ack: Record<string, unknown> | null = null;
    await joinHandler?.({ name: "Guest", roomCode: "ROOM42" }, (payload) => {
      ack = payload;
    });
    clearTimeout(timer);

    expect(ack).toEqual({
      ok: false,
      error: Ack.countdown_started,
      message: "بدأ العد التنازلي بالفعل. انتظر الجولة التالية ثم انضم.",
    });
  });

  it("يعيد participantId في ack الانضمام الناجح", async () => {
    const room = makeRoom("ROOM77", null);
    const facade = makeFacade(room);
    const { socket, handlers } = makeSocketHarness();
    registerPrivateRoomSocketHandlers(facade, socket);
    const joinHandler = handlers.get("join_private_room");
    expect(joinHandler).toBeTypeOf("function");

    let ack: Record<string, unknown> | null = null;
    await joinHandler?.({ name: "Guest", roomCode: "ROOM77" }, (payload) => {
      ack = payload;
    });

    expect(ack?.ok).toBe(true);
    expect(typeof ack?.participantId).toBe("string");
    expect((ack?.participantId as string).length).toBeGreaterThan(10);
    expect(facade.socketToPrivateRoomCode.get("sock-join")).toBe("ROOM77");
    expect(facade.socketToPrivateParticipantId.get("sock-join")).toBe(ack?.participantId);
  });
});
