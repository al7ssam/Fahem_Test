import { describe, expect, it, vi, afterEach } from "vitest";
import { fahemStructuredLog, isFahemDebugRealtime } from "./fahemStructuredLog";

describe("fahemStructuredLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("يطبع سطر JSON يحتوي svc و cat و event", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    fahemStructuredLog("info", { cat: "shutdown", event: "test_event", phase: "x" });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line.startsWith("[fahem] ")).toBe(true);
    const json = JSON.parse(line.slice("[fahem] ".length));
    expect(json.svc).toBe("fahem");
    expect(json.cat).toBe("shutdown");
    expect(json.event).toBe("test_event");
    expect(json.phase).toBe("x");
  });
});

describe("isFahemDebugRealtime", () => {
  const orig = process.env.FAHEM_DEBUG_REALTIME;

  afterEach(() => {
    if (orig === undefined) delete process.env.FAHEM_DEBUG_REALTIME;
    else process.env.FAHEM_DEBUG_REALTIME = orig;
  });

  it("true عندما FAHEM_DEBUG_REALTIME=1", () => {
    process.env.FAHEM_DEBUG_REALTIME = "1";
    expect(isFahemDebugRealtime()).toBe(true);
  });

  it("false عندما غير مضبوط", () => {
    delete process.env.FAHEM_DEBUG_REALTIME;
    expect(isFahemDebugRealtime()).toBe(false);
  });
});
