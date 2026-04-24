import "./style.css";
import { io, type Socket } from "socket.io-client";

type GameMode = "direct" | "study_then_quiz";
type Phase = "name" | "lobby" | "countdown" | "studying" | "playing" | "result";

const app = document.querySelector<HTMLDivElement>("#app")!;

let socket: Socket | null = null;
let phase: Phase = "name";
let mySocketId: string | null = null;
let currentQuestionId: number | null = null;
let endsAt = 0;
let timerHandle: number | null = null;
let currentGameMode: GameMode | null = null;
let currentMatchPlayers: Array<{
  socketId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
}> = [];
let studyCards: Array<{
  id: number;
  questionId?: number;
  body: string;
  order: number;
}> = [];

const DEFAULT_RESULT_MESSAGES = {
  winner: "أحسنت — بقيت حتى النهاية.",
  loser: "انتهت الجولة لصالح لاعب آخر.",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
} as const;

const RESULT_VIDEO_SRC = {
  win: "/videos/win.mp4",
  lose: "/videos/lose.mp4",
  tie: "/videos/tie.mp4",
} as const;

type ResultScreenKind = "win" | "lose" | "tie" | "empty";

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
        <div class="min-h-screen bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-900 text-white flex flex-col items-center justify-center p-4">
          <div class="max-w-lg w-full space-y-6 text-center">
            <h1 class="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-l from-amber-300 to-orange-400">فاهم</h1>
            <p class="text-slate-300 text-lg">تحدٍّ سريع — من يبقى آخر يفوز؟</p>
            <div class="rounded-2xl bg-white/5 border border-white/10 p-6 shadow-xl backdrop-blur space-y-5">
              <label class="block text-right text-sm text-slate-400">اسمك في اللعبة</label>
              <input id="name-input" maxlength="32" type="text" placeholder="مثال: سارة" class="w-full rounded-xl bg-slate-900/80 border border-white/10 px-4 py-3 text-right text-lg outline-none focus:ring-2 focus:ring-amber-400/60" />
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
              <button id="join-btn" class="w-full rounded-xl bg-gradient-to-l from-amber-500 to-orange-600 py-3 text-lg font-bold text-slate-950 shadow-lg active:scale-[0.98] transition">دخول اللوبي</button>
              <p id="join-err" class="text-red-400 text-sm min-h-[1.25rem]"></p>
            </div>
          </div>
        </div>
      `),
    );
    const input = app.querySelector<HTMLInputElement>("#name-input")!;
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
      err.textContent = "";
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      connectSocket(name, selectedMode);
    });
    return;
  }

  if (phase === "lobby") {
    app.append(
      el(`
        <div class="min-h-screen bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-900 text-white p-4 flex flex-col max-w-lg mx-auto w-full">
          <header class="flex items-center justify-between py-4">
            <h1 class="text-2xl font-extrabold text-amber-300">فاهم</h1>
            <span id="conn" class="text-xs px-2 py-1 rounded-full bg-white/10">…</span>
          </header>
          <p id="lobby-mode" class="text-right text-sm text-slate-400 mb-2"></p>
          <div class="flex-1 flex flex-col gap-4">
            <div class="rounded-2xl bg-white/5 border border-white/10 p-4">
              <h2 class="text-lg font-bold mb-2 text-right">اللاعبون</h2>
              <ul id="players" class="space-y-2 text-right"></ul>
            </div>
            <button id="ready-btn" class="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 py-4 text-lg font-bold shadow-lg active:scale-[0.98] transition">جاهز للعب</button>
            <p class="text-center text-slate-400 text-sm">يُشترط لاعبان جاهزان على الأقل لبدء التحدي خلال ٣ ثوانٍ.</p>
          </div>
        </div>
      `),
    );
    updateConnectionBadge();
    updateLobbyModeLabel();
    return;
  }

  if (phase === "countdown") {
    app.append(
      el(`
        <div class="min-h-screen bg-gradient-to-b from-slate-950 to-indigo-950 text-white flex flex-col items-center justify-center p-6 text-center">
          <p class="text-slate-300 mb-4">تبدأ المباراة خلال</p>
          <div id="cd" class="text-7xl font-black text-amber-300 tabular-nums">٣</div>
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
          <div class="flex items-center justify-between gap-2 pt-1">
            <h2 class="text-lg font-bold text-amber-200 drop-shadow-sm">مراجعة قبل الأسئلة</h2>
            <div id="study-clock" class="text-xl font-mono font-bold text-emerald-300 tabular-nums drop-shadow-sm">—</div>
          </div>
          <p id="study-hint" class="text-right text-slate-300/90 text-sm min-h-[1.25rem] leading-relaxed"></p>
          <div id="study-cards" class="flex-1 space-y-4 overflow-y-auto max-h-[72vh] pb-4"></div>
        </div>
      `),
    );
    const hint = app.querySelector<HTMLParagraphElement>("#study-hint");
    if (hint) {
      hint.textContent = hasCards
        ? "اقرأ نص المذاكرة لكل سؤال — البطاقات تختفي عند انتهاء الوقت."
        : "جاري تجهيز الجولة…";
    }
    const container = app.querySelector<HTMLDivElement>("#study-cards");
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
    return;
  }
  if (phase === "playing") {
    app.append(
      el(`
        <div class="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950 text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="flex items-center justify-between gap-2">
            <div id="hearts" class="flex gap-1 text-2xl"></div>
            <div id="clock" class="text-xl font-mono font-bold text-amber-300 tabular-nums">—</div>
          </div>
          <div id="players-panel" class="players-panel"></div>
          <div id="q-card" class="rounded-2xl bg-white/5 border border-white/10 p-5 flex-1 flex flex-col gap-4 shadow-xl">
            <p id="q-text" class="text-right text-xl font-semibold leading-relaxed min-h-[4rem]"></p>
            <div id="opts" class="grid gap-2"></div>
          </div>
          <p id="status" class="text-center text-slate-400 text-sm min-h-[1.25rem]"></p>
        </div>
      `),
    );
    renderHearts(3);
    renderPlayingPlayersPanel();
    startQuestionTimer();
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
          <button id="again" type="button" class="result-screen__again w-full rounded-xl py-3 text-lg font-bold shadow-lg active:scale-[0.98] transition">العب مجدداً</button>
        </div>
      `),
    );
    const again = app.querySelector<HTMLButtonElement>("#again")!;
    again.addEventListener("click", () => {
      phase = "name";
      socket?.disconnect();
      socket = null;
      mySocketId = null;
      currentGameMode = null;
      studyCards = [];
      render();
    });
  }
}

function updateLobbyModeLabel(): void {
  const elMode = app.querySelector<HTMLParagraphElement>("#lobby-mode");
  if (!elMode || !currentGameMode) return;
  elMode.textContent =
    currentGameMode === "direct"
      ? "اللوبي: نمط مباشر"
      : "اللوبي: مراجعة ثم أسئلة";
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

function renderLobbyPlayers(
  list: { socketId: string; name: string; ready: boolean }[],
): void {
  const ul = app.querySelector<HTMLUListElement>("#players");
  const readyBtn = app.querySelector<HTMLButtonElement>("#ready-btn");
  if (!ul || !readyBtn) return;
  ul.innerHTML = "";
  for (const p of list) {
    const li = document.createElement("li");
    li.className =
      "flex items-center justify-between rounded-xl bg-slate-900/50 px-3 py-2 border border-white/5";
    const you = p.socketId === mySocketId ? " (أنت)" : "";
    li.innerHTML = `<span class="font-medium">${escapeHtml(p.name)}${you}</span><span class="text-sm ${p.ready ? "text-emerald-400" : "text-slate-500"}">${p.ready ? "جاهز" : "ينتظر"}</span>`;
    ul.appendChild(li);
  }
  readyBtn.onclick = () => {
    socket?.emit("player_ready", {}, () => undefined);
  };
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
    row.innerHTML = `<span>${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}</span><span>${p.eliminated ? "خرج" : "نشط"} · ❤️ ${p.hearts}</span>`;
    panel.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function connectSocket(name: string, mode: GameMode): void {
  socket?.removeAllListeners();
  socket?.disconnect();

  currentGameMode = mode;

  const s = io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
  });
  socket = s;

  let cdInterval: number | null = null;

  s.on("connect", () => {
    mySocketId = s.id ?? null;
    s.emit("join_lobby", { name, mode }, (ack: { ok?: boolean }) => {
      if (!ack?.ok) {
        phase = "name";
        render();
        const errEl = document.querySelector("#join-err");
        if (errEl) errEl.textContent = "تعذر الدخول. حاول مرة أخرى.";
        return;
      }
      phase = "lobby";
      render();
    });
  });

  s.on("disconnect", () => {
    updateConnectionBadge();
  });

  s.on(
    "lobby_state",
    (payload: {
      mode?: GameMode;
      players: { socketId: string; name: string; ready: boolean }[];
    }) => {
      if (phase !== "lobby") return;
      if (payload.mode) currentGameMode = payload.mode;
      currentMatchPlayers = payload.players.map((p) => ({
        socketId: p.socketId,
        name: p.name,
        hearts: 3,
        eliminated: false,
      }));
      renderLobbyPlayers(payload.players);
      updateConnectionBadge();
      updateLobbyModeLabel();
    },
  );

  s.on("match_starting", (payload: { seconds: number }) => {
    if (phase !== "lobby") return;
    phase = "countdown";
    render();
    let left = payload.seconds;
    const cd = app.querySelector<HTMLDivElement>("#cd");
    const arabic = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
    const show = () => {
      if (cd) cd.textContent = left <= 9 ? arabic[left] ?? String(left) : String(left);
    };
    show();
    cdInterval = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        if (cdInterval) window.clearInterval(cdInterval);
        cdInterval = null;
      } else show();
    }, 1000);
  });

  s.on(
    "game_started",
    (payload: {
      matchId?: string;
      gameMode?: GameMode;
      players?: Array<{
        socketId: string;
        name: string;
        hearts: number;
        eliminated: boolean;
      }>;
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      if (payload.gameMode) currentGameMode = payload.gameMode;
      if (payload.players) {
        currentMatchPlayers = payload.players.map((p) => ({ ...p }));
      }
      if (payload.gameMode === "study_then_quiz") {
        phase = "studying";
        studyCards = [];
        studyEndsAt = Date.now() + 60_000;
        render();
      } else {
        phase = "playing";
        render();
      }
    },
  );

  s.on(
    "study_phase",
    (payload: {
      cards: Array<{ id: number; questionId?: number; body: string; order: number }>;
      endsAt: number;
      macroRound?: number;
      scope?: string;
    }) => {
      studyCards = payload.cards ?? [];
      studyEndsAt = payload.endsAt;
      phase = "studying";
      if (!app.querySelector("#study-cards")) render();
      const container = app.querySelector<HTMLDivElement>("#study-cards");
      const hint = app.querySelector<HTMLParagraphElement>("#study-hint");
      if (hint) {
        const full =
          payload.scope === "match_start"
            ? "مراجعة لدفعة الأسئلة في المباراة — اقرأ كل نصوص المذاكرة قبل أول سؤال."
            : "اقرأ نصوص المذاكرة قبل متابعة الأسئلة.";
        hint.textContent =
          studyCards.length > 0 ? full : "جاري تجهيز الجولة…";
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

  s.on("study_phase_end", () => {
    const hint = app.querySelector<HTMLParagraphElement>("#study-hint");
    if (hint && phase === "studying") {
      hint.textContent = "انتهت المراجعة — تبدأ الأسئلة الآن.";
    }
  });

  s.on(
    "question",
    (q: {
      questionId: number;
      prompt: string;
      options: string[];
      endsAt: number;
    }) => {
      currentQuestionId = q.questionId;
      endsAt = q.endsAt;
      phase = "playing";
      if (!app.querySelector("#q-text")) render();
      const text = app.querySelector<HTMLParagraphElement>("#q-text");
      const opts = app.querySelector<HTMLDivElement>("#opts");
      const status = app.querySelector<HTMLParagraphElement>("#status");
      if (!text || !opts) return;
      text.textContent = q.prompt;
      opts.innerHTML = "";
      q.options.forEach((label, idx) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
          "w-full text-right rounded-xl border border-white/10 bg-slate-800/60 px-4 py-3 text-base font-medium hover:bg-slate-700/80 active:scale-[0.99] transition";
        b.textContent = label;
        b.addEventListener("click", () => {
          if (currentQuestionId == null) return;
          if (status) status.textContent = "تم إرسال إجابتك.";
          s.emit("answer", {
            questionId: currentQuestionId,
            choiceIndex: idx,
          });
          opts.querySelectorAll("button").forEach((btn) => {
            (btn as HTMLButtonElement).disabled = true;
          });
        });
        opts.appendChild(b);
      });
      if (status) status.textContent = "";
      startQuestionTimer();
    },
  );

  s.on(
    "question_result",
    (payload: {
      players: { socketId: string; hearts: number; eliminated: boolean }[];
    }) => {
      const me = payload.players.find((p) => p.socketId === mySocketId);
      if (me && phase === "playing") renderHearts(me.hearts);
      currentMatchPlayers = currentMatchPlayers.map((player) => {
        const next = payload.players.find((p) => p.socketId === player.socketId);
        return next
          ? { ...player, hearts: next.hearts, eliminated: next.eliminated }
          : player;
      });
      renderPlayingPlayersPanel();
      const status = app.querySelector<HTMLParagraphElement>("#status");
      if (status) status.textContent = "جاري السؤال التالي…";
    },
  );

  s.on(
    "game_over",
    (payload: {
      winner: { socketId: string; name: string } | null;
      players: { socketId: string; name: string; hearts: number; eliminated: boolean }[];
      reason?: string;
      resultMessages?: { winner: string; loser: string; tie: string };
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
      const title = app.querySelector<HTMLHeadingElement>("#res-title");
      const body = app.querySelector<HTMLParagraphElement>("#res-body");
      const kicker = app.querySelector<HTMLParagraphElement>("#res-kicker");
      if (!title || !body) return;
      const rm = payload.resultMessages;
      const winCopy = rm?.winner?.trim() || DEFAULT_RESULT_MESSAGES.winner;
      const loseCopy = rm?.loser?.trim() || DEFAULT_RESULT_MESSAGES.loser;
      const tieCopy = rm?.tie?.trim() || DEFAULT_RESULT_MESSAGES.tie;
      if (payload.reason === "no_questions") {
        if (kicker) kicker.textContent = "";
        title.textContent = "لا توجد أسئلة";
        body.textContent = "أضف أسئلة إلى قاعدة البيانات ثم أعد المحاولة.";
        applyResultScreenPresentation("empty", "");
        return;
      }
      let kind: ResultScreenKind = "tie";
      let emojiForFallback = "🤝";
      if (payload.winner && payload.winner.socketId === mySocketId) {
        kind = "win";
        emojiForFallback = "🎉";
        if (kicker) kicker.textContent = "مبروك — أداء يستحق الاحتفال";
        title.textContent = "فزت!";
        body.textContent = winCopy;
      } else if (payload.winner) {
        kind = "lose";
        emojiForFallback = "💔";
        if (kicker) kicker.textContent = "نهاية الجولة";
        title.textContent = "انتهت الجولة";
        body.textContent = `${loseCopy} (الفائز: ${payload.winner.name})`;
      } else {
        kind = "tie";
        emojiForFallback = "🤝";
        if (kicker) kicker.textContent = "لا غالب ولا مغلوب";
        title.textContent = "تعادل أو لا فائز";
        body.textContent = tieCopy;
      }
      if (me) {
        body.textContent += ` — قلوبك المتبقية: ${me.hearts}`;
      }
      applyResultScreenPresentation(kind, emojiForFallback);
    },
  );

  s.on("player_eliminated", (p: { name: string; reason?: string }) => {
    currentMatchPlayers = currentMatchPlayers.map((x) =>
      x.name === p.name ? { ...x, eliminated: true, hearts: 0 } : x,
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
    const ms = Math.max(0, endsAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    clock.textContent = `${sec}s`;
  }, 200);
}

function startStudyTimer(): void {
  clearTimer();
  const clock = app.querySelector<HTMLDivElement>("#study-clock");
  if (!clock) return;
  timerHandle = window.setInterval(() => {
    const ms = Math.max(0, studyEndsAt - Date.now());
    const sec = Math.ceil(ms / 1000);
    clock.textContent = `${sec}s`;
  }, 200);
}

render();
