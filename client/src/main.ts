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
let studyCards: Array<{ id: number; body: string; order: number }> = [];
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
    app.append(
      el(`
        <div class="min-h-screen bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-900 text-white flex flex-col items-center justify-center p-4">
          <div class="max-w-md w-full space-y-6 text-center">
            <h1 class="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-l from-amber-300 to-orange-400">فاهم</h1>
            <p class="text-slate-300 text-lg">تحدٍّ سريع — من يبقى آخر من يفوز؟</p>
            <div class="rounded-2xl bg-white/5 border border-white/10 p-6 shadow-xl backdrop-blur space-y-4">
              <label class="block text-right text-sm text-slate-400">اسمك في اللعبة</label>
              <input id="name-input" maxlength="32" type="text" placeholder="مثال: سارة" class="w-full rounded-xl bg-slate-900/80 border border-white/10 px-4 py-3 text-right text-lg outline-none focus:ring-2 focus:ring-amber-400/60" />
              <fieldset class="text-right space-y-2 border-0 p-0">
                <legend class="text-sm text-slate-400 mb-2">نمط اللعب</legend>
                <label class="flex items-center justify-end gap-2 cursor-pointer text-slate-200">
                  <span>مباشر — أسئلة فورية</span>
                  <input type="radio" name="game-mode" value="direct" checked class="accent-amber-500" />
                </label>
                <label class="flex items-center justify-end gap-2 cursor-pointer text-slate-200">
                  <span>مراجعة ثم أسئلة (بطاقات ثم كتلة أسئلة)</span>
                  <input type="radio" name="game-mode" value="study_then_quiz" class="accent-amber-500" />
                </label>
              </fieldset>
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
    btn.addEventListener("click", () => {
      err.textContent = "";
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      const modeInput = app.querySelector<HTMLInputElement>(
        'input[name="game-mode"]:checked',
      );
      const mode: GameMode =
        modeInput?.value === "study_then_quiz" ? "study_then_quiz" : "direct";
      connectSocket(name, mode);
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
        <div class="min-h-screen bg-gradient-to-b from-slate-950 via-indigo-950 to-slate-900 text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-lg font-bold text-amber-300">مراجعة شاملة</h2>
            <div id="study-clock" class="text-xl font-mono font-bold text-emerald-300 tabular-nums">—</div>
          </div>
          <p id="study-hint" class="text-right text-slate-400 text-sm min-h-[1.25rem]"></p>
          <div id="study-cards" class="flex-1 space-y-3 overflow-y-auto max-h-[70vh]"></div>
        </div>
      `),
    );
    const hint = app.querySelector<HTMLParagraphElement>("#study-hint");
    if (hint) {
      hint.textContent = hasCards
        ? "مراجعة شاملة — اقرأ البطاقات قبل أول سؤال."
        : "جاري تجهيز الجولة…";
    }
    const container = app.querySelector<HTMLDivElement>("#study-cards");
    if (container && hasCards) {
      for (const c of studyCards) {
        const card = document.createElement("div");
        card.className =
          "rounded-2xl bg-white/5 border border-white/10 p-4 text-right shadow-lg";
        card.innerHTML = `<p class="text-slate-100 leading-relaxed whitespace-pre-wrap">${escapeHtml(c.body)}</p>`;
        container.appendChild(card);
      }
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
          <div id="q-card" class="rounded-2xl bg-white/5 border border-white/10 p-5 flex-1 flex flex-col gap-4 shadow-xl">
            <p id="q-text" class="text-right text-xl font-semibold leading-relaxed min-h-[4rem]"></p>
            <div id="opts" class="grid gap-2"></div>
          </div>
          <p id="status" class="text-center text-slate-400 text-sm min-h-[1.25rem]"></p>
        </div>
      `),
    );
    renderHearts(3);
    startQuestionTimer();
    return;
  }

  if (phase === "result") {
    app.append(
      el(`
        <div class="min-h-screen bg-gradient-to-b from-slate-950 to-slate-900 text-white p-6 flex flex-col items-center justify-center text-center gap-6 max-w-md mx-auto">
          <p id="res-emoji" class="text-7xl leading-none min-h-[4.5rem] flex items-center justify-center" aria-hidden="true"></p>
          <h2 id="res-title" class="text-3xl font-extrabold"></h2>
          <p id="res-body" class="text-slate-300 text-lg"></p>
          <button id="again" class="w-full rounded-xl bg-gradient-to-l from-amber-500 to-orange-600 py-3 text-lg font-bold text-slate-950">العب مجدداً</button>
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
      players?: unknown;
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      if (payload.gameMode) currentGameMode = payload.gameMode;
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
      cards: Array<{ id: number; body: string; order: number }>;
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
            ? "مراجعة شاملة لدفعة الأسئلة في المباراة — اقرأ كل البطاقات قبل أول سؤال."
            : "اقرأ البطاقات قبل متابعة الأسئلة.";
        hint.textContent =
          studyCards.length > 0 ? full : "جاري تجهيز الجولة…";
      }
      if (container) {
        container.innerHTML = "";
        for (const c of studyCards) {
          const card = document.createElement("div");
          card.className =
            "rounded-2xl bg-white/5 border border-white/10 p-4 text-right shadow-lg";
          card.innerHTML = `<p class="text-slate-100 leading-relaxed whitespace-pre-wrap">${escapeHtml(c.body)}</p>`;
          container.appendChild(card);
        }
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
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      clearTimer();
      phase = "result";
      render();
      const me = payload.players.find((p) => p.socketId === mySocketId);
      const emojiEl = app.querySelector<HTMLParagraphElement>("#res-emoji");
      const title = app.querySelector<HTMLHeadingElement>("#res-title");
      const body = app.querySelector<HTMLParagraphElement>("#res-body");
      if (!title || !body) return;
      if (payload.reason === "no_questions") {
        if (emojiEl) emojiEl.textContent = "";
        title.textContent = "لا توجد أسئلة";
        body.textContent = "أضف أسئلة إلى قاعدة البيانات ثم أعد المحاولة.";
        return;
      }
      if (payload.winner && payload.winner.socketId === mySocketId) {
        if (emojiEl) emojiEl.textContent = "😍";
        title.textContent = "فزت!";
        body.textContent = "أحسنت — بقيت حتى النهاية.";
      } else if (payload.winner) {
        if (emojiEl) emojiEl.textContent = "😭";
        title.textContent = "انتهت الجولة";
        body.textContent = `الفائز: ${payload.winner.name}`;
      } else {
        if (emojiEl) emojiEl.textContent = "😭";
        title.textContent = "تعادل أو لا فائز";
        body.textContent = "حاول مرة أخرى!";
      }
      if (me) {
        body.textContent += ` — قلوبك المتبقية: ${me.hearts}`;
      }
    },
  );

  s.on("player_eliminated", (p: { name: string; reason?: string }) => {
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
