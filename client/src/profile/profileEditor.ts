import { apiFetch } from "../auth/apiClient";
import { updateProfileNameCacheFromPayload } from "../playerDisplayName";
import { buildOrderedCountryRows, filterCountryRows, type CountryRow } from "./countryOrder";
import { getArabicOfficialNames } from "./countriesLocale";
import { getFlagSvgInnerHtml } from "./flagIcon";

export type ProfilePayload = {
  firstName: string | null;
  lastName: string | null;
  birthDate: string | null;
  countryCode: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBirthParts(iso: string | null): { y: number | null; m: number; d: number } {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { y: null, m: 1, d: 1 };
  }
  const [ys, ms, ds] = iso.split("-");
  return {
    y: Number(ys),
    m: Math.min(12, Math.max(1, Number(ms))),
    d: Math.min(31, Math.max(1, Number(ds))),
  };
}

function daysInMonthUtc(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

function clampDayUtc(year: number, month1to12: number, day: number): number {
  const max = daysInMonthUtc(year, month1to12);
  return Math.min(max, Math.max(1, day));
}

export type MountProfileEditorOptions = {
  onSaved?: () => void;
};

/** يملأ الحاوية بنموذج الملف الشخصي بعد GET؛ يُرجع false إن فشل التحميل. */
export async function mountProfileEditor(
  container: HTMLElement,
  options: MountProfileEditorOptions = {},
): Promise<boolean> {
  container.innerHTML = `<p class="text-center text-slate-400 text-sm py-4">جاري تحميل الملف…</p>`;

  const res = await apiFetch("/api/profile/me");
  if (!res.ok) {
    container.innerHTML = `<p class="text-red-400 text-sm text-center py-4">تعذّر تحميل الملف الشخصي.</p>`;
    return false;
  }
  const body = (await res.json()) as { ok?: boolean; profile?: ProfilePayload };
  if (!body.ok || !body.profile) {
    container.innerHTML = `<p class="text-red-400 text-sm text-center py-4">استجابة غير صالحة.</p>`;
    return false;
  }

  const p = body.profile;
  const birth = parseBirthParts(p.birthDate);
  const names = getArabicOfficialNames();

  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y >= 1900; y--) years.push(y);

  let countryCode = p.countryCode.trim().toUpperCase();
  const allRows: CountryRow[] = buildOrderedCountryRows();
  let searchQuery = "";

  container.innerHTML = `
    <div class="app-card p-6 space-y-5 text-right profile-editor-root">
      <p class="text-sm text-slate-400 m-0">يمكنك إكمال معلوماتك لاحقاً؛ لا يُعطل ذلك اللعب.</p>
      <div class="space-y-2">
        <label class="block text-sm text-slate-400" for="pf-first">الاسم الأول</label>
        <input id="pf-first" class="app-input w-full px-4 py-3 text-right text-lg" maxlength="120" type="text"
          value="${escapeHtml(p.firstName ?? "")}" autocomplete="given-name" />
      </div>
      <div class="space-y-2">
        <label class="block text-sm text-slate-400" for="pf-last">اسم العائلة (اختياري)</label>
        <input id="pf-last" class="app-input w-full px-4 py-3 text-right text-lg" maxlength="120" type="text"
          value="${escapeHtml(p.lastName ?? "")}" autocomplete="family-name" />
      </div>
      <fieldset class="space-y-2 border-0 p-0 m-0">
        <legend class="block text-sm text-slate-400 mb-2">تاريخ الميلاد (اختياري)</legend>
        <div class="grid grid-cols-3 gap-2">
          <div>
            <label class="sr-only" for="pf-day">اليوم</label>
            <select id="pf-day" class="app-input w-full px-2 py-2 text-right"></select>
          </div>
          <div>
            <label class="sr-only" for="pf-month">الشهر</label>
            <select id="pf-month" class="app-input w-full px-2 py-2 text-right"></select>
          </div>
          <div>
            <label class="sr-only" for="pf-year">السنة</label>
            <select id="pf-year" class="app-input w-full px-2 py-2 text-right"></select>
          </div>
        </div>
      </fieldset>
      <div class="space-y-2 relative">
        <span class="block text-sm text-slate-400">الدولة</span>
        <div id="country-picker-root" class="relative"></div>
      </div>
      <p id="pf-err" class="text-red-400 text-sm min-h-[1.25rem]"></p>
      <p id="pf-ok" class="text-emerald-400 text-sm min-h-[1.25rem]"></p>
      <button type="button" id="pf-save" class="ui-btn ui-btn--cta w-full py-3 text-lg">حفظ</button>
    </div>`;

  const slot = container;
  const monthSel = slot.querySelector<HTMLSelectElement>("#pf-month")!;
  const daySel = slot.querySelector<HTMLSelectElement>("#pf-day")!;
  const yearSel = slot.querySelector<HTMLSelectElement>("#pf-year")!;

  const yearOptNone = document.createElement("option");
  yearOptNone.value = "";
  yearOptNone.textContent = "—";
  yearSel.appendChild(yearOptNone);
  for (const y of years) {
    const o = document.createElement("option");
    o.value = String(y);
    o.textContent = String(y);
    if (birth.y !== null && y === birth.y) o.selected = true;
    yearSel.appendChild(o);
  }
  if (birth.y === null) {
    yearOptNone.selected = true;
  }

  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = String(m);
    o.textContent = String(m);
    if (birth.y !== null && m === birth.m) o.selected = true;
    monthSel.appendChild(o);
  }

  function refillDays(): void {
    const yRaw = yearSel.value;
    if (!yRaw) {
      daySel.innerHTML = "";
      daySel.disabled = true;
      return;
    }
    daySel.disabled = false;
    const y = Number(yRaw);
    const m = Number(monthSel.value);
    const max = daysInMonthUtc(y, m);
    const prev = Number(daySel.value) || birth.d || 1;
    daySel.innerHTML = "";
    for (let d = 1; d <= max; d++) {
      const o = document.createElement("option");
      o.value = String(d);
      o.textContent = String(d);
      if (d === clampDayUtc(y, m, prev)) o.selected = true;
      daySel.appendChild(o);
    }
  }

  if (birth.y !== null) {
    refillDays();
  } else {
    daySel.disabled = true;
    daySel.innerHTML = "";
  }

  monthSel.addEventListener("change", refillDays);
  yearSel.addEventListener("change", () => {
    if (!yearSel.value) {
      daySel.innerHTML = "";
      daySel.disabled = true;
      return;
    }
    refillDays();
  });

  const pickerRoot = slot.querySelector<HTMLDivElement>("#country-picker-root")!;
  let pickerOpen = false;

  async function injectFlag(el: Element | null | undefined, code: string): Promise<void> {
    if (!el) return;
    const svg = await getFlagSvgInnerHtml(code);
    el.innerHTML = svg || "";
  }

  function currentFiltered(): CountryRow[] {
    return filterCountryRows(allRows, searchQuery);
  }

  function renderCountryList(ul: HTMLUListElement, live: HTMLElement): void {
    const filtered = currentFiltered();
    live.textContent = `${filtered.length} نتيجة`;
    ul.innerHTML = "";
    for (const row of filtered) {
      const li = document.createElement("li");
      li.role = "option";
      li.tabIndex = -1;
      li.className = `flex flex-row-reverse items-center gap-2 px-2 py-2 rounded-lg cursor-pointer hover:bg-white/5 ${
        row.code === countryCode ? "bg-white/10" : ""
      }`;
      li.dataset.code = row.code;
      const flagSpan = document.createElement("span");
      flagSpan.className = "country-flag-slot w-10 h-7 shrink-0 inline-flex items-center justify-center";
      flagSpan.setAttribute("aria-hidden", "true");
      const lab = document.createElement("span");
      lab.className = "flex-1 text-right";
      lab.textContent = row.labelAr;
      li.appendChild(flagSpan);
      li.appendChild(lab);
      ul.appendChild(li);
      void injectFlag(flagSpan, row.code);
      li.addEventListener("click", () => {
        countryCode = row.code;
        pickerOpen = false;
        searchQuery = "";
        mountPicker();
      });
    }
  }

  function mountPicker(): void {
    pickerRoot.innerHTML = `
      <div class="country-picker-wrap">
        <button type="button" id="country-picker-toggle" class="app-input w-full px-3 py-3 text-right flex flex-row-reverse items-center gap-3 justify-between"
          aria-haspopup="listbox" aria-expanded="${pickerOpen ? "true" : "false"}">
          <span id="country-flag-btn" class="country-flag-slot shrink-0 w-10 h-7 inline-flex items-center justify-center" aria-hidden="true"></span>
          <span id="country-picker-label" class="flex-1 truncate">${escapeHtml(names[countryCode] ?? countryCode)}</span>
          <span class="text-slate-400 text-sm">${pickerOpen ? "▲" : "▼"}</span>
        </button>
        <div id="country-picker-panel" class="${pickerOpen ? "" : "hidden"} absolute z-[100] mt-1 w-full rounded-xl border border-white/10 bg-slate-900 shadow-xl p-2 left-0 right-0 max-h-[70vh] overflow-visible">
          <input id="country-search" type="search" class="app-input w-full px-3 py-2 mb-2 text-right" placeholder="ابحث عن الدولة…"
            value="${escapeHtml(searchQuery)}" autocomplete="off" />
          <ul id="country-ul" role="listbox" class="max-h-60 overflow-y-auto space-y-1 pr-1"></ul>
          <p id="country-live" class="sr-only" aria-live="polite"></p>
        </div>
      </div>`;

    void injectFlag(pickerRoot.querySelector("#country-flag-btn"), countryCode);

    const ul = pickerRoot.querySelector<HTMLUListElement>("#country-ul")!;
    const live = pickerRoot.querySelector<HTMLElement>("#country-live")!;
    renderCountryList(ul, live);

    pickerRoot.querySelector("#country-picker-toggle")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      pickerOpen = !pickerOpen;
      mountPicker();
      if (pickerOpen) {
        window.setTimeout(() => {
          pickerRoot.querySelector<HTMLInputElement>("#country-search")?.focus();
        }, 0);
        const onDoc = (e: MouseEvent): void => {
          const panel = pickerRoot.querySelector("#country-picker-panel");
          const t = e.target as Node;
          if (panel && !panel.contains(t) && !pickerRoot.querySelector("#country-picker-toggle")?.contains(t)) {
            pickerOpen = false;
            document.removeEventListener("click", onDoc, true);
            mountPicker();
          }
        };
        window.setTimeout(() => document.addEventListener("click", onDoc, { capture: true, once: true }), 0);
      }
    });

    const search = pickerRoot.querySelector<HTMLInputElement>("#country-search");
    search?.addEventListener("input", () => {
      searchQuery = search.value;
      const ul2 = pickerRoot.querySelector<HTMLUListElement>("#country-ul")!;
      const live2 = pickerRoot.querySelector<HTMLElement>("#country-live")!;
      renderCountryList(ul2, live2);
    });
  }

  mountPicker();

  const errEl = slot.querySelector<HTMLParagraphElement>("#pf-err")!;
  const okEl = slot.querySelector<HTMLParagraphElement>("#pf-ok")!;

  slot.querySelector("#pf-save")?.addEventListener("click", async () => {
    errEl.textContent = "";
    okEl.textContent = "";
    const first = slot.querySelector<HTMLInputElement>("#pf-first")?.value.trim() ?? "";
    if (!first) {
      errEl.textContent = "يرجى إدخال الاسم الأول.";
      return;
    }
    const lastRaw = slot.querySelector<HTMLInputElement>("#pf-last")?.value.trim() ?? "";

    let birthDatePayload: string | null = null;
    const yStr = yearSel.value;
    if (yStr) {
      const y = Number(yStr);
      const m = Number(monthSel.value);
      const d = Number(daySel.value);
      const maxD = daysInMonthUtc(y, m);
      const dClamped = Math.min(maxD, Math.max(1, d));
      birthDatePayload = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(dClamped).padStart(2, "0")}`;
      const today = new Date();
      const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      if (birthDatePayload > todayIso) {
        errEl.textContent = "تاريخ الميلاد لا يمكن أن يكون في المستقبل.";
        return;
      }
    }

    const patchBody: Record<string, unknown> = {
      firstName: first,
      lastName: lastRaw.length > 0 ? lastRaw : null,
      countryCode,
      birthDate: birthDatePayload,
    };

    const btn = slot.querySelector<HTMLButtonElement>("#pf-save")!;
    btn.disabled = true;
    try {
      const patchRes = await apiFetch("/api/profile/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const patchJson = (await patchRes.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        profile?: ProfilePayload;
      };
      if (!patchRes.ok) {
        errEl.textContent =
          patchJson.error === "invalid_country_code"
            ? "رمز الدولة غير مسموح."
            : patchJson.error === "birth_date_future"
              ? "تاريخ الميلاد في المستقبل."
              : patchJson.error === "invalid_birth_date"
                ? "تاريخ الميلاد غير صالح."
                : "تعذّر حفظ التعديلات.";
        return;
      }
      if (patchJson.profile) {
        updateProfileNameCacheFromPayload({
          firstName: patchJson.profile.firstName,
          lastName: patchJson.profile.lastName,
        });
      }
      okEl.textContent = "تم الحفظ.";
      options.onSaved?.();
    } finally {
      btn.disabled = false;
    }
  });

  return true;
}
