import type { Socket } from "socket.io-client";
import type { ServerDrainingPayload } from "@shared/socketContractsPhase1";

export type ServerDrainingSocketDeps = {
  getFlowToken: () => number;
  getSearchFlowToken: () => number;
  failBackToName: (msg: string) => void;
  disconnectSocket: () => void;
};

/** مستمع `server_draining` — يُفصل عن connectSocket لتقليل ازدحام main.ts. */
export function attachServerDrainingListener(s: Socket, deps: ServerDrainingSocketDeps): void {
  s.on("server_draining", (payload: ServerDrainingPayload) => {
    if (deps.getFlowToken() !== deps.getSearchFlowToken()) return;
    const msg =
      typeof payload?.messageAr === "string" && payload.messageAr.trim()
        ? payload.messageAr.trim()
        : "الخادم يُحدَّث. يرجى المحاولة بعد لحظات.";
    deps.failBackToName(msg);
    try {
      deps.disconnectSocket();
    } catch {
      /* ignore */
    }
  });
}
