import "./style.css";
import { io, type Socket } from "socket.io-client";

type GameMode = "direct" | "study_then_quiz";
type Phase = "name" | "matchmaking" | "countdown" | "studying" | "playing" | "result";

const app = document.querySelector<HTMLDivElement>("#app")!;

let socket: Socket | null = null;
let phase: Phase = "name";
let mySocketId: string | null = null;
let currentQuestionId: number | null = null;
let endsAt = 0;
let timerHandle: number | null = null;
let currentGameMode: GameMode | null = null;
let lobbyNotice = "";
const LOBBY_MSG_WAIT_NEXT =
  "مباراة جارية الآن بين مجموعة أخرى. أنت في قائمة انتظار الجولة التالية.";
const LOBBY_MSG_CANCELLED =
  "تم إلغاء بدء المباراة — لا يوجد الآن عدد كافٍ من اللاعبين الجاهزين.";
let lobbyPlayersList: Array<{ socketId: string; name: string; ready: boolean }> = [];
let currentMatchPlayers: Array<{
  socketId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator?: boolean;
  skillPoints?: number;
  lastAward?: number;
  keys?: number;
  skillBoostStacks?: number;
  /** نتيجة آخر جولة معروضة في اللوحة (من question_result) */
  lastRoundResult?: "skipped" | "correct" | "wrong";
}> = [];
let revealKeysActiveState = false;
let keysAttacksEnabledState = true;

type AbilityCostsPayload = {
  skillBoost: number;
  skipQuestion: number;
  heartAttack: number;
  reveal: number;
};
type AbilityTogglesPayload = {
  skillBoost: boolean;
  skipQuestion: boolean;
  heartAttack: boolean;
  reveal: boolean;
};
let abilityCostsState: AbilityCostsPayload = {
  skillBoost: 1,
  skipQuestion: 1,
  heartAttack: 2,
  reveal: 2,
};
let abilityTogglesState: AbilityTogglesPayload = {
  skillBoost: true,
  skipQuestion: true,
  heartAttack: true,
  reveal: true,
};

let studyCards: Array<{
  id: number;
  questionId?: number;
  body: string;
  order: number;
}> = [];

const DEFAULT_RESULT_MESSAGES = {
  winnerTitle: "فزت!",
  loserTitle: "لقد خسرت يا فاشل",
  tieTitle: "تعادل كامل",
  winner: "أحسنت — بقيت حتى النهاية.",
  loser: "انتهت الجولة لصالح لاعب آخر.",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
} as const;
const PLAYER_NAME_STORAGE_KEY = "fahem.playerName";
const RELEASE_VERSION_QUERY_KEY = "v";
const RELEASE_WATCH_INTERVAL_MS = 30000;
let releaseWatchHandle: number | null = null;
let lastKnownReleaseVersion: string | null = null;

const RESULT_VIDEO_SRC = {
  win: "/videos/win.mp4",
  lose: "/videos/lose.mp4",
  tie: "/videos/tie.mp4",
} as const;

type ResultScreenKind = "win" | "lose" | "tie" | "empty";

function getStoredPlayerName(): string {
  try {
    const raw = window.localStorage.getItem(PLAYER_NAME_STORAGE_KEY);
    return (raw ?? "").trim();
  } catch {
    return "";
  }
}

function storePlayerName(name: string): void {
  try {
    window.localStorage.setItem(PLAYER_NAME_STORAGE_KEY, name);
  } catch {
    /* ignore storage failures */
  }
}

function getReleaseVersionFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const v = url.searchParams.get(RELEASE_VERSION_QUERY_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

async function fetchReleaseVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/release-version", {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; releaseVersion?: string };
    if (!data?.ok || typeof data.releaseVersion !== "string") return null;
    const value = data.releaseVersion.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function checkReleaseVersionForRefresh(): Promise<void> {
  const remoteVersion = await fetchReleaseVersion();
  if (!remoteVersion) return;
  if (!lastKnownReleaseVersion) {
    lastKnownReleaseVersion = remoteVersion;
    return;
  }
  if (remoteVersion === lastKnownReleaseVersion) return;
  const target = new URL(window.location.href);
  target.searchParams.set(RELEASE_VERSION_QUERY_KEY, remoteVersion);
  window.location.replace(target.toString());
}

function startReleaseVersionWatch(): void {
  if (releaseWatchHandle !== null) return;
  lastKnownReleaseVersion = getReleaseVersionFromUrl();
  void checkReleaseVersionForRefresh();
  releaseWatchHandle = window.setInterval(() => {
    void checkReleaseVersionForRefresh();
  }, RELEASE_WATCH_INTERVAL_MS);
}

function applyResultScreenPresentation(kind: ResultScreenKind, emoji: string): void {
  const root = app.querySelector<HTMLDivElement>("#result-screen");
  const video = app.querySelector<HTMLVideoElement>("#res-video");
  const emojiEl = app.querySelector<HTMLParagraphElement>("#res-emoji");
  const gate = app.querySelector<HTMLDivElement>("#res-audio-gate");
  const gateBtn = app.querySelector<HTMLButtonElement>("#res-audio-gate-btn");
  if (!root || !video || !emojiEl) return;

  root.classList.remove(
    "result-screen--win",
    "result-screen--lose",
    "result-screen--tie",
    "result-screen--empty",
    "result-screen--emoji-fallback",
    "result-screen--needs-interaction",
  );
  root.classList.add(`result-screen--${kind}`);

  emojiEl.textContent = emoji;
  emojiEl.classList.remove("result-screen__emoji--visible");
  gate?.setAttribute("hidden", "true");
  gateBtn?.setAttribute("aria-hidden", "true");

  const prefersReduced =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  video.onerror = null;
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (kind === "empty") {
    return;
  }

  if (prefersReduced) {
    root.classList.add("result-screen--emoji-fallback");
    emojiEl.classList.add("result-screen__emoji--visible");
    return;
  }

  if (kind === "win" || kind === "lose" || kind === "tie") {
    const src = RESULT_VIDEO_SRC[kind];
    const aria =
      kind === "win"
        ? "فيديو قصير احتفالي للفوز"
        : kind === "lose"
          ? "فيديو قصير يعبّر عن الخسارة"
          : "فيديو قصير للتعادل";
    video.setAttribute("aria-label", aria);
    video.muted = false;
    video.defaultMuted = false;
    video.volume = 1;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.loop = true;
    video.removeAttribute("controls");
    video.setAttribute("src", src);
    video.load();

    const showEmojiFallback = (): void => {
      root.classList.add("result-screen--emoji-fallback");
      emojiEl.classList.add("result-screen__emoji--visible");
    };

    const showInteractionGate = (): void => {
      if (!gate || !gateBtn) {
        showEmojiFallback();
        return;
      }
      root.classList.add("result-screen--needs-interaction");
      gate.removeAttribute("hidden");
      gateBtn.removeAttribute("aria-hidden");
      gateBtn.focus();
      video.setAttribute("controls", "controls");
    };

    video.onerror = () => {
      showEmojiFallback();
    };

    void video.play().catch(() => {
      showInteractionGate();
    });

    if (gateBtn) {
      gateBtn.onclick = () => {
        video.muted = false;
        video.defaultMuted = false;
        video.volume = 1;
        void video.play()
          .then(() => {
            root.classList.remove("result-screen--needs-interaction");
            gate?.setAttribute("hidden", "true");
            gateBtn.setAttribute("aria-hidden", "true");
          })
          .catch(() => {
            showEmojiFallback();
          });
      };
    }
  }
}

let studyEndsAt = 0;
let studyStartsAt = 0;
let studyDurationMs = 0;
let spectatorEligible = false;
let spectatorFollowing = false;
let currentLeaderboard: Array<{
  rank: number;
  name: string;
  skillPoints: number;
  medal: "gold" | "silver" | "bronze" | null;
}> = [];
type ReadyBtnState = "idle" | "window_open" | "submitted" | "closed";
let readyBtnState: ReadyBtnState = "idle";
type StudyPhaseState = "idle" | "ready_window" | "study_content" | "transition_to_question";
let studyPhaseState: StudyPhaseState = "idle";
let activeStudyRoundToken: string | null = null;
let activeStudyMacroRound = 0;
let clockOffsetMs = 0;

function syncClock(serverNow?: number): void {
  if (typeof serverNow !== "number" || !Number.isFinite(serverNow)) return;
  const nextOffset = serverNow - Date.now();
  clockOffsetMs = Math.round((clockOffsetMs * 0.6) + (nextOffset * 0.4));
}

function nowSynced(): number {
  return Date.now() + clockOffsetMs;
}

function isCurrentStudyRound(token?: string | null, macroRound?: number): boolean {
  if (!token || !activeStudyRoundToken) return false;
  if (token !== activeStudyRoundToken) return false;
  if (typeof macroRound === "number" && macroRound !== activeStudyMacroRound) return false;
  return true;
}

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function clearTimer(): void {
  if (timerHandle != null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function render(): void {
  clearTimer();
  app.innerHTML = "";

  if (phase === "name") {
    let selectedMode: GameMode = "direct";
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-4">
          <div class="max-w-lg w-full space-y-6 text-center">
            <h1 class="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-l from-amber-300 to-orange-400">فاهم</h1>
            <p class="text-slate-300 text-lg">تحدٍّ سريع — من يبقى آخر يفوز؟</p>
            <div class="app-card p-6 space-y-5">
              <label class="block text-right text-sm text-slate-400">اسمك في اللعبة</label>
              <input id="name-input" maxlength="32" type="text" placeholder="مثال: سارة" class="app-input w-full px-4 py-3 text-right text-lg" />
              <p class="text-sm text-slate-400 text-right m-0">اختر نمط اللعب</p>
              <div class="mode-picker-grid" role="group" aria-label="نمط اللعب">
                <button type="button" class="mode-option-btn mode-option-btn--selected" data-mode="direct" aria-pressed="true">
                  <span class="mode-option-icon" aria-hidden="true">⚡</span>
                  <span class="mode-option-title">نمط مباشر</span>
                  <span class="mode-option-desc">أسئلة فورية متتالية بدون مراجعة مسبقة</span>
                </button>
                <button type="button" class="mode-option-btn" data-mode="study_then_quiz" aria-pressed="false">
                  <span class="mode-option-icon" aria-hidden="true">📚</span>
                  <span class="mode-option-title">مذاكرة ثم أسئلة</span>
                  <span class="mode-option-desc">بطاقة مراجعة لكل سؤال ثم كتلة أسئلة في الجولة</span>
                </button>
              </div>
              <button id="join-btn" class="ui-btn ui-btn--cta w-full py-3 text-lg">ابدأ التحدي</button>
              <p id="join-err" class="text-red-400 text-sm min-h-[1.25rem]"></p>
            </div>
          </div>
        </div>
      `),
    );
    const input = app.querySelector<HTMLInputElement>("#name-input")!;
    const storedName = getStoredPlayerName();
    if (storedName) {
      input.value = storedName;
    }
    const btn = app.querySelector<HTMLButtonElement>("#join-btn")!;
    const err = app.querySelector<HTMLParagraphElement>("#join-err")!;
    const modeBtns = app.querySelectorAll<HTMLButtonElement>(".mode-option-btn");
    modeBtns.forEach((b) => {
      b.addEventListener("click", () => {
        selectedMode =
          b.dataset.mode === "study_then_quiz" ? "study_then_quiz" : "direct";
        modeBtns.forEach((x) => {
          const on = x === b;
          x.classList.toggle("mode-option-btn--selected", on);
          x.setAttribute("aria-pressed", on ? "true" : "false");
        });
      });
    });
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      err.textContent = "";
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      btn.disabled = true;
      btn.classList.add("btn-pending");
      btn.textContent = "جاري الدخول...";
      storePlayerName(name);
      phase = "matchmaking";
      lobbyNotice = "جاري الاتصال بالخادم...";
      render();
      connectSocket(name, selectedMode);
    });
    return;
  }

  if (phase === "matchmaking") {
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full">
          <header class="flex items-center justify-between py-4">
            <h1 class="text-2xl font-extrabold text-amber-300">فاهم</h1>
            <span id="conn" class="text-xs px-2 py-1 rounded-full bg-white/10">…</span>
          </header>
          <p id="lobby-mode" class="text-right text-sm text-slate-400 mb-2"></p>
          <div class="flex-1 flex flex-col items-center justify-center gap-8 py-6">
            <div class="h-14 w-14 rounded-full border-4 border-amber-400/25 border-t-amber-400 animate-spin shrink-0" role="status" aria-label="جاري البحث"></div>
            <p id="mm-status" class="text-center text-slate-200 text-lg font-medium px-2 leading-relaxed"></p>
            <p id="lobby-notice" class="text-center text-amber-200 text-sm min-h-[1.25rem] max-w-md"></p>
          </div>
        </div>
      `),
    );
    updateConnectionBadge();
    updateLobbyModeLabel();
    const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
    if (noticeEl) noticeEl.textContent = lobbyNotice;
    syncMatchmakingStatusText();
    return;
  }

  if (phase === "countdown") {
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-6 text-center">
          <p id="cd-subtitle" class="text-emerald-200/95 text-base max-w-md mb-3 leading-relaxed">تم العثور على منافسين. جاري اكتمال المجموعة…</p>
          <p class="text-slate-300 mb-4">تبدأ المباراة خلال</p>
          <div id="cd" class="text-7xl font-black text-amber-300 tabular-nums">3</div>
        </div>
      `),
    );
    return;
  }

  if (phase === "studying") {
    const hasCards = studyCards.length > 0;
    app.append(
      el(`
        <div class="study-shell min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="study-progress-fixed">
            <div class="study-progress-head">
              <h2 class="text-lg font-bold text-amber-200 drop-shadow-sm">مراجعة قبل الأسئلة</h2>
              <div id="study-main-clock" class="text-xl font-mono font-bold text-emerald-300 tabular-nums drop-shadow-sm">—</div>
            </div>
            <p id="study-main-clock-label" class="text-right text-slate-300 text-xs min-h-[1rem]">وقت المذاكرة</p>
            <div id="study-progress-track" class="study-progress-track" role="progressbar" aria-label="تقدم وقت المذاكرة" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div id="study-progress-fill" class="study-progress-fill"></div>
            </div>
          </div>
          <div class="study-content-stack">
          <button id="round-ready-btn" type="button" class="ui-btn ui-btn--primary w-full py-2 text-sm">جاهز للجولة (تخطي العداد عند جاهزية الجميع)</button>
          <p id="study-ready-state" class="text-right text-amber-200/90 text-xs min-h-[1.1rem] leading-relaxed"></p>
          <div id="study-cards" class="study-cards-container flex-1 space-y-4 overflow-y-auto pb-2"></div>
          </div>
        </div>
      `),
    );
    const container = app.querySelector<HTMLDivElement>("#study-cards");
    const readyBtn = app.querySelector<HTMLButtonElement>("#round-ready-btn");
    const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
    if (readyBtn) {
      readyBtn.disabled = readyBtnState !== "window_open";
      if (readyBtnState === "submitted") {
        readyBtn.textContent = "تم تسجيل جاهزيتك";
      } else if (readyBtnState === "closed") {
        readyBtn.textContent = "أُغلقت نافذة الجاهزية";
      } else {
        readyBtn.textContent = "جاهز للجولة (تخطي العداد عند جاهزية الجميع)";
      }
      readyBtn.onclick = () => {
        if (readyBtnState !== "window_open") return;
        socket?.emit("round_ready", {});
        readyBtnState = "submitted";
        readyBtn.disabled = true;
        readyBtn.textContent = "تم تسجيل جاهزيتك";
        if (readyStateEl) {
          readyStateEl.textContent = "جاهزيتك مسجلة. بانتظار بقية اللاعبين...";
        }
      };
    }
    if (readyStateEl && !readyStateEl.textContent) {
      readyStateEl.textContent =
        readyBtnState === "window_open"
          ? "زر الجاهزية متاح الآن."
          : readyBtnState === "closed"
            ? "بدأت/انتهت المرحلة التالية؛ زر الجاهزية غير متاح."
            : "";
    }
    if (container && hasCards) {
      studyCards.forEach((c, i) => {
        const card = document.createElement("div");
        const variant = Math.abs(c.order) % 6;
        card.className = `study-card study-card--${variant}`;
        card.style.animationDelay = `${i * 0.08}s`;
        card.innerHTML = `<p class="study-card__body font-medium">${escapeHtml(c.body)}</p>`;
        container.appendChild(card);
      });
    }
    startStudyTimer();
    refreshKeysBadge();
    return;
  }
  if (phase === "playing") {
    app.append(
      el(`
        <div class="playing-shell app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3">
          <div id="toast-root" class="toast-root"></div>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div id="hearts" class="flex gap-1 text-2xl shrink-0"></div>
            <div class="flex items-center gap-2 shrink-0">
              <span id="keys-badge" class="keys-badge" aria-live="polite">🔑 0</span>
              <div id="clock" class="text-xl font-mono font-bold text-amber-300 tabular-nums">—</div>
            </div>
          </div>
          <details class="rivals-details rounded-xl overflow-hidden">
            <summary class="px-3 py-2 text-sm font-bold text-amber-200 cursor-pointer select-none">المنافسون</summary>
            <div id="players-panel" class="players-panel border-0 rounded-none"></div>
          </details>
          <div id="q-card" class="question-card rounded-2xl p-5 flex-1 flex flex-col gap-4 shadow-xl min-h-0">
            <p id="q-text" class="text-right text-xl font-semibold leading-relaxed min-h-[4rem]"></p>
            <div id="opts" class="options-grid grid"></div>
          </div>
          <p id="status" class="status-line text-center text-sm min-h-[1.25rem]"></p>
          <p id="spectator-badge" class="text-center text-amber-200 text-sm min-h-[1.25rem]"></p>
          <div id="attack-overlay" class="attack-overlay" hidden>
            <div class="attack-overlay__panel">
              <p class="text-center font-bold text-amber-200 mb-1">اختر من تريد استهداف قلبه</p>
              <div id="attack-bubbles" class="attack-bubbles"></div>
              <button type="button" id="attack-close" class="ui-btn ui-btn--ghost w-full py-2 text-sm">إلغاء</button>
            </div>
          </div>
          <div class="ability-dock" aria-label="قدرات">
            <div class="ability-dock__inner">
              <button type="button" id="ab-boost" class="ability-btn ability-btn--boost" title="تعزيز نقاط المهارة" aria-label="تعزيز">⚡</button>
              <button type="button" id="ab-skip" class="ability-btn ability-btn--skip" title="تجاوز السؤال دون قلب أو نقاط" aria-label="تجاوز">🛡️</button>
              <button type="button" id="ab-attack" class="ability-btn ability-btn--attack" title="هجوم على قلب" aria-label="هجوم">⚔️</button>
              <button type="button" id="ab-reveal" class="ability-btn ability-btn--reveal" title="كشف مفاتيح الجميع" aria-label="كشف">🔍</button>
            </div>
          </div>
        </div>
      `),
    );
    const meH = currentMatchPlayers.find((p) => p.socketId === mySocketId)?.hearts ?? 3;
    renderHearts(meH);
    renderPlayingPlayersPanel();
    refreshKeysBadge();
    startQuestionTimer();
    if (socket) bindPlayingAbilityUi(socket);
    return;
  }

  if (phase === "result") {
    app.append(
      el(`
        <div id="result-screen" class="result-screen result-screen--empty min-h-screen text-white p-6 flex flex-col items-center justify-center text-center max-w-md mx-auto w-full gap-5">
          <div class="result-screen__hero w-full">
            <div class="result-screen__video-shell">
              <video
                id="res-video"
                class="result-screen__video"
                playsinline
                muted
                loop
                preload="metadata"
              ></video>
              <p id="res-emoji" class="result-screen__emoji" aria-hidden="true"></p>
              <div id="res-audio-gate" class="result-screen__audio-gate" hidden>
                <button id="res-audio-gate-btn" type="button" class="result-screen__audio-gate-btn" aria-hidden="true">
                  اضغط لتشغيل الفيديو مع الصوت
                </button>
              </div>
            </div>
          </div>
          <h2 id="res-title" class="result-screen__title text-3xl font-extrabold tracking-tight"></h2>
          <p id="res-kicker" class="result-screen__kicker text-sm font-semibold min-h-[1.25rem]"></p>
          <p id="res-body" class="result-screen__body text-lg leading-relaxed"></p>
          <button id="continue-watch" type="button" class="result-screen__again ui-btn ui-btn--ghost w-full py-3 text-base hidden">متابعة الجولة كمشاهد</button>
          <div id="res-leaderboard" class="w-full text-right"></div>
          <div id="res-stats" class="result-screen__stats hidden"></div>
          <button id="again" type="button" class="result-screen__again ui-btn ui-btn--primary w-full py-3 text-lg">العب مجدداً</button>
        </div>
      `),
    );
    const continueWatch = app.querySelector<HTMLButtonElement>("#continue-watch");
    if (continueWatch) {
      continueWatch.addEventListener("click", () => {
        spectatorFollowing = true;
        spectatorEligible = false;
        continueWatch.classList.add("hidden");
        socket?.emit("continue_as_spectator", {});
      });
    }
    const again = app.querySelector<HTMLButtonElement>("#again")!;
    again.addEventListener("click", () => {
      phase = "name";
      socket?.disconnect();
      socket = null;
      mySocketId = null;
      currentGameMode = null;
      studyCards = [];
      lobbyPlayersList = [];
      render();
    });
  }
}

function updateLobbyModeLabel(): void {
  const elMode = app.querySelector<HTMLParagraphElement>("#lobby-mode");
  if (!elMode || !currentGameMode) return;
  elMode.textContent =
    currentGameMode === "direct"
      ? "البحث عن تحدي — نمط مباشر"
      : "البحث عن تحدي — مراجعة ثم أسئلة";
}

function updateConnectionBadge(): void {
  const badge = app.querySelector<HTMLSpanElement>("#conn");
  if (!badge || !socket) return;
  if (socket.connected) {
    badge.textContent = "متصل";
    badge.className = "text-xs px-2 py-1 rounded-full bg-emerald-500/20 text-emerald-300";
  } else {
    badge.textContent = "غير متصل";
    badge.className = "text-xs px-2 py-1 rounded-full bg-red-500/20 text-red-300";
  }
}

function syncMatchmakingStatusText(): void {
  const el = app.querySelector<HTMLParagraphElement>("#mm-status");
  if (!el) return;
  const readyCount = lobbyPlayersList.filter((p) => p.ready).length;
  el.textContent =
    readyCount < 2
      ? "جاري البحث عن منافسين…"
      : "تم العثور على لاعبين. جاري تجهيز المباراة…";
}

function renderPlayingPlayersPanel(): void {
  const panel = app.querySelector<HTMLDivElement>("#players-panel");
  if (!panel) return;
  panel.innerHTML = "";
  if (currentMatchPlayers.length === 0) {
    panel.textContent = "بانتظار بيانات اللاعبين...";
    return;
  }
  for (const p of currentMatchPlayers) {
    const row = document.createElement("div");
    const isMe = p.socketId === mySocketId;
    row.className = `players-panel__row ${isMe ? "players-panel__row--me" : ""}`;
    const points = p.skillPoints ?? 0;
    const bonus = p.lastAward && p.lastAward > 0 ? ` <span class="players-panel__award">+${p.lastAward}</span>` : "";
    const roundTag =
      p.lastRoundResult === "skipped"
        ? ` <span class="players-panel__round-tag players-panel__round-tag--skipped">تخطّى</span>`
        : p.lastRoundResult === "wrong"
          ? ` <span class="players-panel__round-tag players-panel__round-tag--wrong">خطأ</span>`
          : "";
    const k = p.keys ?? 0;
    const keysShown = isMe || revealKeysActiveState ? `🔑${k}` : "🔑؟";
    const stacks = (p.skillBoostStacks ?? 0) > 0 && isMe ? ` · ⚡×${p.skillBoostStacks}` : "";
    row.innerHTML = `<span>${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}</span><span>${p.eliminated ? "خرج" : "نشط"} · ❤️ ${p.hearts} · ⭐ ${points} · ${keysShown}${stacks}${roundTag}${bonus}</span>`;
    panel.appendChild(row);
  }
}

function renderLeaderboard(): void {
  const box = app.querySelector<HTMLDivElement>("#res-leaderboard");
  if (!box) return;
  if (!currentLeaderboard.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<h3 class="text-lg font-bold mb-2 text-amber-200">لوحة المتصدرين</h3>`;
  const list = document.createElement("div");
  list.className = "players-panel";
  currentLeaderboard.forEach((row) => {
    const item = document.createElement("div");
    item.className = "players-panel__row";
    const medal =
      row.medal === "gold"
        ? "🥇"
        : row.medal === "silver"
          ? "🥈"
          : row.medal === "bronze"
            ? "🥉"
            : "";
    item.innerHTML = `<span>${medal} #${row.rank} ${escapeHtml(row.name)}</span><span>⭐ ${row.skillPoints}</span>`;
    list.appendChild(item);
  });
  box.appendChild(list);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function abilityErrorMessage(code: string): string {
  const m: Record<string, string> = {
    not_enough_keys: "لا تكفي المفاتيح.",
    question_closed: "انتهى وقت السؤال أو السؤال غير نشط.",
    attacks_disabled: "هجمات القلب معطّلة في هذه الجولة.",
    invalid_target: "هدف غير صالح.",
    not_eligible: "لا يمكنك استخدام القدرة الآن.",
    not_in_match: "أنت خارج المباراة.",
    already_answered: "أرسلت إجابة بالفعل.",
    already_skipped: "استخدمت التجاوز لهذا السؤال.",
    reveal_disabled_direct: "كشف المفاتيح غير مفعّل في النمط المباشر.",
    reveal_not_available: "الكشف غير متاح الآن.",
    reveal_already_active: "الكشف مفعّل بالفعل لهذا البلوك.",
    match_finished: "انتهت المباراة.",
    invalid_body: "طلب غير صالح.",
    ability_disabled: "هذه القدرة معطّلة في هذا النمط حالياً.",
  };
  return m[code] ?? "تعذر تنفيذ القدرة.";
}

function myKeysCount(): number {
  return currentMatchPlayers.find((p) => p.socketId === mySocketId)?.keys ?? 0;
}

function patchMyKeysCount(next: number): void {
  currentMatchPlayers = currentMatchPlayers.map((p) =>
    p.socketId === mySocketId ? { ...p, keys: Math.max(0, next) } : p,
  );
  refreshKeysBadge();
  refreshAbilityAffordability();
}

function applyAbilityCostsPayload(c?: Partial<AbilityCostsPayload> | null): void {
  if (!c) return;
  if (typeof c.skillBoost === "number") abilityCostsState.skillBoost = c.skillBoost;
  if (typeof c.skipQuestion === "number") abilityCostsState.skipQuestion = c.skipQuestion;
  if (typeof c.heartAttack === "number") abilityCostsState.heartAttack = c.heartAttack;
  if (typeof c.reveal === "number") abilityCostsState.reveal = c.reveal;
  refreshAbilityAffordability();
}

function applyAbilityTogglesPayload(t?: Partial<AbilityTogglesPayload> | null): void {
  if (!t) return;
  if (typeof t.skillBoost === "boolean") abilityTogglesState.skillBoost = t.skillBoost;
  if (typeof t.skipQuestion === "boolean") abilityTogglesState.skipQuestion = t.skipQuestion;
  if (typeof t.heartAttack === "boolean") abilityTogglesState.heartAttack = t.heartAttack;
  if (typeof t.reveal === "boolean") abilityTogglesState.reveal = t.reveal;
  keysAttacksEnabledState = abilityTogglesState.heartAttack;
  refreshAbilityAffordability();
}

function refreshAbilityAffordability(): void {
  const k = myKeysCount();
  const c = abilityCostsState;
  const boostVisible = abilityTogglesState.skillBoost;
  const skipVisible = abilityTogglesState.skipQuestion;
  const attackVisible = abilityTogglesState.heartAttack && keysAttacksEnabledState;
  const revealVisible = abilityTogglesState.reveal;
  const boost = document.querySelector<HTMLButtonElement>("#ab-boost");
  const skip = document.querySelector<HTMLButtonElement>("#ab-skip");
  const attack = document.querySelector<HTMLButtonElement>("#ab-attack");
  const reveal = document.querySelector<HTMLButtonElement>("#ab-reveal");
  const setAbilityVisible = (el: HTMLButtonElement | null, visible: boolean): void => {
    if (!el) return;
    el.classList.toggle("hidden", !visible);
    el.style.display = visible ? "" : "none";
  };
  setAbilityVisible(boost, boostVisible);
  setAbilityVisible(skip, skipVisible);
  setAbilityVisible(attack, attackVisible);
  setAbilityVisible(reveal, revealVisible);

  boost?.classList.toggle("ability-btn--insufficient", boostVisible && k < c.skillBoost);
  skip?.classList.toggle("ability-btn--insufficient", skipVisible && k < c.skipQuestion);
  attack?.classList.toggle("ability-btn--insufficient", attackVisible && k < c.heartAttack);
  reveal?.classList.toggle("ability-btn--insufficient", revealVisible && k < c.reveal);
}

function flashKeysBadgeReward(): void {
  const run = (el: Element | null): void => {
    if (!el) return;
    el.classList.remove("keys-badge--reward-glow");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("keys-badge--reward-glow");
    const done = (): void => {
      el.classList.remove("keys-badge--reward-glow");
    };
    el.addEventListener("animationend", done, { once: true });
    window.setTimeout(done, 1100);
  };
  run(document.querySelector("#keys-badge"));
}

function showInsufficientAbilityTip(anchor: HTMLElement, requiredKeys: number): void {
  document.querySelectorAll(".ability-insufficient-tip").forEach((el) => el.remove());
  const tip = document.createElement("div");
  tip.className = "ability-insufficient-tip";
  tip.setAttribute("role", "status");
  tip.textContent = `تحتاج الى ${Math.max(1, Math.floor(requiredKeys))} مفتاح`;
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  tip.style.position = "fixed";
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${r.top}px`;
  tip.style.transform = "translate(-50%, calc(-100% - 6px))";
  tip.style.zIndex = "80";
  window.setTimeout(() => tip.remove(), 2200);
}

function refreshKeysBadge(): void {
  const el = document.querySelector<HTMLSpanElement>("#keys-badge");
  if (el) el.textContent = `🔑 ${myKeysCount()}`;
}

function flashKeysBadge(): void {
  document.querySelector("#keys-badge")?.classList.add("keys-badge--flash");
  window.setTimeout(() => {
    document.querySelector("#keys-badge")?.classList.remove("keys-badge--flash");
  }, 600);
}

/** اهتزاز أحمر لشارة المفاتيح بعد فشل القدرة وRollback */
function shakeKeysBadgeError(): void {
  const run = (el: Element | null): void => {
    if (!el) return;
    el.classList.remove("keys-error-shake");
    void (el as HTMLElement).offsetWidth;
    el.classList.add("keys-error-shake");
    window.setTimeout(() => {
      el.classList.remove("keys-error-shake");
    }, 620);
  };
  run(document.querySelector("#keys-badge"));
}

function showGameToast(message: string): void {
  let root = document.querySelector<HTMLDivElement>("#toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.className = "toast-root";
    document.body.appendChild(root);
  }
  const t = document.createElement("div");
  t.className = "toast-item";
  t.textContent = message;
  root.appendChild(t);
  window.setTimeout(() => {
    t.remove();
  }, 3200);
}

function mergeKeysFromServerList(
  list: Array<{
    socketId: string;
    name?: string;
    hearts?: number;
    eliminated?: boolean;
    isSpectator?: boolean;
    skillPoints?: number;
    lastAward?: number;
    keys?: number;
    skillBoostStacks?: number;
  }>,
  opts?: { keyRewardGlow?: boolean },
): void {
  const prevMe =
    mySocketId && opts?.keyRewardGlow
      ? (currentMatchPlayers.find((p) => p.socketId === mySocketId)?.keys ?? 0)
      : 0;
  currentMatchPlayers = currentMatchPlayers.map((old) => {
    const n = list.find((x) => x.socketId === old.socketId);
    if (!n) return old;
    return {
      ...old,
      ...(n.name !== undefined ? { name: n.name } : {}),
      ...(n.hearts !== undefined ? { hearts: n.hearts } : {}),
      ...(n.eliminated !== undefined ? { eliminated: n.eliminated } : {}),
      ...(n.isSpectator !== undefined ? { isSpectator: n.isSpectator } : {}),
      ...(n.skillPoints !== undefined ? { skillPoints: n.skillPoints } : {}),
      ...(n.lastAward !== undefined ? { lastAward: n.lastAward } : {}),
      ...(n.keys !== undefined ? { keys: n.keys } : {}),
      ...(n.skillBoostStacks !== undefined ? { skillBoostStacks: n.skillBoostStacks } : {}),
    };
  });
  refreshKeysBadge();
  refreshAbilityAffordability();
  if (opts?.keyRewardGlow && mySocketId) {
    const nextMe = currentMatchPlayers.find((p) => p.socketId === mySocketId)?.keys ?? prevMe;
    if (nextMe > prevMe) flashKeysBadgeReward();
  }
}

/**
 * دمج حالة المفاتيح/الكشف من `keys_room_state` أو من `question_result`.
 * `skipPanelRender`: عند دمج `question_result` مع `lastRoundResult` يُؤجَّل الرسم لإطار واحد.
 */
function applyKeysRoomSlice(
  payload: {
    revealKeysActive?: boolean;
    keysAttacksEnabled?: boolean;
    abilityCosts?: Partial<AbilityCostsPayload> | null;
    abilityToggles?: Partial<AbilityTogglesPayload> | null;
    players?: Array<{
      socketId: string;
      name?: string;
      hearts?: number;
      eliminated?: boolean;
      isSpectator?: boolean;
      skillPoints?: number;
      lastAward?: number;
      keys?: number;
      skillBoostStacks?: number;
    }>;
  },
  options?: { skipPanelRender?: boolean; keyRewardGlow?: boolean },
): void {
  if (typeof payload.revealKeysActive === "boolean") {
    revealKeysActiveState = payload.revealKeysActive;
  }
  if (typeof payload.keysAttacksEnabled === "boolean") {
    keysAttacksEnabledState = payload.keysAttacksEnabled;
  }
  if (payload.abilityCosts) applyAbilityCostsPayload(payload.abilityCosts);
  if (payload.abilityToggles) applyAbilityTogglesPayload(payload.abilityToggles);
  if (payload.players) mergeKeysFromServerList(payload.players, { keyRewardGlow: options?.keyRewardGlow });
  if (!options?.skipPanelRender && phase === "playing") renderPlayingPlayersPanel();
}

function bindPlayingAbilityUi(sk: Socket): void {
  const boost = document.querySelector<HTMLButtonElement>("#ab-boost");
  const skip = document.querySelector<HTMLButtonElement>("#ab-skip");
  const attack = document.querySelector<HTMLButtonElement>("#ab-attack");
  const reveal = document.querySelector<HTMLButtonElement>("#ab-reveal");
  const overlay = document.querySelector<HTMLDivElement>("#attack-overlay");
  const bubbles = document.querySelector<HTMLDivElement>("#attack-bubbles");
  const attackClose = document.querySelector<HTMLButtonElement>("#attack-close");

  const runAbility = (
    btn: HTMLButtonElement | null,
    eventName: string,
    payload: unknown,
    optimisticDelta: number | null,
  ): void => {
    if (!btn || btn.disabled) return;
    if (optimisticDelta !== null && myKeysCount() + optimisticDelta < 0) return;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("ability-btn--busy");
    const prev = myKeysCount();
    if (optimisticDelta !== null) {
      patchMyKeysCount(prev + optimisticDelta);
      flashKeysBadge();
    }
    const tmr = window.setTimeout(() => {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.classList.remove("ability-btn--busy");
    }, 4800);
    sk.emit(
      eventName,
      payload ?? {},
      (ack: { ok?: boolean; error?: string; keys?: number; skillBoostStacks?: number; revealQuestions?: number }) => {
      window.clearTimeout(tmr);
      btn.classList.remove("ability-btn--busy");
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      if (ack?.ok) {
        if (typeof ack.keys === "number") {
          patchMyKeysCount(ack.keys);
        }
        if (typeof ack.skillBoostStacks === "number") {
          currentMatchPlayers = currentMatchPlayers.map((p) =>
            p.socketId === mySocketId ? { ...p, skillBoostStacks: ack.skillBoostStacks } : p,
          );
        }
        if (eventName === "ability_reveal_keys") {
          const revealQuestions = Number.isFinite(ack.revealQuestions) ? Math.max(1, Math.floor(ack.revealQuestions ?? 1)) : 1;
          showGameToast(`تم كشف مفاتيح الخصوم لمدة ${revealQuestions} اسئلة`);
        } else if (eventName === "ability_skill_boost") {
          showGameToast("تم تفعيل قدرة تعزيز نقاط المهارة");
        } else if (eventName === "ability_skip_question") {
          showGameToast("تم تجاوز السؤال");
        }
        return;
      }
      if (optimisticDelta !== null) {
        patchMyKeysCount(prev);
        shakeKeysBadgeError();
      }
      showGameToast(abilityErrorMessage(ack?.error ?? "unknown"));
      },
    );
  };

  boost?.replaceWith(boost.cloneNode(true));
  skip?.replaceWith(skip.cloneNode(true));
  attack?.replaceWith(attack.cloneNode(true));
  reveal?.replaceWith(reveal.cloneNode(true));
  attackClose?.replaceWith(attackClose.cloneNode(true));

  const b1 = document.querySelector<HTMLButtonElement>("#ab-boost");
  const s1 = document.querySelector<HTMLButtonElement>("#ab-skip");
  const a1 = document.querySelector<HTMLButtonElement>("#ab-attack");
  const r1 = document.querySelector<HTMLButtonElement>("#ab-reveal");
  const c1 = document.querySelector<HTMLButtonElement>("#attack-close");

  b1?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!abilityTogglesState.skillBoost) {
      showGameToast("قدرة تعزيز نقاط المهارة معطّلة في هذا النمط.");
      return;
    }
    if (myKeysCount() < abilityCostsState.skillBoost) {
      showInsufficientAbilityTip(b1, abilityCostsState.skillBoost);
      return;
    }
    runAbility(b1, "ability_skill_boost", {}, -abilityCostsState.skillBoost);
  });
  s1?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!abilityTogglesState.skipQuestion) {
      showGameToast("قدرة تجاوز السؤال دون قلب أو نقاط معطّلة في هذا النمط.");
      return;
    }
    if (myKeysCount() < abilityCostsState.skipQuestion) {
      showInsufficientAbilityTip(s1, abilityCostsState.skipQuestion);
      return;
    }
    runAbility(s1, "ability_skip_question", {}, -abilityCostsState.skipQuestion);
  });
  r1?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!abilityTogglesState.reveal) {
      showGameToast("قدرة كشف مفاتيح الجميع معطّلة في هذا النمط.");
      return;
    }
    if (myKeysCount() < abilityCostsState.reveal) {
      showInsufficientAbilityTip(r1, abilityCostsState.reveal);
      return;
    }
    runAbility(r1, "ability_reveal_keys", {}, -abilityCostsState.reveal);
  });

  a1?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!abilityTogglesState.heartAttack || !keysAttacksEnabledState) {
      showGameToast("قدرة هجوم على قلب معطّلة في هذا النمط.");
      return;
    }
    if (myKeysCount() < abilityCostsState.heartAttack) {
      showInsufficientAbilityTip(a1, abilityCostsState.heartAttack);
      return;
    }
    if (!overlay || !bubbles) return;
    bubbles.innerHTML = "";
    for (const p of currentMatchPlayers) {
      if (p.socketId === mySocketId) continue;
      if (p.eliminated || p.hearts <= 0) continue;
      const wrap = document.createElement("button");
      wrap.type = "button";
      wrap.className = "attack-bubble";
      const circle = document.createElement("span");
      circle.className = "attack-bubble__circle";
      circle.textContent = (p.name || "?").slice(0, 2);
      const hearts = document.createElement("span");
      hearts.textContent = `❤️×${p.hearts}`;
      wrap.appendChild(circle);
      wrap.appendChild(hearts);
      wrap.addEventListener("click", () => {
        if (myKeysCount() < abilityCostsState.heartAttack) {
          showInsufficientAbilityTip(a1, abilityCostsState.heartAttack);
          return;
        }
        wrap.classList.add("attack-bubble--pop");
        window.setTimeout(() => {
          overlay.hidden = true;
          runAbility(a1, "ability_heart_attack", { targetSocketId: p.socketId }, -abilityCostsState.heartAttack);
        }, 380);
      });
      bubbles.appendChild(wrap);
    }
    overlay.hidden = false;
  });

  c1?.addEventListener("click", () => {
    if (overlay) overlay.hidden = true;
  });

  refreshAbilityAffordability();
}

function connectSocket(name: string, mode: GameMode): void {
  const joinFlowStartMs = performance.now();
  socket?.removeAllListeners();
  socket?.disconnect();

  currentGameMode = mode;

  const s = io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
  });
  socket = s;
  let joinAckTimer: number | null = null;
  let joinCompleted = false;

  const failBackToName = (msg: string): void => {
    if (joinAckTimer) {
      window.clearTimeout(joinAckTimer);
      joinAckTimer = null;
    }
    joinCompleted = true;
    phase = "name";
    render();
    const errEl = document.querySelector<HTMLParagraphElement>("#join-err");
    if (errEl) errEl.textContent = msg;
  };

  lobbyPlayersList = [];

  let cdInterval: number | null = null;

  const DEFAULT_LOBBY_COUNTDOWN_SEC = 5;

  function startCountdownTicks(initialLeft: number): void {
    if (cdInterval) {
      window.clearInterval(cdInterval);
      cdInterval = null;
    }
    let left = Math.max(1, Math.floor(initialLeft));
    const cd = app.querySelector<HTMLDivElement>("#cd");
    const show = (): void => {
      if (cd) cd.textContent = String(left);
    };
    show();
    cdInterval = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        if (cdInterval) window.clearInterval(cdInterval);
        cdInterval = null;
      } else show();
    }, 1000);
  }

  s.on("connect", () => {
    mySocketId = s.id ?? null;
    console.debug("[join-flow] click->connect_ms", Math.round(performance.now() - joinFlowStartMs));
    const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
    if (noticeEl && phase === "matchmaking") {
      noticeEl.textContent = "تم الاتصال بالخادم. جاري الدخول إلى البحث...";
    }
    joinAckTimer = window.setTimeout(() => {
      if (joinCompleted) return;
      failBackToName("تأخر الاتصال. تحقق من الشبكة ثم حاول مرة أخرى.");
      socket?.disconnect();
    }, 8000);
    s.emit("join_lobby", { name, mode }, (ack: { ok?: boolean }) => {
      if (joinAckTimer) {
        window.clearTimeout(joinAckTimer);
        joinAckTimer = null;
      }
      joinCompleted = true;
      if (!ack?.ok) {
        failBackToName("تعذر الدخول. حاول مرة أخرى.");
        return;
      }
      console.debug("[join-flow] connect->join_ack_ms", Math.round(performance.now() - joinFlowStartMs));
      if (phase !== "matchmaking") {
        phase = "matchmaking";
        render();
      } else {
        const noticeEl2 = app.querySelector<HTMLParagraphElement>("#lobby-notice");
        if (noticeEl2) noticeEl2.textContent = "تم الدخول بنجاح. جاري البحث عن منافسين...";
      }
    });
  });

  s.on("connect_error", () => {
    if (joinCompleted) return;
    failBackToName("تعذر الاتصال بالخادم. حاول مرة أخرى.");
  });

  s.on("disconnect", () => {
    updateConnectionBadge();
  });

  s.on(
    "lobby_state",
    (payload: {
      mode?: GameMode;
      players: { socketId: string; name: string; ready: boolean }[];
      isStarting?: boolean;
      participantSocketIds?: string[];
      maxPlayersPerMatch?: number;
      countdownSecondsRemaining?: number;
    }) => {
      if (phase !== "matchmaking" && phase !== "countdown") return;
      if (payload.mode) currentGameMode = payload.mode;
      currentMatchPlayers = payload.players.map((p) => ({
        socketId: p.socketId,
        name: p.name,
        hearts: 3,
        eliminated: false,
      }));
      const participants = payload.participantSocketIds ?? [];
      const isSelected =
        participants.length === 0 || (mySocketId ? participants.includes(mySocketId) : false);

      if (phase === "countdown") {
        if (!isSelected) {
          if (cdInterval) {
            window.clearInterval(cdInterval);
            cdInterval = null;
          }
          lobbyNotice = LOBBY_MSG_WAIT_NEXT;
          lobbyPlayersList = payload.players;
          phase = "matchmaking";
          render();
          return;
        }
        if (payload.isStarting && typeof payload.countdownSecondsRemaining === "number") {
          startCountdownTicks(payload.countdownSecondsRemaining);
        }
      }

      if (
        phase === "matchmaking" &&
        payload.isStarting &&
        mySocketId &&
        participants.length > 0 &&
        isSelected
      ) {
        lobbyNotice = "";
        lobbyPlayersList = payload.players;
        phase = "countdown";
        render();
        startCountdownTicks(
          Math.max(1, payload.countdownSecondsRemaining ?? DEFAULT_LOBBY_COUNTDOWN_SEC),
        );
      } else if (
        phase === "matchmaking" &&
        payload.isStarting &&
        mySocketId &&
        participants.length > 0 &&
        !isSelected
      ) {
        lobbyNotice = LOBBY_MSG_WAIT_NEXT;
      }

      lobbyPlayersList = payload.players;
      if (phase === "matchmaking") {
        syncMatchmakingStatusText();
        const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
        if (noticeEl) noticeEl.textContent = lobbyNotice;
      }
      updateConnectionBadge();
      updateLobbyModeLabel();
    },
  );

  s.on("match_starting", (payload: { seconds: number; participantSocketIds?: string[] }) => {
    const participants = payload.participantSocketIds ?? [];
    const isSelected =
      participants.length === 0 || (mySocketId ? participants.includes(mySocketId) : false);
    if (!isSelected) {
      lobbyNotice = LOBBY_MSG_WAIT_NEXT;
      if (phase === "countdown") {
        if (cdInterval) {
          window.clearInterval(cdInterval);
          cdInterval = null;
        }
        phase = "matchmaking";
        render();
      } else if (phase === "matchmaking") {
        render();
      }
      return;
    }
    if (phase === "countdown") {
      startCountdownTicks(Math.max(1, payload.seconds));
      return;
    }
    if (phase !== "matchmaking") return;
    lobbyNotice = "";
    phase = "countdown";
    render();
    startCountdownTicks(Math.max(1, payload.seconds));
  });

  s.on("match_start_cancelled", () => {
    if (cdInterval) {
      window.clearInterval(cdInterval);
      cdInterval = null;
    }
    if (phase === "countdown") {
      phase = "matchmaking";
    }
    lobbyNotice = LOBBY_MSG_CANCELLED;
    if (phase === "matchmaking") render();
  });

  s.on(
    "game_started",
    (payload: {
      matchId?: string;
      gameMode?: GameMode;
      revealKeysActive?: boolean;
      keysAttacksEnabled?: boolean;
      abilityCosts?: Partial<AbilityCostsPayload> | null;
      abilityToggles?: Partial<AbilityTogglesPayload> | null;
      players?: Array<{
        socketId: string;
        name: string;
        hearts: number;
        eliminated: boolean;
        isSpectator?: boolean;
        skillPoints?: number;
        lastAward?: number;
        keys?: number;
        skillBoostStacks?: number;
      }>;
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      if (payload.gameMode) currentGameMode = payload.gameMode;
      revealKeysActiveState = Boolean(payload.revealKeysActive);
      keysAttacksEnabledState = payload.keysAttacksEnabled !== false;
      applyAbilityTogglesPayload(payload.abilityToggles ?? null);
      lobbyNotice = "";
      if (payload.players) {
        currentMatchPlayers = payload.players.map((p) => ({
          ...p,
          keys: p.keys ?? 0,
          skillBoostStacks: p.skillBoostStacks ?? 0,
          skillPoints: p.skillPoints ?? 0,
          lastAward: p.lastAward ?? 0,
        }));
      }
      applyAbilityCostsPayload(payload.abilityCosts ?? null);
      refreshKeysBadge();
      refreshAbilityAffordability();
      spectatorEligible = false;
      spectatorFollowing = false;
      if (payload.gameMode === "study_then_quiz") {
        phase = "studying";
        studyCards = [];
        studyEndsAt = nowSynced();
        studyStartsAt = studyEndsAt;
        studyDurationMs = 0;
        readyBtnState = "idle";
        studyPhaseState = "idle";
        activeStudyRoundToken = null;
        activeStudyMacroRound = 0;
        render();
      } else {
        phase = "playing";
        render();
      }
    },
  );

  s.on(
    "round_ready_window",
    (payload: {
      roundToken?: string;
      startsAt?: number;
      endsAt: number;
      serverNow?: number;
      macroRound?: number;
    }) => {
      syncClock(payload.serverNow);
      phase = "studying";
      activeStudyRoundToken = payload.roundToken ?? null;
      activeStudyMacroRound = payload.macroRound ?? activeStudyMacroRound;
      studyPhaseState = "ready_window";
      readyBtnState = "window_open";
      studyEndsAt = payload.endsAt;
      studyStartsAt = payload.startsAt ?? payload.serverNow ?? nowSynced();
      studyDurationMs = Math.max(1000, studyEndsAt - studyStartsAt);
      if (!app.querySelector("#study-cards")) render();
      const readyBtn = app.querySelector<HTMLButtonElement>("#round-ready-btn");
      const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
      if (readyBtn) {
        readyBtn.disabled = false;
        readyBtn.textContent = "جاهز للجولة (تخطي العداد عند جاهزية الجميع)";
      }
      if (readyStateEl) {
        readyStateEl.textContent = "نافذة الجاهزية مفتوحة الآن.";
      }
      startStudyTimer();
    },
  );

  s.on(
    "study_phase",
    (payload: {
      cards: Array<{ id: number; questionId?: number; body: string; order: number }>;
      roundToken?: string;
      startsAt?: number;
      endsAt: number;
      serverNow?: number;
      macroRound?: number;
      scope?: string;
    }) => {
      syncClock(payload.serverNow);
      if (payload.roundToken) {
        activeStudyRoundToken = payload.roundToken;
      }
      if (typeof payload.macroRound === "number") {
        activeStudyMacroRound = payload.macroRound;
      }
      studyCards = payload.cards ?? [];
      studyEndsAt = payload.endsAt;
      studyStartsAt = payload.startsAt ?? payload.serverNow ?? nowSynced();
      studyDurationMs = Math.max(1000, studyEndsAt - studyStartsAt);
      phase = "studying";
      studyPhaseState = "study_content";
      if (!app.querySelector("#study-cards")) render();
      const container = app.querySelector<HTMLDivElement>("#study-cards");
      const readyBtn = app.querySelector<HTMLButtonElement>("#round-ready-btn");
      const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
      if (readyBtn) {
        readyBtn.disabled = readyBtnState !== "window_open";
        readyBtn.textContent =
          readyBtnState === "submitted"
            ? "تم تسجيل جاهزيتك"
            : "جاهز للجولة (تخطي العداد عند جاهزية الجميع)";
      }
      if (readyStateEl) {
        readyStateEl.textContent =
          readyBtnState === "window_open"
            ? "المذاكرة بدأت — ما زالت نافذة الجاهزية مفتوحة."
            : readyBtnState === "submitted"
              ? "المذاكرة بدأت — تم إرسال جاهزيتك."
              : "";
      }
      if (container) {
        container.innerHTML = "";
        studyCards.forEach((c, i) => {
          const card = document.createElement("div");
          const variant = Math.abs(c.order) % 6;
          card.className = `study-card study-card--${variant}`;
          card.style.animationDelay = `${i * 0.08}s`;
          card.innerHTML = `<p class="study-card__body font-medium">${escapeHtml(c.body)}</p>`;
          container.appendChild(card);
        });
      }
      startStudyTimer();
    },
  );

  s.on(
    "study_phase_end",
    (payload: {
      roundToken?: string;
      macroRound?: number;
      startsAt?: number;
      studyEndsAt?: number;
      serverNow?: number;
    }) => {
      syncClock(payload.serverNow);
      if (!isCurrentStudyRound(payload.roundToken, payload.macroRound)) return;
      studyPhaseState = "transition_to_question";
      readyBtnState = "closed";
      const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
      if (readyStateEl && phase === "studying") {
        readyStateEl.textContent = "أُغلقت نافذة الجاهزية.";
      }
      clearTimer();
    },
  );

  s.on(
    "round_ready_closed",
    (payload: {
      roundToken?: string;
      startsAt?: number;
      endsAt?: number;
      serverNow?: number;
      macroRound?: number;
    }) => {
      syncClock(payload.serverNow);
      if (phase !== "studying") return;
      if (!isCurrentStudyRound(payload.roundToken, payload.macroRound)) return;
      if (studyPhaseState === "transition_to_question") return;
      studyPhaseState = "study_content";
      if (readyBtnState !== "submitted") {
        readyBtnState = "closed";
      }
      const readyBtn = app.querySelector<HTMLButtonElement>("#round-ready-btn");
      const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
      if (readyBtn) {
        readyBtn.disabled = true;
        readyBtn.textContent = "أُغلقت نافذة الجاهزية";
      }
      if (readyStateEl) {
        readyStateEl.textContent =
          readyBtnState === "submitted"
            ? "تم تسجيل جاهزيتك. المذاكرة مستمرة حتى انتهاء وقت البطاقات."
            : "أُغلقت نافذة الجاهزية. المذاكرة مستمرة حتى انتهاء وقت البطاقات.";
      }
    },
  );

  s.on(
    "question",
    (q: {
      questionId: number;
      prompt: string;
      options: string[];
      endsAt: number;
      serverNow?: number;
      revealKeysActive?: boolean;
      keysAttacksEnabled?: boolean;
      abilityCosts?: Partial<AbilityCostsPayload> | null;
      abilityToggles?: Partial<AbilityTogglesPayload> | null;
    }) => {
      syncClock(q.serverNow);
      if (spectatorEligible && !spectatorFollowing) return;
      currentQuestionId = q.questionId;
      endsAt = q.endsAt;
      currentMatchPlayers = currentMatchPlayers.map((p) => {
        const { lastRoundResult: _lr, ...rest } = p;
        return rest;
      });
      if (typeof q.revealKeysActive === "boolean") {
        revealKeysActiveState = q.revealKeysActive;
      }
      if (typeof q.keysAttacksEnabled === "boolean") {
        keysAttacksEnabledState = q.keysAttacksEnabled;
      }
      applyAbilityCostsPayload(q.abilityCosts ?? null);
      applyAbilityTogglesPayload(q.abilityToggles ?? null);
      phase = "playing";
      if (!app.querySelector("#q-text")) render();
      const text = app.querySelector<HTMLParagraphElement>("#q-text");
      const opts = app.querySelector<HTMLDivElement>("#opts");
      const status = app.querySelector<HTMLParagraphElement>("#status");
      if (!text || !opts) return;
      text.textContent = q.prompt;
      opts.innerHTML = "";
      let answered = false;
      q.options.forEach((label, idx) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "option-btn";
        b.textContent = label;
        const clearPressed = (): void => {
          b.classList.remove("option-btn--pressed");
        };
        const submitAnswer = (): void => {
          if (answered) return;
          if (spectatorFollowing) return;
          if (currentQuestionId == null) return;
          answered = true;
          b.classList.add("option-btn--selected");
          if (status) status.textContent = "تم إرسال إجابتك.";
          s.emit("answer", {
            questionId: currentQuestionId,
            choiceIndex: idx,
          });
          opts.querySelectorAll("button").forEach((btn) => {
            const htmlBtn = btn as HTMLButtonElement;
            htmlBtn.disabled = true;
            htmlBtn.classList.add("option-btn--disabled");
            htmlBtn.classList.remove("option-btn--pressed");
          });
        };
        b.addEventListener("pointerdown", () => {
          if (b.disabled) return;
          b.classList.add("option-btn--pressed");
        });
        b.addEventListener("pointercancel", clearPressed);
        b.addEventListener("pointerleave", clearPressed);
        b.addEventListener("pointerup", (ev) => {
          clearPressed();
          if (ev.pointerType !== "mouse") submitAnswer();
        });
        b.addEventListener("click", submitAnswer);
        opts.appendChild(b);
      });
      if (status) status.textContent = "";
      const spectatorBadge = app.querySelector<HTMLParagraphElement>("#spectator-badge");
      if (spectatorBadge) {
        spectatorBadge.textContent = spectatorFollowing ? "وضع المشاهد: يمكنك المتابعة بدون إجابة." : "";
      }
      startQuestionTimer();
      if (app.querySelector("#ab-boost")) {
        renderPlayingPlayersPanel();
        if (socket) bindPlayingAbilityUi(socket);
      }
    },
  );

  s.on(
    "question_result",
    (payload: {
      revealKeysActive?: boolean;
      keysAttacksEnabled?: boolean;
      abilityCosts?: Partial<AbilityCostsPayload> | null;
      abilityToggles?: Partial<AbilityTogglesPayload> | null;
      results?: Array<{
        socketId: string;
        correct: boolean;
        skipped?: boolean;
        pointsAward?: number;
        hearts: number;
        eliminated: boolean;
      }>;
      players: {
        socketId: string;
        hearts: number;
        eliminated: boolean;
        skillPoints?: number;
        lastAward?: number;
        isSpectator?: boolean;
        keys?: number;
        skillBoostStacks?: number;
      }[];
    }) => {
      applyKeysRoomSlice(
        {
          revealKeysActive: payload.revealKeysActive,
          keysAttacksEnabled: payload.keysAttacksEnabled,
          abilityCosts: payload.abilityCosts,
          abilityToggles: payload.abilityToggles,
          players: payload.players,
        },
        { skipPanelRender: true, keyRewardGlow: true },
      );
      const me = payload.players.find((p) => p.socketId === mySocketId);
      if (me && phase === "playing") renderHearts(me.hearts);
      const results = payload.results ?? [];
      currentMatchPlayers = currentMatchPlayers.map((player) => {
        const next = payload.players.find((p) => p.socketId === player.socketId);
        const rr = results.find((r) => r.socketId === player.socketId);
        const lastRoundResult = rr
          ? rr.skipped
            ? ("skipped" as const)
            : rr.correct
              ? ("correct" as const)
              : ("wrong" as const)
          : undefined;
        if (!next) {
          const { lastRoundResult: _lr, ...rest } = player;
          return rest;
        }
        return {
          ...player,
          hearts: next.hearts,
          eliminated: next.eliminated,
          skillPoints: next.skillPoints ?? player.skillPoints ?? 0,
          lastAward: next.lastAward ?? 0,
          isSpectator: next.isSpectator ?? player.isSpectator ?? false,
          keys: next.keys ?? player.keys ?? 0,
          skillBoostStacks: next.skillBoostStacks ?? player.skillBoostStacks ?? 0,
          lastRoundResult,
        };
      });
      refreshKeysBadge();
      renderPlayingPlayersPanel();
      const status = app.querySelector<HTMLParagraphElement>("#status");
      if (status) status.textContent = "جاري السؤال التالي…";
    },
  );

  s.on(
    "game_over",
    (payload: {
      outcomeType?: "no_questions" | "single_winner" | "shared_winners" | "tie_all_zero";
      winner: { socketId: string; name: string } | null;
      winners?: Array<{ socketId: string; name: string }>;
      players: {
        socketId: string;
        name: string;
        hearts: number;
        eliminated: boolean;
        skillPoints?: number;
        lastAward?: number;
        isSpectator?: boolean;
      }[];
      reason?: string;
      resultMessages?: {
        winnerTitle?: string;
        loserTitle?: string;
        tieTitle?: string;
        winner: string;
        loser: string;
        tie: string;
      };
      leaderboard?: Array<{
        rank: number;
        name: string;
        skillPoints: number;
        medal: "gold" | "silver" | "bronze" | null;
      }>;
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      clearTimer();
      phase = "result";
      render();
      const me = payload.players.find((p) => p.socketId === mySocketId);
      currentMatchPlayers = payload.players.map((p) => ({ ...p }));
      currentLeaderboard = payload.leaderboard ?? [];
      const title = app.querySelector<HTMLHeadingElement>("#res-title");
      const body = app.querySelector<HTMLParagraphElement>("#res-body");
      const kicker = app.querySelector<HTMLParagraphElement>("#res-kicker");
      const stats = app.querySelector<HTMLDivElement>("#res-stats");
      const againBtn = app.querySelector<HTMLButtonElement>("#again");
      if (!title || !body) return;
      if (kicker) kicker.hidden = true;
      const rm = payload.resultMessages;
      const winTitle = rm?.winnerTitle?.trim() || DEFAULT_RESULT_MESSAGES.winnerTitle;
      const loseTitle = rm?.loserTitle?.trim() || DEFAULT_RESULT_MESSAGES.loserTitle;
      const tieTitle = rm?.tieTitle?.trim() || DEFAULT_RESULT_MESSAGES.tieTitle;
      const winCopy = rm?.winner?.trim() || DEFAULT_RESULT_MESSAGES.winner;
      const loseCopy = rm?.loser?.trim() || DEFAULT_RESULT_MESSAGES.loser;
      const tieCopy = rm?.tie?.trim() || DEFAULT_RESULT_MESSAGES.tie;
      if (payload.reason === "no_questions" || payload.outcomeType === "no_questions") {
        title.textContent = "لا توجد أسئلة";
        body.textContent = "أضف أسئلة إلى قاعدة البيانات ثم أعد المحاولة.";
        if (stats) stats.classList.add("hidden");
        if (againBtn) againBtn.textContent = "العودة والمحاولة لاحقًا";
        applyResultScreenPresentation("empty", "");
        return;
      }
      const winners = payload.winners ?? (payload.winner ? [payload.winner] : []);
      const iAmWinner = winners.some((w) => w.socketId === mySocketId);
      let kind: ResultScreenKind = "tie";
      let emojiForFallback = "🤝";
      if (iAmWinner) {
        kind = "win";
        emojiForFallback = "🎉";
        if (winners.length > 1) {
          title.textContent = winTitle;
          body.textContent = `${winCopy} — فائزون معك: ${winners.map((w) => w.name).join("، ")}`;
        } else {
          title.textContent = winTitle;
          body.textContent = winCopy;
        }
        if (againBtn) againBtn.textContent = "العب مجددًا";
      } else if (winners.length > 0) {
        kind = "lose";
        emojiForFallback = "💔";
        title.textContent = loseTitle;
        body.textContent =
          winners.length === 1
            ? `${loseCopy} (الفائز: ${winners[0]?.name ?? "-"})`
            : `${loseCopy} (فائزون مشتركون: ${winners.map((w) => w.name).join("، ")})`;
        if (againBtn) againBtn.textContent = "حاول مرة أخرى";
      } else {
        kind = "tie";
        emojiForFallback = "🤝";
        title.textContent = tieTitle;
        body.textContent = tieCopy;
        if (againBtn) againBtn.textContent = "جولة جديدة";
      }
      if (stats) {
        if (me) {
          stats.innerHTML = `<span class="result-screen__stat-chip">❤️ القلوب: ${me.hearts}</span><span class="result-screen__stat-chip">⭐ النقاط: ${me.skillPoints ?? 0}</span>`;
          stats.classList.remove("hidden");
        } else {
          stats.classList.add("hidden");
          stats.innerHTML = "";
        }
      }
      renderLeaderboard();
      applyResultScreenPresentation(kind, emojiForFallback);
    },
  );

  s.on(
    "keys_room_state",
    (payload: {
      revealKeysActive?: boolean;
      abilityCosts?: Partial<AbilityCostsPayload> | null;
      abilityToggles?: Partial<AbilityTogglesPayload> | null;
      players?: Array<{
        socketId: string;
        name: string;
        hearts: number;
        eliminated: boolean;
        isSpectator?: boolean;
        skillPoints?: number;
        lastAward?: number;
        keys?: number;
        skillBoostStacks?: number;
      }>;
    }) => {
      applyKeysRoomSlice({
        revealKeysActive: payload.revealKeysActive,
        abilityCosts: payload.abilityCosts,
        abilityToggles: payload.abilityToggles,
        players: payload.players,
      });
    },
  );

  s.on(
    "ability_heart_resolved",
    (payload: {
      attackerSocketId?: string;
      attackerName?: string;
      victimSocketId?: string;
      victimName?: string;
      outcome?: "hit" | "blocked";
      shieldCost?: number;
    }) => {
      const meId = mySocketId;
      const aName = payload.attackerName ?? "لاعب";
      const vName = payload.victimName ?? "لاعب";
      if (payload.victimSocketId === meId) {
        if (payload.outcome === "blocked") {
          showGameToast(`${aName} أطلق عليك صاروخاً — تصدّيت بمفاتيح!`);
        } else {
          showGameToast(`${aName} أطلق عليك صاروخاً — خسرت قلباً!`);
        }
      } else if (payload.attackerSocketId === meId) {
        if (payload.outcome === "blocked") {
          showGameToast(`${vName} تصدّى بمفاتيح (${payload.shieldCost ?? 2} مفتاحاً).`);
        } else {
          showGameToast(`أصبت ${vName} — خسر قلباً.`);
        }
      }
    },
  );

  s.on("player_eliminated", (p: { name: string; socketId?: string; reason?: string }) => {
    currentMatchPlayers = currentMatchPlayers.map((x) =>
      (p.socketId && x.socketId === p.socketId) || (!p.socketId && x.name === p.name)
        ? { ...x, eliminated: true, hearts: 0 }
        : x,
    );
    renderPlayingPlayersPanel();
    const status = app.querySelector<HTMLParagraphElement>("#status");
    if (status && phase === "playing") {
      status.textContent =
        p.reason === "disconnect"
          ? `${p.name} خرج من اللعبة.`
          : `${p.name} نفدت قلوبه.`;
    }
  });

  s.on("spectator_offer", (p: { socketId?: string }) => {
    if (!mySocketId || p.socketId !== mySocketId) return;
    spectatorEligible = true;
    phase = "result";
    render();
    const title = app.querySelector<HTMLHeadingElement>("#res-title");
    const body = app.querySelector<HTMLParagraphElement>("#res-body");
    const kicker = app.querySelector<HTMLParagraphElement>("#res-kicker");
    const stats = app.querySelector<HTMLDivElement>("#res-stats");
    const continueWatch = app.querySelector<HTMLButtonElement>("#continue-watch");
    if (kicker) kicker.hidden = true;
    if (title) title.textContent = "خرجت من الجولة";
    if (body) body.textContent = "يمكنك متابعة المباراة كمشاهد حتى النهاية.";
    if (stats) {
      stats.classList.add("hidden");
      stats.innerHTML = "";
    }
    if (continueWatch) continueWatch.classList.remove("hidden");
    applyResultScreenPresentation("lose", "💔");
  });

  s.on(
    "round_ready_state",
    (p: {
      roundToken?: string;
      macroRound?: number;
      readySocketIds: string[];
      totalActive: number;
    }) => {
      if (!isCurrentStudyRound(p.roundToken, p.macroRound)) return;
      const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
      if (readyStateEl && phase === "studying") {
        readyStateEl.textContent = `جاهزية اللاعبين: ${p.readySocketIds.length}/${p.totalActive}`;
      }
    },
  );

  s.connect();
}

function renderHearts(n: number): void {
  const h = app.querySelector<HTMLDivElement>("#hearts");
  if (!h) return;
  h.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const span = document.createElement("span");
    span.textContent = i < n ? "❤️" : "🖤";
    h.appendChild(span);
  }
}

function startQuestionTimer(): void {
  clearTimer();
  const clock = app.querySelector<HTMLDivElement>("#clock");
  if (!clock) return;
  timerHandle = window.setInterval(() => {
    const ms = Math.max(0, endsAt - nowSynced());
    const sec = Math.max(0, Math.floor((ms + 250) / 1000));
    clock.textContent = `${sec}s`;
  }, 200);
}

function startStudyTimer(): void {
  clearTimer();
  const mainClock = app.querySelector<HTMLDivElement>("#study-main-clock");
  const mainLabel = app.querySelector<HTMLParagraphElement>("#study-main-clock-label");
  const progressTrack = app.querySelector<HTMLDivElement>("#study-progress-track");
  const progressFill = app.querySelector<HTMLDivElement>("#study-progress-fill");
  if (!mainClock) return;
  timerHandle = window.setInterval(() => {
    const now = nowSynced();
    const studyMs = Math.max(0, studyEndsAt - now);
    const studySec = Math.max(0, Math.floor((studyMs + 250) / 1000));
    const totalMs = studyDurationMs > 0 ? studyDurationMs : Math.max(1000, studyEndsAt - studyStartsAt);
    const elapsedMs = Math.max(0, Math.min(totalMs, totalMs - studyMs));
    const ratio = totalMs > 0 ? elapsedMs / totalMs : 0;
    const percent = Math.max(0, Math.min(100, ratio * 100));

    if (mainClock) {
      mainClock.textContent = `${studySec}s`;
    }
    if (mainLabel) {
      mainLabel.textContent = `وقت المذاكرة — ${Math.round(percent)}%`;
    }
    if (progressFill) {
      progressFill.style.width = `${percent.toFixed(2)}%`;
    }
    if (progressTrack) {
      progressTrack.setAttribute("aria-valuenow", String(Math.round(percent)));
    }
  }, 200);
}

render();
startReleaseVersionWatch();
