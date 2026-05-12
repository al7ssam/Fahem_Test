import { escapeHtml, el } from "../utils";
import type { Phase } from "../types";
import type { SavedLessonSummary } from "../savedLessonsApi";

export type SavedLessonsLibraryScreenDeps = {
  getSavedLessonsRows: () => SavedLessonSummary[];
  getSavedLessonsLoading: () => boolean;
  getSavedLessonsLibraryErr: () => string;
  savedLessonLibraryIconDisplay: (icon: string | null | undefined) => string;
  savedLessonExpiryCaption: (expiresAtIso: string) => string;
  setPhase: (p: Phase) => void;
  setSavedLessonDetailId: (id: string | null) => void;
  setSavedLessonsLibraryErr: (msg: string) => void;
  render: () => void;
};

export function renderSavedLessonsLibraryScreen(deps: SavedLessonsLibraryScreenDeps): void {
  const rows = deps.getSavedLessonsRows()
    .map(
      (row) => `
      <button type="button" class="app-card rounded-lg border border-slate-600/40 flex flex-row items-center gap-2.5 p-2 min-h-0 w-full text-right touch-manipulation ssl-open-detail transition active:scale-[0.98] hover:border-amber-700/35" data-id="${escapeHtml(row.id)}" aria-label="فتح ${escapeHtml(row.title)}">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-slate-800/55 border border-slate-600/30 text-2xl leading-none select-none pointer-events-none" aria-hidden="true">${deps.savedLessonLibraryIconDisplay(row.libraryIcon)}</span>
        <span class="flex min-h-0 min-w-0 flex-1 flex-col items-stretch justify-center gap-0.5 pointer-events-none text-right">
          <span class="font-semibold text-amber-200 text-[11px] leading-snug line-clamp-2">${escapeHtml(row.title)}</span>
          <span class="text-slate-500 text-[9px] leading-tight line-clamp-1">${escapeHtml(deps.savedLessonExpiryCaption(row.expiresAt))}</span>
        </span>
      </button>`,
    )
    .join("");
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.append(
    el(`
      <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3 text-right">
        <div class="flex items-center justify-between gap-2">
          <button type="button" id="ssl-back-custom" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">درس مخصص</button>
          <h1 class="text-xl font-extrabold text-amber-300 m-0">مكتبة دروسي</h1>
        </div>
        <p class="text-slate-400 text-sm m-0">دروسك المحفوظة في حسابك بعد تسجيل الدخول. اضغط على درس لعرض الخيارات.</p>
        ${deps.getSavedLessonsLoading() ? `<p class="text-slate-400 text-sm m-0">جاري التحميل…</p>` : ""}
        ${deps.getSavedLessonsLibraryErr() ? `<p class="text-red-400 text-sm m-0">${escapeHtml(deps.getSavedLessonsLibraryErr())}</p>` : ""}
        ${
          !deps.getSavedLessonsLoading() && !deps.getSavedLessonsLibraryErr() && deps.getSavedLessonsRows().length === 0
            ? `<p class="text-slate-500 text-sm m-0">لا توجد دروس محفوظة بعد.</p>`
            : ""
        }
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 content-start items-start flex-1 overflow-y-auto min-h-0">${rows}</div>
      </div>
    `),
  );
  app.querySelector("#ssl-back-custom")?.addEventListener("click", () => {
    deps.setPhase("custom_lesson");
    deps.render();
  });
  for (const btn of app.querySelectorAll<HTMLButtonElement>(".ssl-open-detail")) {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      if (!id) return;
      deps.setSavedLessonDetailId(id);
      deps.setSavedLessonsLibraryErr("");
      deps.setPhase("saved_lesson_detail");
      deps.render();
    });
  }
}
