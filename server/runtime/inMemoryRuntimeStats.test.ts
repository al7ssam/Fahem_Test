import { describe, expect, it } from "vitest";
import { InMemoryRuntimeStats } from "./inMemoryRuntimeStats";

describe("InMemoryRuntimeStats", () => {
  it("يعدّ resume ok/fail حسب الحدث", () => {
    const s = new InMemoryRuntimeStats();
    s.recordReconnectPayload({ event: "resume_match_result", ok: true });
    s.recordReconnectPayload({ event: "resume_match_result", ok: false, error: "bad_token" });
    s.recordReconnectPayload({ event: "resume_match_result", ok: false, error: "bad_token" });
    const snap = s.snapshot();
    expect(snap.reconnect.resume.ok).toBe(1);
    expect(snap.reconnect.resume.fail.bad_token).toBe(2);
  });

  it("يعدّ spectator ok/fail", () => {
    const s = new InMemoryRuntimeStats();
    s.recordReconnectPayload({ event: "continue_spectator_result", ok: true });
    s.recordReconnectPayload({ event: "continue_spectator_result", ok: false, error: "no_match" });
    const snap = s.snapshot();
    expect(snap.reconnect.spectator.ok).toBe(1);
    expect(snap.reconnect.spectator.fail.no_match).toBe(1);
  });

  it("يتجاهل grace_started", () => {
    const s = new InMemoryRuntimeStats();
    s.recordReconnectPayload({ event: "grace_started", participantId: "p1" });
    expect(s.snapshot().reconnect.resume.ok).toBe(0);
  });

  it("started/ended", () => {
    const s = new InMemoryRuntimeStats();
    s.matchStarted();
    s.matchStarted();
    s.matchEnded();
    expect(s.snapshot().matches).toEqual({ started: 2, ended: 1 });
  });
});
