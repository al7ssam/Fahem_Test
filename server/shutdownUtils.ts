/**
 * أدوات إيقاف التشغيل — مهلة موحّدة لاستدعاءات الإغلاق (اختبارها من Vitest).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    to = setTimeout(() => reject(new Error(`${label}_timeout_after_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (to) clearTimeout(to);
  });
}

/** مهلة افتراضية لـ Render (غالباً ~10s قبل SIGKILL) — نترك هامشاً. */
export const DEFAULT_SHUTDOWN_BUDGET_MS = 8_000;

export function shutdownIoBudgetMs(): number {
  const raw = Number(process.env.FAHEM_SHUTDOWN_BUDGET_MS);
  if (Number.isFinite(raw) && raw >= 2_000 && raw <= 25_000) return Math.floor(raw);
  return DEFAULT_SHUTDOWN_BUDGET_MS;
}
