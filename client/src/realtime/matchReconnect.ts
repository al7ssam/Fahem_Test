import { safeParseMatchReconnectSnapshot } from "@shared/matchReconnectSnapshot";

export async function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

/** يُحكَم اللقطة عند الاستئناف؛ عند الفشل يُرجَع الشكل الخام لتفادي كسر اللاعبين. */
export function coerceReconnectSnapshotForUi(snap: unknown): Record<string, unknown> {
  const p = safeParseMatchReconnectSnapshot(snap);
  if (p.success) return p.data as unknown as Record<string, unknown>;
  console.warn("[client] reconnect_snapshot_parse_failed", p.error.flatten());
  return typeof snap === "object" && snap !== null ? (snap as Record<string, unknown>) : {};
}
