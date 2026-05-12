/**
 * عدّ تنازلي لوبي (#cd) — ملكية المؤقت داخل المتحكم فقط.
 */

export type LobbyCountdownDeps = {
  getCdElement: () => HTMLDivElement | null;
  tickMs?: number;
};

export function createLobbyCountdownController(deps: LobbyCountdownDeps): {
  start: (initialLeft: number) => void;
  clear: () => void;
} {
  let cdInterval: number | null = null;
  const tickMs = deps.tickMs ?? 1000;

  const clear = (): void => {
    if (cdInterval != null) {
      window.clearInterval(cdInterval);
      cdInterval = null;
    }
  };

  const start = (initialLeft: number): void => {
    clear();
    let left = Math.max(1, Math.floor(initialLeft));
    const cd = deps.getCdElement();
    const show = (): void => {
      if (cd) cd.textContent = String(left);
    };
    show();
    cdInterval = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clear();
      } else {
        show();
      }
    }, tickMs);
  };

  return { start, clear };
}
