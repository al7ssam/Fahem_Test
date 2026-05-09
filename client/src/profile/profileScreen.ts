import { getAuthState } from "../auth/authStore";
import { mountProfileEditor } from "./profileEditor";

export async function renderProfileView(app: HTMLElement, opts: { onBack: () => void }): Promise<void> {
  const auth = getAuthState();
  if (auth.status !== "authenticated") {
    app.innerHTML = `
      <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-4">
        <div class="max-w-lg w-full space-y-4 text-center app-card p-6">
          <p class="text-slate-300">يلزم تسجيل الدخول لعرض الملف الشخصي.</p>
          <button type="button" id="profile-back-btn" class="ui-btn ui-btn--cta w-full py-3">العودة</button>
        </div>
      </div>`;
    app.querySelector("#profile-back-btn")?.addEventListener("click", opts.onBack);
    return;
  }

  app.innerHTML = `
    <div class="app-screen min-h-screen text-white flex flex-col items-center justify-start p-4">
      <div class="max-w-lg w-full space-y-4 pt-4">
        <div class="flex items-center justify-between gap-2">
          <button type="button" id="profile-back-btn" class="ui-btn ui-btn--ghost px-3 py-2 text-sm">← رجوع</button>
          <h1 class="text-xl font-bold text-right flex-1">الحساب والملف الشخصي</h1>
        </div>
        <div id="profile-form-slot"></div>
      </div>
    </div>`;

  app.querySelector("#profile-back-btn")?.addEventListener("click", opts.onBack);

  const slot = app.querySelector<HTMLDivElement>("#profile-form-slot")!;
  await mountProfileEditor(slot, {
    onSaved: () => {
      window.dispatchEvent(new CustomEvent("fahem:profile-cache-updated"));
    },
  });
}
