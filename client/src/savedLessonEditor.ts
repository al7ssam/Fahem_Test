function escapeEditorHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string;
  });
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

/** واجهة مبسطة للجوال: حقول تطابق بنية الاستيراد للدرس المخصص */
export function renderSavedLessonEditorMarkup(payload: Record<string, unknown>): string {
  const lesson = (payload.lesson ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const title = String(lesson.title ?? "");
  const defaultAnswerMs = Number(lesson.defaultAnswerMs ?? 15000);
  const slugVal = lesson.slug != null ? String(lesson.slug) : "";
  const descVal = lesson.description != null ? String(lesson.description) : "";

  const lessonFields = `
    <div class="space-y-2 border border-slate-600/50 rounded-lg p-3">
      <span class="text-amber-200 text-sm font-bold">الدرس</span>
      <label class="block text-xs text-slate-400">العنوان</label>
      <input type="text" id="sle-lesson-title" class="app-input w-full px-2 py-2 text-sm" value="${escapeEditorHtml(title)}" maxlength="300" />
      <label class="block text-xs text-slate-400">الوصف (اختياري)</label>
      <textarea id="sle-lesson-desc" rows="2" class="app-input w-full px-2 py-2 text-xs">${escapeEditorHtml(descVal)}</textarea>
      <label class="block text-xs text-slate-400">المعرّف slug (اختياري)</label>
      <input type="text" id="sle-lesson-slug" class="app-input w-full px-2 py-1 text-xs font-mono" value="${escapeEditorHtml(slugVal)}" maxlength="160" />
      <label class="block text-xs text-slate-400">زمن الإجابة الافتراضي (مللي)</label>
      <input type="number" id="sle-lesson-def-ms" class="app-input w-full px-2 py-1 text-sm" min="3000" max="120000" step="500" value="${Number.isFinite(defaultAnswerMs) ? defaultAnswerMs : 15000}" />
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
          <span class="text-[11px] text-slate-500">سؤال ${ii + 1}</span>
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
        <summary class="cursor-pointer text-amber-200 text-sm font-bold py-1">قسم ${si + 1}</summary>
        <div class="space-y-2 pt-2">
          <label class="block text-xs text-slate-400">عنوان القسم</label>
          <input type="text" id="sle-sec-${si}-title" class="app-input w-full px-2 py-1 text-sm" value="${escapeEditorHtml(titleAr)}" maxlength="500" />
          <label class="block text-xs text-slate-400">زمن طور المذاكرة للقسم (مللي)</label>
          <input type="number" id="sle-sec-${si}-study-ms" class="app-input w-full px-2 py-1 text-sm" min="2000" max="300000" step="500" value="${studyMs === "" ? "" : studyMs}" />
          <div class="space-y-2">${itemBlocks.join("")}</div>
        </div>
      </details>
    `;
  });

  return `
    <div id="sle-editor-root" class="space-y-3">
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
  const slugRaw = (root.querySelector<HTMLInputElement>("#sle-lesson-slug")?.value ?? "").trim();
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
