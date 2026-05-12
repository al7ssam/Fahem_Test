import { escapeHtml, el } from "../utils";

export type CountdownScreenDeps = {
  isPrivateRoomSession: () => boolean;
  getLastPrivateRoomCode: () => string | null;
};

export function renderCountdownScreen(deps: CountdownScreenDeps): void {
  const cdSubtitle =
    deps.isPrivateRoomSession() || Boolean(deps.getLastPrivateRoomCode())
      ? "جاري بدء الجولة في غرفتك الخاصة…"
      : "تم العثور على منافسين. جاري اكتمال المجموعة…";
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.append(
    el(`
      <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-6 text-center">
        <p id="cd-subtitle" class="text-emerald-200/95 text-base max-w-md mb-3 leading-relaxed">${escapeHtml(cdSubtitle)}</p>
        <p class="text-slate-300 mb-4">تبدأ المباراة خلال</p>
        <div id="cd" class="text-7xl font-black text-amber-300 tabular-nums">3</div>
      </div>
    `),
  );
}
