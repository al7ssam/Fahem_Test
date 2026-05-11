import { io, type Socket } from "socket.io-client";
import { getAuthTokens } from "./authClient";

export function createAuthedSocket(): Socket {
  const accessToken = getAuthTokens()?.accessToken?.trim() ?? "";
  return io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
    ...(accessToken ? { auth: { accessToken } } : {}),
  });
}
