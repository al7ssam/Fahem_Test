import { escapeHtml, el } from "../utils";
import type { LessonPlaybackPayload, Phase } from "../types";

export type LessonDoneScreenDeps = {
  getLessonPlayback: () => LessonPlaybackPayload | null;
  getLessonQuizCorrect: () => number;
  getLessonSoloPlaybackReturnTarget: () => "lesson_menu" | "saved_lessons_library" | "custom_lesson";
  setPhase: (p: Phase) => void;
  setLessonReviewIndex: (v: number) => void;
  setLessonSoloPlaybackReturnTarget: (v: string) => void;
  setCustomLessonPreviewLesson: (v: null) => void;
  setCustomLessonValidatedBody: (v: null) => void;
  setCustomLessonSessionToken: (v: null) => void;
  setCustomLessonErr: (v: string) => void;
  setCustomLessonMsg: (v: string) => void;
  clearTimer: () => void;
  resetLessonState: () => void;
  beginLessonPlayback: (data: LessonPlaybackPayload) => void;
  openSavedLessonsLibraryScreen: () => void;
  returnToHomeFromSearch: () => void;
  /** إنهاء الدرس — نفس منطق الخروج من التشغيل الفردي (تصنيفات / مخصص / مكتبة). */
  finishLessonFromDoneScreen: () => void;
  render: () => void;
};

export function renderLessonDoneScreen(deps: LessonDoneScreenDeps): void {
  const lp = deps.getLessonPlayback();
  const total = lp?.steps.length ?? 0;
  const title = escapeHtml(lp?.title ?? "");
  const correct = deps.getLessonQuizCorrect();
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.append(
    el(`
      <div class="app-screen min-h-screen text-white p-6 flex flex-col items-center justify-center max-w-md mx-auto text-center gap-6">
        <h2 class="text-2xl font-extrabold text-amber-300">أنهيت الدرس</h2>
        <p class="text-slate-200 text-lg">${title}</p>
        <p class="text-emerald-300 text-xl font-bold">النتيجة: ${correct} / ${total}</p>
        <button type="button" id="lesson-review-open" class="ui-btn ui-btn--primary w-full py-3 text-lg">مراجعة الإجابات</button>
        <button type="button" id="lesson-redo" class="ui-btn ui-btn--cta w-full py-3 text-lg">إعادة الدرس</button>
        <button type="button" id="lesson-done-end-custom" class="ui-btn ui-btn--primary w-full py-3 text-lg">إنهاء الدرس</button>
        <button type="button" id="lesson-done-home-main" class="ui-btn ui-btn--ghost w-full py-3">العودة للرئيسية</button>
      </div>
    `),
  );
  app.querySelector("#lesson-review-open")?.addEventListener("click", () => {
    deps.setLessonReviewIndex(0);
    deps.setPhase("lesson_review");
    deps.render();
  });
  app.querySelector("#lesson-redo")?.addEventListener("click", () => {
    const snap = lp;
    if (!snap?.steps?.length) return;
    deps.clearTimer();
    deps.beginLessonPlayback(snap);
    deps.render();
  });
  app.querySelector("#lesson-done-end-custom")?.addEventListener("click", () => {
    deps.clearTimer();
    deps.finishLessonFromDoneScreen();
  });
  app.querySelector("#lesson-done-home-main")?.addEventListener("click", () => {
    deps.clearTimer();
    deps.resetLessonState();
    deps.returnToHomeFromSearch();
  });
}
