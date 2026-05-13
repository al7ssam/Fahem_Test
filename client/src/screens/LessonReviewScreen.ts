import { escapeHtml, el } from "../utils";
import type { LessonPlaybackPayload, Phase } from "../types";
import type { ReviewItem } from "../../shared/reviewItem";

export type LessonReviewItem = ReviewItem;

export type LessonReviewScreenDeps = {
  getLessonReviewIndex: () => number;
  getLessonPlayback: () => LessonPlaybackPayload | null;
  lessonRestReviewItems: () => ReviewItem[];
  setPhase: (p: Phase) => void;
  setLessonReviewIndex: (v: number) => void;
  render: () => void;
};

export function renderLessonReviewScreen(deps: LessonReviewScreenDeps): void {
  const items = deps.lessonRestReviewItems();
  const idx = deps.getLessonReviewIndex();
  const cur = items[idx];
  const n = items.length;
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.append(
    el(`
      <div class="playing-shell app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3">
        <div class="flex items-center justify-between gap-2">
          <button type="button" id="lesson-review-back" class="ui-btn ui-btn--ghost py-2 text-sm">رجوع للنتيجة</button>
          <span class="text-slate-400 text-xs">سؤال ${idx + 1} / ${n}</span>
        </div>
        <p class="text-amber-200 text-sm text-right m-0">${escapeHtml(deps.getLessonPlayback()?.title ?? "")}</p>
        <div id="lesson-review-root" class="question-card rounded-2xl p-5 flex-1 flex flex-col gap-4 shadow-xl min-h-0"></div>
        <div class="flex gap-2">
          <button type="button" id="lesson-review-prev" class="ui-btn ui-btn--ghost flex-1 py-2" ${idx <= 0 ? "disabled" : ""}>السابق</button>
          <button type="button" id="lesson-review-next" class="ui-btn ui-btn--ghost flex-1 py-2" ${idx >= n - 1 ? "disabled" : ""}>التالي</button>
        </div>
      </div>
    `),
  );
  const root = app.querySelector<HTMLDivElement>("#lesson-review-root");
  if (root && cur) {
    const choiceIdx = cur.choiceIndex;
    const optsHtml = cur.options
      .map((label, i) => {
        const isCorrect = i === cur.correctIndex;
        const isWrongPick = choiceIdx != null && choiceIdx !== cur.correctIndex && choiceIdx === i;
        let cls = "option-btn option-btn--disabled";
        if (isCorrect) cls += " option-btn--review-correct";
        if (isWrongPick) cls += " option-btn--review-wrong";
        return `<button type="button" disabled class="${cls}">${escapeHtml(label)}</button>`;
      })
      .join("");
    const studyBlock = cur.studyBody?.trim()
      ? `<div class="study-card study-card--0 mt-2"><p class="study-card__body font-medium whitespace-pre-wrap">${escapeHtml(cur.studyBody)}</p></div>`
      : "";
    root.innerHTML = `<p class="text-right text-xl font-semibold leading-relaxed">${escapeHtml(cur.prompt)}</p>
      <div class="options-grid grid">${optsHtml}</div>${studyBlock}`;
  }
  app.querySelector("#lesson-review-back")?.addEventListener("click", () => {
    deps.setPhase("lesson_done");
    deps.render();
  });
  app.querySelector("#lesson-review-prev")?.addEventListener("click", () => {
    if (idx > 0) {
      deps.setLessonReviewIndex(idx - 1);
      deps.render();
    }
  });
  app.querySelector("#lesson-review-next")?.addEventListener("click", () => {
    if (idx < n - 1) {
      deps.setLessonReviewIndex(idx + 1);
      deps.render();
    }
  });
}
