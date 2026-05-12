import { escapeHtml, el } from "../utils";
import type { Phase } from "../types";

type EditPayload = Record<string, unknown>;

export type SavedLessonEditScreenDeps = {
  getSavedLessonEditingId: () => string | null;
  getSavedLessonEditorPayload: () => EditPayload | null;
  getSavedLessonLibraryIcon: () => string | null;
  getSavedLessonEditorErr: () => string;
  getSavedLessonEditorMsg: () => string;
  setSavedLessonLibraryIcon: (v: string | null) => void;
  setSavedLessonDetailId: (v: string | null) => void;
  setSavedLessonEditorPayload: (p: EditPayload | null) => void;
  setSavedLessonEditorErr: (msg: string) => void;
  setSavedLessonEditorMsg: (msg: string) => void;
  setSavedLessonEditingId: (id: string | null) => void;
  setSavedLessonsLoading: (v: boolean) => void;
  setSavedLessonsRows: (rows: unknown[]) => void;
  renderSavedLessonEditorMarkup: (payload: EditPayload, icon: string | null) => string;
  removeSectionFromPayload: (payload: EditPayload, si: number) => { ok: boolean; error?: string; payload?: EditPayload };
  removeQuestionFromPayload: (payload: EditPayload, si: number, qi: number) => { ok: boolean; error?: string; payload?: EditPayload };
  collectSavedLessonPayloadFromEditor: (root: HTMLElement) => { ok: boolean; error?: string; payload?: EditPayload };
  readLibraryIconFromEditor: (root: HTMLElement) => string | null;
  patchSavedLesson: (id: string, data: { payload: EditPayload; libraryIcon: string | null }) => Promise<{ ok: boolean }>;
  fetchSavedLessonsList: () => Promise<{ ok: boolean; lessons?: unknown[] }>;
  setPhase: (p: Phase) => void;
  render: () => void;
};

export function renderSavedLessonEditScreen(deps: SavedLessonEditScreenDeps): void {
  const editingId = deps.getSavedLessonEditingId();
  const editorPayload = deps.getSavedLessonEditorPayload();
  if (!editingId || !editorPayload) {
    deps.setSavedLessonLibraryIcon(null);
    deps.setSavedLessonDetailId(null);
    deps.setPhase("saved_lessons_library");
    deps.render();
    return;
  }
  const markup = deps.renderSavedLessonEditorMarkup(editorPayload, deps.getSavedLessonLibraryIcon());
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.append(
    el(`
      <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3 text-right pb-28">
        <div class="flex items-center justify-between gap-2">
          <button type="button" id="sle-back-lib" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">المكتبة</button>
          <h1 class="text-lg font-extrabold text-amber-300 m-0">تعديل الدرس</h1>
        </div>
        ${markup}
        <p id="sle-editor-msg" class="text-emerald-300 text-sm min-h-[1.25rem] m-0">${escapeHtml(deps.getSavedLessonEditorMsg())}</p>
        <p id="sle-editor-err" class="text-red-400 text-sm min-h-[1.25rem] m-0">${escapeHtml(deps.getSavedLessonEditorErr())}</p>
        <button type="button" id="sle-save" class="ui-btn ui-btn--cta w-full py-3 shrink-0">حفظ التعديلات</button>
      </div>
    `),
  );
  app.querySelectorAll<HTMLButtonElement>(".sle-del-sec").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const payload = deps.getSavedLessonEditorPayload();
      if (!payload) return;
      const si = Number(btn.dataset.sectionIndex);
      if (!Number.isFinite(si)) return;
      if (!window.confirm("حذف هذا القسم وجميع أسئلته؟ يمكنك التراجع قبل الضغط على «حفظ التعديلات».")) return;
      const res = deps.removeSectionFromPayload(payload, si);
      if (!res.ok) {
        deps.setSavedLessonEditorErr(res.error ?? "");
        deps.setSavedLessonEditorMsg("");
        deps.render();
        return;
      }
      deps.setSavedLessonEditorPayload(res.payload);
      deps.setSavedLessonEditorErr("");
      deps.setSavedLessonEditorMsg("");
      deps.render();
    });
  });
  app.querySelectorAll<HTMLButtonElement>(".sle-del-q").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const payload = deps.getSavedLessonEditorPayload();
      if (!payload) return;
      const si = Number(btn.dataset.sectionIndex);
      const qi = Number(btn.dataset.itemIndex);
      if (!Number.isFinite(si) || !Number.isFinite(qi)) return;
      if (!window.confirm("حذف هذا السؤال؟")) return;
      const res = deps.removeQuestionFromPayload(payload, si, qi);
      if (!res.ok) {
        deps.setSavedLessonEditorErr(res.error ?? "");
        deps.setSavedLessonEditorMsg("");
        deps.render();
        return;
      }
      deps.setSavedLessonEditorPayload(res.payload);
      deps.setSavedLessonEditorErr("");
      deps.setSavedLessonEditorMsg("");
      deps.render();
    });
  });
  const iconInput = app.querySelector<HTMLInputElement>("#sle-library-icon");
  app.querySelectorAll<HTMLButtonElement>(".sle-lib-icon-preset").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const ic = btn.dataset.libIcon;
      if (iconInput && ic != null) iconInput.value = ic;
    });
  });
  app.querySelector("#sle-back-lib")?.addEventListener("click", () => {
    deps.setPhase("saved_lessons_library");
    deps.setSavedLessonEditingId(null);
    deps.setSavedLessonEditorPayload(null);
    deps.setSavedLessonLibraryIcon(null);
    deps.setSavedLessonDetailId(null);
    deps.setSavedLessonEditorErr("");
    deps.setSavedLessonEditorMsg("");
    void (async () => {
      deps.setSavedLessonsLoading(true);
      deps.render();
      const r = await deps.fetchSavedLessonsList();
      deps.setSavedLessonsLoading(false);
      if (r.ok) deps.setSavedLessonsRows(r.lessons ?? []);
      deps.render();
    })();
  });
  app.querySelector("#sle-save")?.addEventListener("click", async () => {
    const rootEl = app.querySelector("#sle-editor-root");
    if (!rootEl || !editingId) return;
    deps.setSavedLessonEditorErr("");
    deps.setSavedLessonEditorMsg("");
    const collected = deps.collectSavedLessonPayloadFromEditor(rootEl as HTMLElement);
    if (!collected.ok) {
      deps.setSavedLessonEditorErr(collected.error ?? "");
      deps.render();
      return;
    }
    const iconVal = deps.readLibraryIconFromEditor(rootEl as HTMLElement);
    const r = await deps.patchSavedLesson(editingId, {
      payload: collected.payload,
      libraryIcon: iconVal,
    });
    if (!r.ok) {
      deps.setSavedLessonEditorErr("تعذر حفظ التعديلات.");
      deps.render();
      return;
    }
    deps.setSavedLessonEditorPayload(collected.payload);
    deps.setSavedLessonLibraryIcon(iconVal);
    deps.setSavedLessonEditorMsg("تم حفظ التعديلات.");
    deps.render();
  });
}
