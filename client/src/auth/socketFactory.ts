import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@shared/socketEvents";
import { getAuthTokens } from "./authClient";

export function createAuthedSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  const accessToken = getAuthTokens()?.accessToken?.trim() ?? "";
  return io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
    autoConnect: false,
    ...(accessToken ? { auth: { accessToken } } : {}),
  });
}
