function escapeEditorHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string;
  });
}

/** إيموجي جاهزة لعرض المكتبة (زر واحد = إدراج في الحقل) */
const LIBRARY_ICON_PRESETS = [
  "📖",
  "📚",
  "📕",
  "📗",
  "📘",
  "📙",
  "📓",
  "✏️",
  "🎓",
  "🔬",
  "💡",
  "🎯",
  "⭐",
  "📝",
  "🧪",
  "📊",
] as const;

export function readLibraryIconFromEditor(root: HTMLElement): string | null {
  const raw = (root.querySelector<HTMLInputElement>("#sle-library-icon")?.value ?? "").trim();
  if (!raw) return null;
  return Array.from(raw)
    .slice(0, 32)
    .join("")
    .trim();
}

function readNum(el: HTMLInputElement | null, fallback: number, min: number, max: number): number {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

function readInt(el: HTMLInputElement | null, fallback: number, min: number, max: number): number {
  if (!el) return fallback;
  const v = parseInt(el.value, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** نسخ عميقة آمنة لتعديل الأقسام/الأسئلة */
function clonePayloadForEdit(payload: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

export function removeSectionFromPayload(
  payload: Record<string, unknown>,
  sectionIndex: number,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const copy = clonePayloadForEdit(payload);
  const sections = Array.isArray(copy.sections) ? copy.sections : [];
  if (sectionIndex < 0 || sectionIndex >= sections.length) {
    return { ok: false, error: "قسم غير صالح." };
  }
  if (sections.length <= 1) {
    return { ok: false, error: "لا يمكن حذف آخر قسم — يجب أن يبقى قسم واحد على الأقل." };
  }
  copy.sections = sections.filter((_, i) => i !== sectionIndex);
  return { ok: true, payload: copy };
}

export function removeQuestionFromPayload(
  payload: Record<string, unknown>,
  sectionIndex: number,
  itemIndex: number,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  const copy = clonePayloadForEdit(payload);
  const sections = Array.isArray(copy.sections) ? [...copy.sections] : [];
  if (sectionIndex < 0 || sectionIndex >= sections.length) {
    return { ok: false, error: "قسم غير صالح." };
  }
  const sec = { ...(sections[sectionIndex] as Record<string, unknown>) };
  const items = Array.isArray(sec.items) ? [...sec.items] : [];
  if (itemIndex < 0 || itemIndex >= items.length) {
    return { ok: false, error: "سؤال غير صالح." };
  }
  if (items.length <= 1) {
    return {
      ok: false,
      error: "لا يمكن حذف آخر سؤال في القسم — احذف القسم كاملاً من شريط «حذف القسم».",
    };
  }
  sec.items = items.filter((_, i) => i !== itemIndex);
  sections[sectionIndex] = sec;
  copy.sections = sections;
  return { ok: true, payload: copy };
}

/** واجهة مبسطة للجوال: حقول تطابق بنية الاستيراد للدرس المخصص */
export function renderSavedLessonEditorMarkup(
  payload: Record<string, unknown>,
  libraryIcon: string | null,
): string {
  const lesson = (payload.lesson ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const title = String(lesson.title ?? "");
  const defaultAnswerMs = Number(lesson.defaultAnswerMs ?? 15000);
  const slugStored =
    lesson.slug != null && String(lesson.slug).trim() !== "" ? String(lesson.slug).trim() : "";
  const descVal = lesson.description != null ? String(lesson.description) : "";
  const iconInputVal = libraryIcon != null && String(libraryIcon).trim() !== "" ? String(libraryIcon).trim() : "";

  const iconPicker = `
    <div class="space-y-2 border border-amber-800/35 rounded-lg p-3 bg-amber-950/15">
      <span class="text-amber-200 text-sm font-bold">أيقونة المكتبة</span>
      <p class="text-[10px] text-slate-500 m-0 leading-snug">تظهر في «مكتبة دروسي». اترك الحقل فارغاً لاستخدام 📖.</p>
      <div class="flex flex-wrap gap-1.5 justify-center">
        ${LIBRARY_ICON_PRESETS.map(
          (ic) =>
            `<button type="button" class="sle-lib-icon-preset touch-manipulation min-h-[44px] min-w-[44px] flex items-center justify-center text-2xl rounded-lg border border-slate-600/50 bg-slate-900/45 active:bg-slate-800/80" data-lib-icon="${escapeEditorHtml(ic)}" aria-label="اختيار الأيقونة">${ic}</button>`,
        ).join("")}
      </div>
      <label class="block text-xs text-slate-400">أو الصق إيموجي مخصّصاً</label>
      <input type="text" id="sle-library-icon" maxlength="32" class="app-input w-full px-2 py-2 text-center text-2xl min-h-[48px]" placeholder="📖" value="${escapeEditorHtml(iconInputVal)}" dir="ltr" autocomplete="off" inputmode="text" />
    </div>
  `;

  const lessonFields = `
    <div class="space-y-2 border border-slate-600/50 rounded-lg p-3">
      <span class="text-amber-200 text-sm font-bold">الدرس</span>
      <input type="hidden" id="sle-lesson-slug-preserve" value="${escapeEditorHtml(slugStored)}" />
      <label class="block text-xs text-slate-400">العنوان</label>
      <input type="text" id="sle-lesson-title" class="app-input w-full px-2 py-2 text-sm min-h-[44px]" value="${escapeEditorHtml(title)}" maxlength="300" />
      <label class="block text-xs text-slate-400">الوصف (اختياري)</label>
      <textarea id="sle-lesson-desc" rows="2" class="app-input w-full px-2 py-2 text-xs">${escapeEditorHtml(descVal)}</textarea>
      <label class="block text-xs text-slate-400">زمن الإجابة الافتراضي (مللي)</label>
      <input type="number" id="sle-lesson-def-ms" class="app-input w-full px-2 py-2 text-sm min-h-[44px]" min="3000" max="120000" step="500" value="${Number.isFinite(defaultAnswerMs) ? defaultAnswerMs : 15000}" />
    </div>
  `;

  const sectionBlocks = sections.map((secRaw, si) => {
    const sec = (secRaw ?? {}) as Record<string, unknown>;
    const titleAr = sec.titleAr != null ? String(sec.titleAr) : "";
    const studyPhaseRaw =
      sec.studyPhaseMs != null
        ? sec.studyPhaseMs
        : sec.study_phase_ms != null
          ? sec.study_phase_ms
          : null;
    const studyPhaseMsNum =
      studyPhaseRaw != null && studyPhaseRaw !== "" ? Number(studyPhaseRaw) : null;
    const studyMs =
      studyPhaseMsNum != null && Number.isFinite(studyPhaseMsNum) ? studyPhaseMsNum : "";
    const items = Array.isArray(sec.items) ? sec.items : [];
    const itemBlocks = items.map((itRaw, ii) => {
      const it = (itRaw ?? {}) as Record<string, unknown>;
      const prompt = String(it.prompt ?? "");
      const opts = Array.isArray(it.options) ? it.options.map((o) => String(o ?? "")) : ["", "", "", ""];
      while (opts.length < 4) opts.push("");
      const o = opts.slice(0, 4);
      const correctIndex = Number(it.correctIndex ?? 0);
      const studyBody = String(it.studyBody ?? it.study_body ?? "");
      const answerMsRaw = it.answerMs ?? it.answer_ms;
      const answerMs = answerMsRaw != null && answerMsRaw !== "" ? Number(answerMsRaw) : "";
      const diff = String(it.difficulty ?? "medium");
      const subKey = String(it.subcategoryKey ?? it.subcategory_key ?? "general_default");

      return `
        <div class="border border-slate-600/40 rounded-md p-2 space-y-1.5 bg-slate-900/40" data-sle-item="${si}-${ii}">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <span class="text-[11px] text-slate-500 font-medium">سؤال ${ii + 1}</span>
            <button type="button" class="sle-del-q touch-manipulation min-h-[40px] px-3 py-1.5 text-xs font-semibold rounded-lg border border-red-500/35 text-red-300 bg-red-950/25 active:bg-red-950/45" data-section-index="${si}" data-item-index="${ii}" aria-label="حذف السؤال ${ii + 1}">حذف السؤال</button>
          </div>
          <label class="block text-[11px] text-slate-400">النص</label>
          <textarea id="sle-s${si}-i${ii}-prompt" rows="2" class="app-input w-full px-2 py-1 text-sm">${escapeEditorHtml(prompt)}</textarea>
          <div class="grid grid-cols-2 gap-1">
            <input id="sle-s${si}-i${ii}-o0" type="text" class="app-input px-2 py-1 text-xs" placeholder="خيار 1" value="${escapeEditorHtml(o[0] ?? "")}" />
            <input id="sle-s${si}-i${ii}-o1" type="text" class="app-input px-2 py-1 text-xs" placeholder="خيار 2" value="${escapeEditorHtml(o[1] ?? "")}" />
            <input id="sle-s${si}-i${ii}-o2" type="text" class="app-input px-2 py-1 text-xs" placeholder="خيار 3" value="${escapeEditorHtml(o[2] ?? "")}" />
            <input id="sle-s${si}-i${ii}-o3" type="text" class="app-input px-2 py-1 text-xs" placeholder="خيار 4" value="${escapeEditorHtml(o[3] ?? "")}" />
          </div>
          <p class="text-[10px] text-slate-500 m-0">املأ خيارين أو أربعة غير فارغة.</p>
          <label class="block text-[11px] text-slate-400">الإجابة الصحيحة (0–3 حسب ترتيب الخيارات المملوءة)</label>
          <input id="sle-s${si}-i${ii}-correct" type="number" min="0" max="3" class="app-input w-24 px-2 py-1 text-sm" value="${Number.isFinite(correctIndex) ? correctIndex : 0}" />
          <label class="block text-[11px] text-slate-400">بطاقة المذاكرة</label>
          <textarea id="sle-s${si}-i${ii}-study" rows="3" class="app-input w-full px-2 py-1 text-xs">${escapeEditorHtml(studyBody)}</textarea>
          <label class="block text-[11px] text-slate-400">زمن السؤال (مللي، اختياري)</label>
          <input id="sle-s${si}-i${ii}-ams" type="number" class="app-input w-full px-2 py-1 text-xs" min="3000" max="120000" step="100" value="${answerMs === "" ? "" : answerMs}" />
          <input type="hidden" id="sle-s${si}-i${ii}-diff" value="${escapeEditorHtml(diff)}" />
          <input type="hidden" id="sle-s${si}-i${ii}-sub" value="${escapeEditorHtml(subKey)}" />
        </div>
      `;
    });

    return `
      <details class="border border-amber-900/40 rounded-lg p-2 open" open>
        <summary class="cursor-pointer text-amber-200 text-sm font-bold py-2 min-h-[44px] flex items-center list-none [&::-webkit-details-marker]:hidden">
          <span class="flex-1 text-right">قسم ${si + 1}</span>
          <span class="text-slate-500 text-xs mr-2" aria-hidden="true">▼</span>
        </summary>
        <div class="space-y-2 pt-1 border-t border-amber-900/20">
          <div class="flex justify-stretch sm:justify-end pt-1">
            <button type="button" class="sle-del-sec touch-manipulation w-full sm:w-auto min-h-[44px] px-3 py-2 text-sm font-semibold rounded-lg border border-red-500/35 text-red-300 bg-red-950/25 active:bg-red-950/45" data-section-index="${si}" aria-label="حذف القسم ${si + 1}">حذف القسم بالكامل</button>
          </div>
          <label class="block text-xs text-slate-400">عنوان القسم</label>
          <input type="text" id="sle-sec-${si}-title" class="app-input w-full px-2 py-2 text-sm min-h-[44px]" value="${escapeEditorHtml(titleAr)}" maxlength="500" />
          <label class="block text-xs text-slate-400">زمن طور المذاكرة للقسم (مللي)</label>
          <input type="number" id="sle-sec-${si}-study-ms" class="app-input w-full px-2 py-2 text-sm min-h-[44px]" min="2000" max="300000" step="500" value="${studyMs === "" ? "" : studyMs}" />
          <div class="space-y-3">${itemBlocks.join("")}</div>
        </div>
      </details>
    `;
  });

  return `
    <div id="sle-editor-root" class="space-y-3">
      ${iconPicker}
      ${lessonFields}
      <div class="space-y-2">${sectionBlocks.join("")}</div>
    </div>
  `;
}

export function collectSavedLessonPayloadFromEditor(root: HTMLElement): {
  ok: true;
  payload: Record<string, unknown>;
} | { ok: false; error: string } {
  const titleEl = root.querySelector<HTMLInputElement>("#sle-lesson-title");
  const title = (titleEl?.value ?? "").trim();
  if (!title) return { ok: false, error: "عنوان الدرس مطلوب." };

  const desc = (root.querySelector<HTMLTextAreaElement>("#sle-lesson-desc")?.value ?? "").trim();
  const slugRaw = (root.querySelector<HTMLInputElement>("#sle-lesson-slug-preserve")?.value ?? "").trim();
  const slug = slugRaw === "" ? null : slugRaw;
  const defMs = readNum(root.querySelector("#sle-lesson-def-ms"), 15000, 3000, 120000);

  const sectionDetails = root.querySelectorAll("details");
  const sections: Record<string, unknown>[] = [];
  let si = 0;
  for (const det of sectionDetails) {
    const secTitle = (det.querySelector<HTMLInputElement>(`#sle-sec-${si}-title`)?.value ?? "").trim();
    const studyMsEl = det.querySelector<HTMLInputElement>(`#sle-sec-${si}-study-ms`);
    const studyRaw = studyMsEl?.value?.trim() ?? "";
    const studyPhaseMs =
      studyRaw === "" ? null : Math.min(300000, Math.max(2000, parseInt(studyRaw, 10) || 0));

    const itemWraps = det.querySelectorAll(`[data-sle-item^="${si}-"]`);
    const items: Record<string, unknown>[] = [];
    let ii = 0;
    for (const _w of itemWraps) {
      const prompt = (root.querySelector<HTMLTextAreaElement>(`#sle-s${si}-i${ii}-prompt`)?.value ?? "").trim();
      const o0 = (root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-o0`)?.value ?? "").trim();
      const o1 = (root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-o1`)?.value ?? "").trim();
      const o2 = (root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-o2`)?.value ?? "").trim();
      const o3 = (root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-o3`)?.value ?? "").trim();
      const rawOpts = [o0, o1, o2, o3];
      const nonempty = rawOpts.map((x) => x.trim()).filter((x) => x.length > 0);
      if (nonempty.length !== 2 && nonempty.length !== 4) {
        return {
          ok: false,
          error: `القسم ${si + 1} سؤال ${ii + 1}: يجب إدخال خيارين أو أربعة غير فارغة.`,
        };
      }
      const options = nonempty;
      const correctIndex = readInt(root.querySelector(`#sle-s${si}-i${ii}-correct`), 0, 0, 3);
      if (correctIndex >= options.length) {
        return {
          ok: false,
          error: `القسم ${si + 1} سؤال ${ii + 1}: رقم الإجابة الصحيحة خارج النطاق.`,
        };
      }
      const studyBody = (root.querySelector<HTMLTextAreaElement>(`#sle-s${si}-i${ii}-study`)?.value ?? "").trim();
      if (!studyBody) {
        return { ok: false, error: `القسم ${si + 1} سؤال ${ii + 1}: بطاقة المذاكرة مطلوبة.` };
      }
      const amsRaw = root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-ams`)?.value?.trim() ?? "";
      const answerMs = amsRaw === "" ? null : readInt(root.querySelector(`#sle-s${si}-i${ii}-ams`), 15000, 3000, 120000);
      const difficulty = (
        root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-diff`)?.value ?? "medium"
      ).trim() || "medium";
      const subcategoryKey = (
        root.querySelector<HTMLInputElement>(`#sle-s${si}-i${ii}-sub`)?.value ?? "general_default"
      ).trim() || "general_default";

      items.push({
        prompt,
        options,
        correctIndex,
        difficulty,
        studyBody,
        answerMs,
        subcategoryKey,
      });
      ii++;
    }

    if (items.length < 1) {
      return { ok: false, error: `القسم ${si + 1} لا يحتوي أسئلة.` };
    }

    sections.push({
      titleAr: secTitle === "" ? null : secTitle,
      studyPhaseMs,
      items,
    });
    si++;
  }

  if (sections.length < 1) return { ok: false, error: "يجب وجود قسم واحد على الأقل." };

  const payload: Record<string, unknown> = {
    lesson: {
      title,
      slug,
      description: desc === "" ? null : desc,
      defaultAnswerMs: defMs,
      sortOrder: 0,
    },
    sections,
  };

  return { ok: true, payload };
}
