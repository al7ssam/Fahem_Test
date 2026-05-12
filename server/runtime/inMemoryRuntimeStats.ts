/** عدّادات عملية في الذاكرة (عقدة واحدة) — تُعرض في /health/realtime. */

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export class InMemoryRuntimeStats {
  reconnectResumeOk = 0;
  readonly reconnectResumeFail = new Map<string, number>();
  reconnectSpectatorOk = 0;
  readonly reconnectSpectatorFail = new Map<string, number>();
  matchesStarted = 0;
  matchesEnded = 0;
  matchmakingSoloRunUnhandled = 0;
  matchmakingSoloOuterFatal = 0;
  matchmakingPrivateRoomRunUnhandled = 0;
  matchmakingLobbyRunUnhandled = 0;

  recordReconnectPayload(payload: Record<string, unknown>): void {
    const event = payload.event;
    const ok = payload.ok === true;
    const err = typeof payload.error === "string" ? payload.error : "unknown";
    if (event === "resume_match_result") {
      if (ok) this.reconnectResumeOk += 1;
      else bump(this.reconnectResumeFail, err);
      return;
    }
    if (event === "continue_spectator_result") {
      if (ok) this.reconnectSpectatorOk += 1;
      else bump(this.reconnectSpectatorFail, err);
    }
  }

  matchStarted(): void {
    this.matchesStarted += 1;
  }

  matchEnded(): void {
    this.matchesEnded += 1;
  }

  failMapToRecord(m: Map<string, number>): Record<string, number> {
    return Object.fromEntries([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
  }

  snapshot(): {
    reconnect: {
      resume: { ok: number; fail: Record<string, number> };
      spectator: { ok: number; fail: Record<string, number> };
    };
    matches: { started: number; ended: number };
    matchmaking: {
      soloRunUnhandled: number;
      soloOuterFatal: number;
      privateRoomRunUnhandled: number;
      lobbyRunUnhandled: number;
    };
  } {
    return {
      reconnect: {
        resume: { ok: this.reconnectResumeOk, fail: this.failMapToRecord(this.reconnectResumeFail) },
        spectator: {
          ok: this.reconnectSpectatorOk,
          fail: this.failMapToRecord(this.reconnectSpectatorFail),
        },
      },
      matches: { started: this.matchesStarted, ended: this.matchesEnded },
      matchmaking: {
        soloRunUnhandled: this.matchmakingSoloRunUnhandled,
        soloOuterFatal: this.matchmakingSoloOuterFatal,
        privateRoomRunUnhandled: this.matchmakingPrivateRoomRunUnhandled,
        lobbyRunUnhandled: this.matchmakingLobbyRunUnhandled,
      },
    };
  }
}
