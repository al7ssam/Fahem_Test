import { describe, expect, it } from "vitest";
import { withTimeout, shutdownIoBudgetMs } from "./shutdownUtils";

describe("withTimeout", () => {
  it("resolves when inner promise resolves quickly", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "test_ok");
    expect(v).toBe(42);
  });

  it("rejects when promise exceeds deadline", async () => {
    await expect(
      withTimeout(new Promise((r) => setTimeout(r, 50_000)), 20, "test_slow"),
    ).rejects.toThrow(/test_slow_timeout/);
  });
});

describe("shutdownIoBudgetMs", () => {
  it("returns default when env unset", () => {
    delete process.env.FAHEM_SHUTDOWN_BUDGET_MS;
    expect(shutdownIoBudgetMs()).toBe(8_000);
  });
});
