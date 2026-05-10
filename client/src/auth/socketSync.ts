import type { Socket } from "socket.io-client";
import { getAuthState, subscribeAuthState } from "./authStore";

type SocketAccessor = () => Socket | null;
type SocketReset = () => void;

let detach: (() => void) | null = null;

export function attachSocketAuthSync(getSocket: SocketAccessor, resetSocket: SocketReset): () => void {
  detach?.();
  const applyAuthToSocket = (state: ReturnType<typeof getAuthState>): void => {
    const socket = getSocket();
    if (!socket) return;
    if (state.status !== "authenticated") {
      socket.removeAllListeners();
      socket.disconnect();
      resetSocket();
    }
  };
  applyAuthToSocket(getAuthState());
  detach = subscribeAuthState(applyAuthToSocket);
  return () => {
    detach?.();
    detach = null;
  };
}
