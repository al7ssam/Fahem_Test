import type { Socket } from "socket.io-client";
import { coerceReconnectSnapshotForUi, sleepMs } from "./matchReconnect";

export type ResumeMatchStoredRow = {
  matchId: string;
  participantId: string;
  resumeSecret: string;
  expiresAt: number;
};

export type ResumeMatchAfterConnectDeps = {
  getSearchFlowToken: () => number;
  readStoredMatchResume: () => ResumeMatchStoredRow | null;
  clearReconnectMultiplayerRuntime: () => void;
  setReconnectAttemptInFlight: (inFlight: boolean) => void;
  applyReconnectSnapshot: (socket: Socket, snapshot: Record<string, unknown>) => void;
};

/**
 * backoff + ack + إلغاء عبر flowToken — نفس المهلة 9s وجدول المحاولات حرفياً.
 */
export async function tryResumeMatchAfterConnect(
  deps: ResumeMatchAfterConnectDeps,
  s: Socket,
  flowToken: number,
): Promise<boolean> {
  const raw = deps.readStoredMatchResume();
  if (!raw) return false;
  if (Date.now() > raw.expiresAt) {
    deps.clearReconnectMultiplayerRuntime();
    return false;
  }
  deps.setReconnectAttemptInFlight(true);
  try {
    const backoffMs = [0, 500, 1000, 2000, 2000];
    for (let attempt = 0; attempt < backoffMs.length; attempt++) {
      if (attempt > 0) await sleepMs(backoffMs[attempt]!);
      const outcome = await new Promise<"ok" | "retry" | "fail">((resolve) => {
        const to = window.setTimeout(() => resolve("retry"), 9000);
        s.emit(
          "resume_match",
          {
            matchId: raw.matchId,
            participantId: raw.participantId,
            resumeSecret: raw.resumeSecret,
          },
          (ack: { ok?: boolean; error?: string; snapshot?: Record<string, unknown> | null } | undefined) => {
            window.clearTimeout(to);
            if (flowToken !== deps.getSearchFlowToken()) {
              resolve("fail");
              return;
            }
            if (!ack?.ok) {
              if (ack?.error === "rate_limited") {
                resolve("retry");
                return;
              }
              deps.clearReconnectMultiplayerRuntime();
              resolve("fail");
              return;
            }
            if (!ack.snapshot || typeof ack.snapshot !== "object") {
              deps.clearReconnectMultiplayerRuntime();
              resolve("fail");
              return;
            }
            deps.applyReconnectSnapshot(s, coerceReconnectSnapshotForUi(ack.snapshot));
            resolve("ok");
          },
        );
      });
      if (outcome === "ok") return true;
      if (outcome === "fail") return false;
    }
    deps.clearReconnectMultiplayerRuntime();
    return false;
  } finally {
    deps.setReconnectAttemptInFlight(false);
  }
}
