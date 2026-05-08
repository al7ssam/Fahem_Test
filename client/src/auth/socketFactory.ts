import { io, type Socket } from "socket.io-client";
import { getAuthTokens } from "./authClient";

export function createAuthedSocket(): Socket {
  const accessToken = getAuthTokens()?.accessToken ?? "";
  return io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
    auth: { accessToken },
  });
}
