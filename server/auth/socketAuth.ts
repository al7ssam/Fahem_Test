import type { Socket } from "socket.io";
import type {
  ClientToServerEvents,
  FahemSocketData,
  InterServerEvents,
  ServerToClientEvents,
} from "../../shared/socketEvents";
import { authService } from "./AuthService";

export type SocketAuthContext = {
  userId: string;
  sessionId: string;
  roles: string[];
};

function readSocketBearer(socket: Socket): string | null {
  const authToken = String((socket.handshake.auth as { accessToken?: unknown } | undefined)?.accessToken ?? "").trim();
  if (authToken) return authToken;
  const header = String(socket.handshake.headers.authorization ?? "").trim();
  if (header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return null;
}

export async function authenticateSocket(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, FahemSocketData>,
  next: (err?: Error) => void,
): Promise<void> {
  try {
    const token = readSocketBearer(socket);
    if (!token) {
      delete (socket.data as { auth?: SocketAuthContext }).auth;
      next();
      return;
    }
    const user = await authService.verifyAccessToken(token);
    socket.data.auth = {
      userId: user.userId,
      sessionId: user.sessionId,
      roles: user.roles,
    } satisfies SocketAuthContext;
    next();
  } catch {
    next(new Error("unauthorized"));
  }
}
