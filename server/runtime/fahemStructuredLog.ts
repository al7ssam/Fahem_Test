/** فئات سجل ثابتة — لا تُغيّر أسماء القيم دون تحديث الاستعلامات/اللوحات لاحقاً. */
export type FahemLogCat =
  | "reconnect"
  | "shutdown"
  | "match"
  | "matchmaking"
  | "runtime"
  | "private_room";

export type FahemLogLevel = "info" | "warn" | "error";

const LEVEL_FN: Record<FahemLogLevel, (msg: string) => void> = {
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export type FahemStructuredFields = Record<string, unknown> & {
  cat: FahemLogCat;
  event: string;
};

/** سطر JSON واحد مع بادئة `[fahem]` للgrep — بدون أسرار أو توكنات في الحقول الافتراضية. */
export function fahemStructuredLog(level: FahemLogLevel, fields: FahemStructuredFields): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tsMs: Date.now(),
      svc: "fahem",
      ...fields,
    });
    LEVEL_FN[level](`[fahem] ${line}`);
  } catch {
    /* تجاهل أخطاء تسلسل نادرة */
  }
}

export function isFahemDebugRealtime(): boolean {
  return String(process.env.FAHEM_DEBUG_REALTIME ?? "").trim() === "1";
}
