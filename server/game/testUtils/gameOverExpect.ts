import { expect } from "vitest";
import { safeParseGameOverWire } from "../../../shared/gameOverPayload";

/** يتأكد أن الحمولة تمر عبر Zod دون فرض شكل كامل على الحقول الإضافية. */
export function expectGameOverParses(payload: unknown): void {
  const r = safeParseGameOverWire(payload);
  expect(r.success, r.success ? "" : JSON.stringify(r.error.flatten())).toBe(true);
}
