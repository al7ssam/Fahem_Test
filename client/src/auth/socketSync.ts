import type { Socket } from "socket.io-client";
import { subscribeAuthState } from "./authStore";

type SocketAccessor = () => Socket | null;
type SocketReset = () => void;

let detach: (() => void) | null = null;

export function attachSocketAuthSync(getSocket: SocketAccessor, resetSocket: SocketReset): () => void {
  detach?.();
  detach = subscribeAuthState((state) => {
    const socket = getSocket();
    if (!socket) return;
    if (state.status !== "authenticated") {
      socket.removeAllListeners();
      socket.disconnect();
      resetSocket();
    }
  });
  return () => {
    detach?.();
    detach = null;
  };
}
