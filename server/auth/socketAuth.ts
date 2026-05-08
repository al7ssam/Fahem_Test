import type { Socket } from "socket.io";
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

export async function authenticateSocket(socket: Socket, next: (err?: Error) => void): Promise<void> {
  try {
    const token = readSocketBearer(socket);
    if (!token) {
      next(new Error("unauthorized"));
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
