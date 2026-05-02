import "./style.css";
import { io, type Socket } from "socket.io-client";
import { toDataURL as qrToDataURL } from "qrcode";
import { buildCustomLessonAiPromptText, type LessonAiPromptParams } from "./lessonPromptBuilder";
import { normalizePastedJsonForParse } from "./jsonNormalize";
import { loadCustomLessonDraft, saveCustomLessonDraft } from "./customLessonDraft";
import { openChatGptExternal, openGeminiExternal } from "./openExternalAiApp";

type GameMode = "direct" | "study_then_quiz" | "lesson";
type DifficultyMode = "mix" | "easy" | "medium" | "hard";
type Phase =
  | "name"
  | "custom_lesson"
  | "lesson_menu"
  | "lesson_study"
  | "lesson_quiz"
  | "lesson_done"
  | "lesson_review"
  | "match_lesson_review"
  | "matchmaking"
  | "private_room_lobby"
  | "countdown"
  | "studying"
  | "playing"
  | "result";

type LessonPlaybackStep = {
  sortOrder: number;
  questionId: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  studyBody: string | null;
  effectiveAnswerMs: number;
  effectiveStudyCardMs: number;
};

type LessonPlaybackSection = {
  id: number;
  sortOrder: number;
  titleAr: string | null;
  /** زمن طور المذاكرة الإجمالي للقسم (مللي)، يعبّئه الخادم عند تقسيم effectiveStudyCardMs */
  studyPhaseMs?: number;
  steps: LessonPlaybackStep[];
};

type LessonPlaybackPayload = {
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  defaultAnswerMs: number;
  category: { id: number; nameAr: string; icon: string } | null;
  sections?: LessonPlaybackSection[];
  steps: LessonPlaybackStep[];
};
type NameFlowStep = "mode" | "main_categories" | "sub_categories" | "difficulty";
type JoinKind = "public" | "solo" | "private_create" | "private_join";

const app = document.querySelector<HTMLDivElement>("#app")!;

let socket: Socket | null = null;
let phase: Phase = "name";
let nameFlowStep: NameFlowStep = "mode";
let mySocketId: string | null = null;
let currentQuestionId: number | null = null;
let endsAt = 0;
let timerHandle: number | null = null;
let currentGameMode: GameMode | null = null;
let selectedModeInName: GameMode = "direct";
let selectedDifficultyMode: DifficultyMode = "mix";
let selectedMainCategoryId: number | null = null;
let selectedSubcategoryKey: string | null = null;
let selectedSubcategoryLabel: string | null = null;
let playerNameDraft = "";
let searchFlowToken = 0;
let soloLearningPending = false;
let privateRoomCodeState: string | null = null;
let privateRoomHostSocketId: string | null = null;
let privateRoomInviteUrl: string | null = null;
let privateRoomQuestionMs = 15_000;
let privateRoomStudyPhaseMs = 60_000;
/** درس مباراة Socket: معرّف الدرس المختار من شاشة الاسم */
let selectedLessonMatchId: number | null = null;
/** واجهة بطاقة واحدة (تالي/سابق) لمراجعة الدرس في المباراة */
let lessonMatchStudyNav = false;
let lessonMatchStudyCardIndex = 0;
let lessonMatchSectionMeta = { index: 0, count: 0, title: null as string | null };
let matchLessonReviewItems: Array<{
  questionId: number;
  choiceIndex: number | null;
  correctIndex: number;
  prompt: string;
  options: string[];
  studyBody: string | null;
}> | null = null;
let matchLessonReviewIndex = 0;
let pendingJoinRoomCode = "";
let privateRoomVersionState = 0;
let privateReadyPending = false;
let privateQrDataUrl: string | null = null;
let privateEntryAutoJoinTried = false;
let isPrivateRoomSession = false;
let lastPrivateRoomCode: string | null = null;
let categoriesState: Array<{
  id: number;
  mainKey: string;
  nameAr: string;
  icon: string;
  subcategories: Array<{
    id: number;
    subcategoryKey: string;
    nameAr: string;
    icon: string;
  }>;
}> = [];
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

let lessonBrowseCategories: Array<{
  id: number;
  parentId: number | null;
  nameAr: string;
  icon: string;
  sortOrder: number;
}> = [];
let lessonBrowseLessons: Array<{
  id: number;
  title: string;
  slug: string | null;
  description: string | null;
  sortOrder: number;
  itemCount: number;
  category: { id: number; nameAr: string; icon: string } | null;
}> = [];
/** تصفّح الدروس: تصنيفات ← قائمة دروس ← مركز درس */
type LessonBrowseStep = "categories" | "lessons" | "lesson_hub";
let lessonBrowseStep: LessonBrowseStep = "categories";
/** في خطوة `lessons`: `null` = كل الدروس، `LESSON_BROWSE_UNCATEGORIZED` = بلا تصنيف، وإلا `id` التصنيف */
let lessonBrowseSelectedCategoryId: number | null = null;
const LESSON_BROWSE_UNCATEGORIZED = -1;
let lessonBrowseMsg = "";
let lessonPlayback: LessonPlaybackPayload | null = null;
/** درس مخصص: جسم JSON المُتحقق منه (لإنشاء جلسة سيرفر) */
let customLessonValidatedBody: Record<string, unknown> | null = null;
let customLessonPreviewLesson: LessonPlaybackPayload | null = null;
let customLessonSessionToken: string | null = null;
let customLessonLearningIntent = "";
let customLessonJsonText = "";
let customLessonErr = "";
let customLessonMsg = "";
let customLessonClientId = "";
/** يظهر لصق JSON وأزرار الأدوات الخارجية بعد نسخ البرومبت (أو استعادة مسودة) */
let customLessonShowJsonPanel = false;
const defaultCustomPromptParams = (): LessonAiPromptParams => ({
  nSec: 3,
  qSame: 5,
  ansSec: 15,
  studySec: 60,
  topic: "",
  audience: "",
  minSentences: 1,
  maxSentences: 6,
});
let customLessonPromptParams: LessonAiPromptParams = defaultCustomPromptParams();
let lessonStudyQueue: Array<{ body: string; ms: number }> = [];
let lessonStudyIdx = 0;
/** نهاية زمن البطاقة الحالية (للانتقال التلقائي بين البطاقات) */
let lessonStudySegmentEndAt = 0;
/** نهاية زمن مذاكرة القسم كاملاً — العداد الظاهر لا يُعاد من الصفر عند «التالي» */
let lessonStudySectionDeadlineAt = 0;
let lessonQuizIdx = 0;
let lessonQuizIdxInSection = 0;
let lessonSectionIdx = 0;
let lessonQuizCorrect = 0;
let lessonQuizLocked = false;
/** يمنع معالجة انتهاء الوقت بعد إجابة اللاعب أو معالجة المؤقت مرتين */
let lessonQuizRoundResolved = false;
/** اختيارات مسار REST: questionId → فهرس الخيار أو null إن انتهى الوقت دون إجابة */
let lessonRestChoiceByQuestionId = new Map<number, number | null>();
let lessonReviewIndex = 0;

const DEFAULT_RESULT_MESSAGES = {
  winnerTitle: "فزت!",
  loserTitle: "لقد خسرت يا فاشل",
  tieTitle: "تعادل كامل",
  winner: "أحسنت — بقيت حتى النهاية.",
  loser: "انتهت الجولة لصالح لاعب آخر.",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
} as const;
const PLAYER_NAME_STORAGE_KEY = "fahem.playerName";
const PLAYER_SESSION_STORAGE_KEY = "fahem.playerSessionId";
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

function getOrCreatePlayerSessionId(): string {
  try {
    const existing = (window.localStorage.getItem(PLAYER_SESSION_STORAGE_KEY) ?? "").trim();
    if (existing) return existing;
    const next = `ps_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    window.localStorage.setItem(PLAYER_SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    return `ps_fallback_${Date.now().toString(36)}`;
  }
}

function difficultyModeLabelAr(mode: DifficultyMode): string {
  if (mode === "easy") return "سهل";
  if (mode === "medium") return "متوسط";
  if (mode === "hard") return "متقدم";
  return "مزيج";
}

async function fetchCategoriesState(): Promise<void> {
  const res = await fetch("/api/categories", { cache: "no-store" });
  const data = (await res.json()) as {
    ok?: boolean;
    categories?: Array<{
      id: number;
      mainKey: string;
      nameAr: string;
      icon: string;
      subcategories?: Array<{
        id: number;
        subcategoryKey: string;
        nameAr: string;
        icon: string;
      }>;
    }>;
  };
  if (!res.ok || !data.ok) throw new Error("categories_failed");
  categoriesState = (data.categories ?? []).map((c) => ({
    id: c.id,
    mainKey: c.mainKey,
    nameAr: c.nameAr,
    icon: c.icon || "📚",
    subcategories: (c.subcategories ?? []).map((s) => ({
      id: s.id,
      subcategoryKey: s.subcategoryKey,
      nameAr: s.nameAr,
      icon: s.icon || "📘",
    })),
  }));
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

function getRoomCodeFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const room = url.searchParams.get("room");
    if (!room) return null;
    const code = room.trim().toUpperCase();
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

async function ensurePrivateQrDataUrl(inviteUrl: string): Promise<void> {
  try {
    privateQrDataUrl = await qrToDataURL(inviteUrl, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: "M",
    });
  } catch {
    privateQrDataUrl = null;
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

function disconnectSearchSocket(): void {
  searchFlowToken += 1;
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  mySocketId = null;
  currentGameMode = null;
  lobbyNotice = "";
  lobbyPlayersList = [];
  soloLearningPending = false;
  privateRoomCodeState = null;
  privateRoomHostSocketId = null;
  privateRoomInviteUrl = null;
  privateRoomVersionState = 0;
  privateReadyPending = false;
  privateQrDataUrl = null;
  isPrivateRoomSession = false;
}

function returnToDifficultyFromSearch(): void {
  disconnectSearchSocket();
  phase = "name";
  nameFlowStep = "difficulty";
  render();
}

function returnToHomeFromSearch(): void {
  disconnectSearchSocket();
  phase = "name";
  nameFlowStep = "mode";
  selectedDifficultyMode = "mix";
  selectedMainCategoryId = null;
  selectedSubcategoryKey = null;
  selectedSubcategoryLabel = null;
  selectedLessonMatchId = null;
  lessonBrowseStep = "categories";
  lessonBrowseSelectedCategoryId = null;
  lessonMatchStudyNav = false;
  lessonMatchStudyCardIndex = 0;
  lastPrivateRoomCode = null;
  isPrivateRoomSession = false;
  pendingJoinRoomCode = "";
  privateEntryAutoJoinTried = false;
  render();
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
    const isPrivateEntryFlow = Boolean(pendingJoinRoomCode);
    const renderModePicker = !isPrivateEntryFlow && nameFlowStep === "mode";
    const renderDifficultyPicker = !isPrivateEntryFlow && nameFlowStep === "difficulty";
    const selectedMain = categoriesState.find((c) => c.id === selectedMainCategoryId) ?? null;
    const subItems = selectedMain?.subcategories ?? [];
    const mainCards = categoriesState
      .map(
        (c) => `
        <button type="button" class="mode-option-btn" data-main-id="${c.id}">
          <span class="mode-option-icon">${escapeHtml(c.icon || "📚")}</span>
          <span class="mode-option-title">${escapeHtml(c.nameAr)}</span>
        </button>`,
      )
      .join("");
    const subCards = subItems
      .map(
        (s) => `
        <button type="button" class="mode-option-btn" data-sub-key="${escapeHtml(s.subcategoryKey)}" data-sub-name="${escapeHtml(s.nameAr)}">
          <span class="mode-option-icon">${escapeHtml(s.icon || "📘")}</span>
          <span class="mode-option-title">${escapeHtml(s.nameAr)}</span>
        </button>`,
      )
      .join("");
    const difficultyCards = [
      { key: "mix", label: "مزيج", desc: "أسئلة من جميع مستويات الصعوبة" },
      { key: "easy", label: "سهل", desc: "أسئلة مصنفة بمستوى سهل فقط" },
      { key: "medium", label: "متوسط", desc: "أسئلة مصنفة بمستوى متوسط فقط" },
      { key: "hard", label: "متقدم", desc: "أسئلة مصنفة بمستوى متقدم فقط" },
    ]
      .map(
        (d) => `
        <button type="button" class="mode-option-btn ${
          selectedDifficultyMode === d.key ? "mode-option-btn--selected" : ""
        }" data-difficulty-mode="${d.key}" aria-pressed="${selectedDifficultyMode === d.key ? "true" : "false"}">
          <span class="mode-option-title">${escapeHtml(d.label)}</span>
          <span class="mode-option-desc">${escapeHtml(d.desc)}</span>
        </button>`,
      )
      .join("");
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-4">
          <div class="max-w-lg w-full space-y-6 text-center">
            <h1 class="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-l from-amber-300 to-orange-400">فاهم</h1>
            <p class="text-slate-300 text-lg">تحدٍّ سريع — من يبقى آخر يفوز؟</p>
            <div class="app-card p-6 space-y-5">
              <label class="block text-right text-sm text-slate-400">اسمك في اللعبة</label>
              <input id="name-input" maxlength="32" type="text" placeholder="مثال: سارة" class="app-input w-full px-4 py-3 text-right text-lg" />
              <p class="text-sm text-slate-400 text-right m-0">${
                isPrivateEntryFlow
                  ? `الانضمام للغرفة الخاصة (${pendingJoinRoomCode})`
                  : renderModePicker
                  ? "اختر نمط اللعب"
                  : nameFlowStep === "main_categories"
                      ? "اختر التصنيف الرئيسي"
                      : nameFlowStep === "sub_categories"
                        ? "اختر التصنيف الفرعي"
                        : "اختر مستوى الصعوبة"
              }</p>
              <div class="mode-picker-grid" role="group" aria-label="اختيارات">
                ${
                  isPrivateEntryFlow
                    ? `
                <div class="app-card p-3 text-right">
                  <p class="text-sm text-slate-300 m-0">سيتم الانضمام مباشرة إلى الغرفة الخاصة عبر الرابط/الباركود.</p>
                </div>
                `
                    : renderModePicker
                    ? `
                <button type="button" class="mode-option-btn ${
                  selectedModeInName === "direct" ? "mode-option-btn--selected" : ""
                }" data-mode="direct" aria-pressed="${selectedModeInName === "direct" ? "true" : "false"}">
                  <span class="mode-option-icon" aria-hidden="true">⚡</span>
                  <span class="mode-option-title">نمط مباشر</span>
                  <span class="mode-option-desc">أسئلة فورية متتالية بدون مراجعة مسبقة</span>
                </button>
                <button type="button" class="mode-option-btn ${
                  selectedModeInName === "study_then_quiz" ? "mode-option-btn--selected" : ""
                }" data-mode="study_then_quiz" aria-pressed="${selectedModeInName === "study_then_quiz" ? "true" : "false"}">
                  <span class="mode-option-icon" aria-hidden="true">📚</span>
                  <span class="mode-option-title">مذاكرة ثم أسئلة</span>
                  <span class="mode-option-desc">بطاقة مراجعة لكل سؤال ثم كتلة أسئلة في الجولة</span>
                </button>
                <button type="button" class="mode-option-btn" data-flow="lessons">
                  <span class="mode-option-icon" aria-hidden="true">📖</span>
                  <span class="mode-option-title">دروس منظمة</span>
                  <span class="mode-option-desc">اختر درساً ثم تعلّم فردياً أو تحدّ عاماً أو غرفة خاصة</span>
                </button>
                <button type="button" class="mode-option-btn" data-flow="custom_lesson">
                  <span class="mode-option-icon" aria-hidden="true">✨</span>
                  <span class="mode-option-title">درس مخصص</span>
                  <span class="mode-option-desc">برومبت خارجي + لصق JSON ثم تعلّم فردياً أو غرفة خاصة</span>
                </button>
                `
                    : nameFlowStep === "main_categories"
                      ? mainCards
                      : nameFlowStep === "sub_categories"
                        ? subCards
                        : difficultyCards
                }
              </div>
              <div class="flex gap-2">
                <button id="back-mode-btn" class="ui-btn ui-btn--ghost w-full py-3 text-lg ${
                  renderModePicker || isPrivateEntryFlow ? "hidden" : ""
                }">رجوع</button>
                <button id="join-btn" class="ui-btn ui-btn--cta w-full py-3 text-lg ${
                  isPrivateEntryFlow || renderModePicker || renderDifficultyPicker ? "" : "hidden"
                }">${
                  isPrivateEntryFlow
                    ? "انضمام للغرفة"
                    : renderModePicker || renderDifficultyPicker
                      ? "ابدأ التحدي"
                      : nameFlowStep === "main_categories"
                        ? "التالي"
                        : "التالي"
                }</button>
              </div>
              <button id="solo-learning-btn" class="ui-btn ui-btn--primary w-full py-3 text-lg ${
                renderDifficultyPicker && !isPrivateEntryFlow ? "" : "hidden"
              }">التعلم الفردي</button>
              <div class="${
                renderDifficultyPicker && !isPrivateEntryFlow ? "space-y-2" : "hidden"
              }">
                <button id="create-private-room-btn" class="ui-btn ui-btn--ghost w-full py-3 text-lg">إنشاء غرفة خاصة</button>
                <div class="flex gap-2">
                  <input id="private-room-code-input" type="text" placeholder="كود الغرفة" class="app-input w-full px-3 py-2 text-right" />
                  <button id="join-private-room-btn" class="ui-btn ui-btn--cta px-4 py-2">انضمام</button>
                </div>
              </div>
              <p id="join-err" class="text-red-400 text-sm min-h-[1.25rem]"></p>
            </div>
          </div>
        </div>
      `),
    );
    const input = app.querySelector<HTMLInputElement>("#name-input")!;
    const storedName = getStoredPlayerName();
    if (playerNameDraft || storedName) {
      input.value = playerNameDraft || storedName;
    }
    input.addEventListener("input", () => {
      playerNameDraft = input.value;
    });
    const btn = app.querySelector<HTMLButtonElement>("#join-btn")!;
    const soloBtn = app.querySelector<HTMLButtonElement>("#solo-learning-btn");
    const createPrivateBtn = app.querySelector<HTMLButtonElement>("#create-private-room-btn");
    const joinPrivateBtn = app.querySelector<HTMLButtonElement>("#join-private-room-btn");
    const privateCodeInput = app.querySelector<HTMLInputElement>("#private-room-code-input");
    const backBtn = app.querySelector<HTMLButtonElement>("#back-mode-btn");
    const err = app.querySelector<HTMLParagraphElement>("#join-err")!;
    if (privateCodeInput) {
      privateCodeInput.value = pendingJoinRoomCode;
      privateCodeInput.addEventListener("input", () => {
        pendingJoinRoomCode = privateCodeInput.value.trim().toUpperCase();
      });
    }
    const modeBtns = app.querySelectorAll<HTMLButtonElement>(".mode-option-btn");
    const goToStudyCategories = async () => {
      if (btn.disabled) return;
      err.textContent = "";
      playerNameDraft = input.value;
      selectedModeInName = "study_then_quiz";
      selectedMainCategoryId = null;
      selectedSubcategoryKey = null;
      selectedSubcategoryLabel = null;
      btn.disabled = true;
      btn.classList.add("btn-pending");
      btn.textContent = "جاري تحميل التصنيفات...";
      try {
        await fetchCategoriesState();
        nameFlowStep = "main_categories";
        render();
      } catch {
        btn.disabled = false;
        btn.classList.remove("btn-pending");
        btn.textContent = "ابدأ التحدي";
        err.textContent = "تعذر تحميل التصنيفات.";
      }
    };
    if (renderModePicker) {
      modeBtns.forEach((b) => {
        b.addEventListener("click", () => {
          playerNameDraft = input.value;
          if (b.dataset.flow === "lessons") {
            err.textContent = "";
            lessonBrowseMsg = "جاري تحميل الدروس…";
            lessonBrowseStep = "categories";
            lessonBrowseSelectedCategoryId = null;
            selectedLessonMatchId = null;
            phase = "lesson_menu";
            render();
            void fetchLessonBrowse()
              .then(() => {
                lessonBrowseMsg = "";
                render();
              })
              .catch(() => {
                lessonBrowseMsg = "تعذر تحميل الدروس.";
                render();
              });
            return;
          }
          if (b.dataset.flow === "custom_lesson") {
            err.textContent = "";
            const d = loadCustomLessonDraft();
            if (d) {
              customLessonClientId = d.clientLessonId;
              customLessonLearningIntent = d.learningIntent;
              customLessonJsonText = d.jsonText;
              customLessonPromptParams = {
                ...defaultCustomPromptParams(),
                ...d.promptParams,
                topic: "",
              };
              customLessonSessionToken = d.lastSessionToken ?? null;
              customLessonShowJsonPanel =
                d.showJsonPanel === true ||
                (String(d.jsonText ?? "").trim().length > 0 && d.showJsonPanel !== false);
            } else {
              customLessonClientId = "";
              customLessonLearningIntent = "";
              customLessonJsonText = "";
              customLessonPromptParams = defaultCustomPromptParams();
              customLessonSessionToken = null;
              customLessonShowJsonPanel = false;
            }
            customLessonValidatedBody = null;
            customLessonPreviewLesson = null;
            customLessonErr = "";
            customLessonMsg = "";
            phase = "custom_lesson";
            render();
            return;
          }
          selectedModeInName =
            b.dataset.mode === "study_then_quiz" ? "study_then_quiz" : "direct";
          modeBtns.forEach((x) => {
            const on = x === b;
            x.classList.toggle("mode-option-btn--selected", on);
            x.setAttribute("aria-pressed", on ? "true" : "false");
          });
          if (selectedModeInName === "study_then_quiz") {
            void goToStudyCategories();
          }
        });
      });
    } else if (nameFlowStep === "main_categories") {
      modeBtns.forEach((b) => {
        b.addEventListener("click", () => {
          playerNameDraft = input.value;
          const id = Number(b.dataset.mainId);
          if (!Number.isInteger(id)) return;
          selectedMainCategoryId = id;
          selectedSubcategoryKey = null;
          selectedSubcategoryLabel = null;
          nameFlowStep = "sub_categories";
          render();
        });
      });
    } else if (nameFlowStep === "sub_categories") {
      modeBtns.forEach((b) => {
        b.addEventListener("click", () => {
          playerNameDraft = input.value;
          const key = b.dataset.subKey?.trim();
          const label = b.dataset.subName?.trim();
          if (!key) return;
          selectedSubcategoryKey = key;
          selectedSubcategoryLabel = label || key;
          nameFlowStep = "difficulty";
          render();
        });
      });
    } else {
      modeBtns.forEach((b) => {
        b.addEventListener("click", () => {
          const value = (b.dataset.difficultyMode ?? "mix").trim() as DifficultyMode;
          selectedDifficultyMode =
            value === "easy" || value === "medium" || value === "hard" ? value : "mix";
          modeBtns.forEach((x) => {
            const on = x === b;
            x.classList.toggle("mode-option-btn--selected", on);
            x.setAttribute("aria-pressed", on ? "true" : "false");
          });
        });
      });
    }
    backBtn?.addEventListener("click", () => {
      if (isPrivateEntryFlow) return;
      if (nameFlowStep === "difficulty") {
        nameFlowStep = selectedModeInName === "direct" ? "mode" : "sub_categories";
      } else if (nameFlowStep === "sub_categories") {
        nameFlowStep = "main_categories";
      } else {
        nameFlowStep = "mode";
      }
      render();
    });
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      err.textContent = "";
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      btn.disabled = true;
      btn.classList.add("btn-pending");
      storePlayerName(name);
      if (isPrivateEntryFlow) {
        playerNameDraft = name;
        phase = "matchmaking";
        soloLearningPending = false;
        privateRoomCodeState = pendingJoinRoomCode;
        privateRoomInviteUrl = null;
        privateEntryAutoJoinTried = true;
        isPrivateRoomSession = true;
        lobbyNotice = "جاري الانضمام للغرفة الخاصة...";
        render();
        connectSocket(name, "direct", null, "mix", "private_join", pendingJoinRoomCode);
        return;
      }
      if (nameFlowStep === "mode") {
        if (selectedModeInName === "direct") {
          nameFlowStep = "difficulty";
          btn.disabled = false;
          btn.classList.remove("btn-pending");
          render();
          return;
        }
        try {
          btn.textContent = "جاري تحميل التصنيفات...";
          await fetchCategoriesState();
          nameFlowStep = "main_categories";
          btn.disabled = false;
          btn.classList.remove("btn-pending");
          render();
        } catch {
          btn.disabled = false;
          btn.classList.remove("btn-pending");
          btn.textContent = "ابدأ التحدي";
          err.textContent = "تعذر تحميل التصنيفات.";
        }
        return;
      }
      if (nameFlowStep === "main_categories") {
        if (!selectedMainCategoryId) {
          btn.disabled = false;
          btn.classList.remove("btn-pending");
          err.textContent = "اختر تصنيفًا رئيسيًا.";
          return;
        }
        nameFlowStep = "sub_categories";
        btn.disabled = false;
        btn.classList.remove("btn-pending");
        render();
        return;
      }
      if (nameFlowStep === "sub_categories") {
        if (!selectedSubcategoryKey) {
          btn.disabled = false;
          btn.classList.remove("btn-pending");
          err.textContent = "اختر تصنيفًا فرعيًا.";
          return;
        }
        nameFlowStep = "difficulty";
        btn.disabled = false;
        btn.classList.remove("btn-pending");
        render();
        return;
      }
      btn.textContent = "جاري الدخول...";
      phase = "matchmaking";
      if (selectedModeInName === "direct") {
        lobbyNotice = `جاري الاتصال بالخادم... (${difficultyModeLabelAr(selectedDifficultyMode)})`;
        render();
        connectSocket(name, "direct", null, selectedDifficultyMode);
        return;
      }
      lobbyNotice = `جاري الاتصال بالخادم... (${selectedSubcategoryLabel ?? selectedSubcategoryKey} - ${difficultyModeLabelAr(selectedDifficultyMode)})`;
      render();
      connectSocket(name, "study_then_quiz", selectedSubcategoryKey, selectedDifficultyMode);
    });
    soloBtn?.addEventListener("click", () => {
      if (soloBtn.disabled) return;
      err.textContent = "";
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      if (selectedModeInName === "study_then_quiz" && !selectedSubcategoryKey) {
        err.textContent = "اختر تصنيفًا فرعيًا أولاً.";
        return;
      }
      storePlayerName(name);
      playerNameDraft = name;
      soloBtn.disabled = true;
      soloBtn.classList.add("btn-pending");
      soloBtn.textContent = "جاري بدء التعلم الفردي...";
      phase = "matchmaking";
      soloLearningPending = true;
      currentGameMode = selectedModeInName;
      lobbyNotice =
        selectedModeInName === "direct"
          ? `جاري بدء التعلم الفردي... (${difficultyModeLabelAr(selectedDifficultyMode)})`
          : `جاري بدء التعلم الفردي... (${selectedSubcategoryLabel ?? selectedSubcategoryKey} - ${difficultyModeLabelAr(selectedDifficultyMode)})`;
      render();
      connectSoloSocket(
        name,
        selectedModeInName,
        selectedModeInName === "study_then_quiz" ? selectedSubcategoryKey : null,
        selectedDifficultyMode,
      );
    });
    createPrivateBtn?.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      storePlayerName(name);
      phase = "private_room_lobby";
      soloLearningPending = false;
      privateRoomCodeState = null;
      privateRoomInviteUrl = null;
      privateQrDataUrl = null;
      isPrivateRoomSession = true;
      lobbyNotice = "جاري إنشاء الغرفة الخاصة...";
      currentGameMode = selectedModeInName;
      render();
      connectSocket(
        name,
        selectedModeInName,
        selectedModeInName === "study_then_quiz" ? selectedSubcategoryKey : null,
        selectedDifficultyMode,
        "private_create",
      );
    });
    joinPrivateBtn?.addEventListener("click", () => {
      const name = input.value.trim();
      const roomCode = (privateCodeInput?.value || pendingJoinRoomCode).trim().toUpperCase();
      if (!name) {
        err.textContent = "أدخل اسماً من حرف واحد على الأقل.";
        return;
      }
      if (!roomCode) {
        err.textContent = "أدخل كود الغرفة.";
        return;
      }
      pendingJoinRoomCode = roomCode;
      storePlayerName(name);
      phase = "matchmaking";
      soloLearningPending = false;
      privateRoomCodeState = roomCode;
      privateRoomInviteUrl = null;
      privateQrDataUrl = null;
      isPrivateRoomSession = true;
      lastPrivateRoomCode = roomCode;
      lobbyNotice = "جاري الانضمام للغرفة الخاصة...";
      render();
      connectSocket(name, selectedModeInName, null, selectedDifficultyMode, "private_join", roomCode);
    });
    if (
      isPrivateEntryFlow &&
      storedName &&
      !privateEntryAutoJoinTried
    ) {
      input.value = storedName;
      playerNameDraft = storedName;
      privateEntryAutoJoinTried = true;
      phase = "matchmaking";
      soloLearningPending = false;
      privateRoomCodeState = pendingJoinRoomCode;
      privateRoomInviteUrl = null;
      isPrivateRoomSession = true;
      lobbyNotice = "جاري الانضمام التلقائي للغرفة الخاصة...";
      render();
      connectSocket(storedName, "direct", null, "mix", "private_join", pendingJoinRoomCode);
    }
    return;
  }

  if (phase === "custom_lesson") {
    const p = customLessonPromptParams;
    const showJsonPanel = customLessonShowJsonPanel;
    const hasValidatedPreview = customLessonPreviewLesson != null;
    const persistDraft = (): void => {
      if (!customLessonClientId) {
        try {
          customLessonClientId = crypto.randomUUID();
        } catch {
          customLessonClientId = `cl_${Date.now()}`;
        }
      }
      saveCustomLessonDraft({
        clientLessonId: customLessonClientId,
        learningIntent: customLessonLearningIntent,
        jsonText: customLessonJsonText,
        promptParams: { ...customLessonPromptParams },
        lastSessionToken: customLessonSessionToken,
        showJsonPanel: customLessonShowJsonPanel,
      });
    };
    const audienceOptions: Array<{ v: string; t: string }> = [
      { v: "", t: "— بدون تحديد —" },
      { v: "أطفال", t: "أطفال" },
      { v: "مبتدئ", t: "مبتدئ" },
      { v: "ثانوي", t: "ثانوي" },
      { v: "جامعي", t: "جامعي" },
      { v: "متخصصون", t: "متخصصون" },
    ];
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3 text-right">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="cl-back" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">الرئيسية</button>
            <h1 class="text-xl font-extrabold text-amber-300">درس مخصص</h1>
          </div>
          <p class="text-slate-400 text-sm m-0">اكتب ما تريد تعلّمه، انسخ البرومبت إلى ChatGPT أو Gemini، ثم الصق JSON هنا. لا يُحفظ الدرس على الحساب.</p>
          <label class="text-slate-300 text-sm">ماذا تريد أن تتعلّم؟</label>
          <textarea id="cl-intent" rows="4" class="app-input w-full px-3 py-2 text-sm" placeholder="مادة، موضوع، أو ملخّص لما تريد أن يغطيه الدرس...">${escapeHtml(customLessonLearningIntent)}</textarea>
          <details class="app-card p-3 space-y-2">
            <summary class="cursor-pointer text-amber-200 text-sm font-bold">إعدادات البرومبت (اختياري)</summary>
            <div class="grid grid-cols-2 gap-2 pt-2">
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">عدد الأقسام</span>
                <input id="cl-nsec" type="number" min="1" max="20" class="app-input px-2 py-1 text-sm w-full" value="${p.nSec}" title="عدد أقسام الدرس (1–20)" aria-label="عدد أقسام الدرس" placeholder="1–20" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">أسئلة لكل قسم</span>
                <input id="cl-qsame" type="number" min="1" max="50" class="app-input px-2 py-1 text-sm w-full" value="${p.qSame}" title="عدد أسئلة الاختيار من متعدد في كل قسم" aria-label="عدد الأسئلة لكل قسم" placeholder="1–50" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">زمن الإجابة (ثانية)</span>
                <input id="cl-anssec" type="number" min="3" max="120" step="0.5" class="app-input px-2 py-1 text-sm w-full" value="${p.ansSec}" title="الوقت المتاح لكل سؤال اختيار من متعدد" aria-label="زمن الإجابة بالثواني" placeholder="3–120" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">زمن المذاكرة للقسم (ثانية)</span>
                <input id="cl-studysec" type="number" min="2" max="300" step="0.5" class="app-input px-2 py-1 text-sm w-full" value="${p.studySec}" title="إجمالي زمن بطاقات المذاكرة لكل قسم" aria-label="زمن المذاكرة للقسم بالثواني" placeholder="2–300" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">أدنى جمل لنص المذاكرة</span>
                <input id="cl-minsent" type="number" min="1" max="20" class="app-input px-2 py-1 text-sm w-full" value="${p.minSentences}" title="الحد الأدنى لعدد الجمل في studyBody" aria-label="أدنى عدد جمل لنص بطاقة المذاكرة" placeholder="1–20" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">أقصى جمل لنص المذاكرة</span>
                <input id="cl-maxsent" type="number" min="1" max="20" class="app-input px-2 py-1 text-sm w-full" value="${p.maxSentences}" title="الحد الأقصى لعدد الجمل في studyBody" aria-label="أقصى عدد جمل لنص بطاقة المذاكرة" placeholder="1–20" />
              </div>
            </div>
            <label class="text-xs text-slate-400">مستوى الجمهور</label>
            <select id="cl-audience" class="app-input w-full px-2 py-1 text-sm" title="من يخاطبهم الدرس" aria-label="مستوى الجمهور">
              ${audienceOptions.map((o) => `<option value="${escapeHtml(o.v)}" ${p.audience === o.v ? "selected" : ""}>${escapeHtml(o.t)}</option>`).join("")}
            </select>
          </details>
          <button type="button" id="cl-copy" class="ui-btn ui-btn--primary w-full py-2">نسخ البرومبت</button>
          ${
            showJsonPanel
              ? `<div class="flex flex-row flex-nowrap gap-2 w-full">
            <button type="button" id="cl-open-gpt" class="ui-btn ui-btn--ghost flex-1 min-w-0 py-2 text-sm">فتح ChatGPT</button>
            <button type="button" id="cl-open-gem" class="ui-btn ui-btn--ghost flex-1 min-w-0 py-2 text-sm">فتح Gemini</button>
          </div>
          <label class="text-slate-300 text-sm">JSON الدرس (من النموذج)</label>
          <textarea id="cl-json" rows="8" class="app-input w-full px-3 py-2 text-xs font-mono" placeholder='الصق هنا كائن JSON كامل: {"lesson":{...},"sections":[...]}'>${escapeHtml(customLessonJsonText)}</textarea>
          <button type="button" id="cl-preview" class="ui-btn ui-btn--cta w-full py-2">إضافة الدرس</button>`
              : `<p class="text-slate-500 text-xs m-0">اضغط «نسخ البرومبت» لإظهار لصق JSON وإضافة الدرس.</p>`
          }
          <p id="cl-msg" class="text-emerald-300 text-sm min-h-[1.25rem] m-0">${escapeHtml(customLessonMsg)}</p>
          <p id="cl-err" class="text-red-400 text-sm min-h-[1.25rem] m-0">${escapeHtml(customLessonErr)}</p>
          ${
            hasValidatedPreview
              ? `<div class="flex flex-col gap-2">
            <button type="button" id="cl-solo" class="ui-btn ui-btn--primary w-full py-2">ابدأ التعلم الفردي</button>
            <button type="button" id="cl-private" class="ui-btn ui-btn--ghost w-full py-2">إنشاء غرفة خاصة</button>
          </div>`
              : ""
          }
        </div>
      `),
    );
    const readParamsFromDom = (): void => {
      const num = (id: string, def: number, min: number, max: number): number => {
        const el = app.querySelector<HTMLInputElement>(id);
        const v = el ? parseFloat(el.value) : def;
        if (!Number.isFinite(v)) return def;
        return Math.min(max, Math.max(min, v));
      };
      const n = num("#cl-nsec", 3, 1, 20);
      const q = num("#cl-qsame", 5, 1, 50);
      const mi = Math.min(20, Math.max(1, Math.trunc(num("#cl-minsent", 1, 1, 20))));
      const ma = Math.min(20, Math.max(1, Math.trunc(num("#cl-maxsent", 6, 1, 20))));
      customLessonPromptParams = {
        nSec: n,
        qSame: q,
        ansSec: num("#cl-anssec", 15, 3, 120),
        studySec: num("#cl-studysec", 60, 2, 300),
        topic: "",
        audience: app.querySelector<HTMLSelectElement>("#cl-audience")?.value.trim() ?? "",
        minSentences: Math.min(mi, ma),
        maxSentences: Math.max(mi, ma),
      };
      customLessonLearningIntent = app.querySelector<HTMLTextAreaElement>("#cl-intent")?.value ?? "";
      const jsonTa = app.querySelector<HTMLTextAreaElement>("#cl-json");
      if (jsonTa) customLessonJsonText = jsonTa.value ?? "";
    };
    app.querySelector("#cl-back")?.addEventListener("click", () => {
      readParamsFromDom();
      persistDraft();
      phase = "name";
      nameFlowStep = "mode";
      render();
    });
    app.querySelector("#cl-copy")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      const text = buildCustomLessonAiPromptText({
        ...customLessonPromptParams,
        learningIntent: customLessonLearningIntent,
      });
      try {
        await navigator.clipboard.writeText(text);
        customLessonMsg = "تم نسخ البرومبت.";
        customLessonShowJsonPanel = true;
      } catch {
        customLessonErr = "تعذر النسخ — انسخ يدوياً.";
      }
      persistDraft();
      render();
    });
    app.querySelector("#cl-open-gpt")?.addEventListener("click", () => {
      openChatGptExternal();
    });
    app.querySelector("#cl-open-gem")?.addEventListener("click", () => {
      openGeminiExternal();
    });
    app.querySelector("#cl-preview")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      let body: Record<string, unknown>;
      try {
        const raw = normalizePastedJsonForParse(customLessonJsonText);
        if (!raw) {
          customLessonErr = "الصق JSON الدرس أولاً.";
          persistDraft();
          render();
          return;
        }
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        const detail =
          e instanceof SyntaxError && typeof e.message === "string" && e.message.trim()
            ? e.message.trim()
            : "صياغة غير صالحة";
        customLessonErr = `JSON غير صالح (${detail}).`;
        persistDraft();
        render();
        return;
      }
      customLessonValidatedBody = null;
      customLessonPreviewLesson = null;
      customLessonSessionToken = null;
      try {
        const res = await fetch("/api/custom-lessons/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          lesson?: LessonPlaybackPayload;
          issues?: Array<{ path: string; message: string }>;
          error?: string;
        };
        if (!res.ok || !data.ok || !data.lesson) {
          const iss = data.issues?.map((i) => `${i.path}: ${i.message}`).join("؛ ") || data.error || "رفض الخادم";
          customLessonErr = iss;
          persistDraft();
          render();
          return;
        }
        customLessonValidatedBody = body;
        customLessonPreviewLesson = data.lesson;
        customLessonMsg = `تم التحقق — ${data.lesson.steps.length} خطوة في الدرس.`;
      } catch {
        customLessonErr = "تعذر الاتصال بالخادم.";
      }
      persistDraft();
      render();
    });
    app.querySelector("#cl-solo")?.addEventListener("click", () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      if (!customLessonPreviewLesson) {
        customLessonErr = "استخدم «إضافة الدرس» أولاً.";
        persistDraft();
        render();
        return;
      }
      persistDraft();
      clearTimer();
      beginLessonPlayback(customLessonPreviewLesson);
      render();
    });
    app.querySelector("#cl-private")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      if (!customLessonValidatedBody) {
        customLessonErr = "استخدم «إضافة الدرس» أولاً.";
        persistDraft();
        render();
        return;
      }
      const name = getStoredPlayerName() || playerNameDraft.trim();
      if (!name) {
        customLessonErr = "عرّف اسماً من الشاشة الرئيسية أولاً (الرئيسية).";
        persistDraft();
        render();
        return;
      }
      try {
        const res = await fetch("/api/custom-lessons/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(customLessonValidatedBody),
        });
        const data = (await res.json()) as { ok?: boolean; token?: string; error?: string };
        if (!res.ok || !data.ok || !data.token) {
          customLessonErr = data.error || "تعذر إنشاء جلسة الدرس.";
          persistDraft();
          render();
          return;
        }
        customLessonSessionToken = data.token;
        persistDraft();
        storePlayerName(name);
        playerNameDraft = name;
        phase = "matchmaking";
        soloLearningPending = false;
        currentGameMode = "lesson";
        lobbyNotice = "جاري إنشاء الغرفة الخاصة للدرس المخصص…";
        render();
        connectSocket(name, "lesson", null, "mix", "private_create", undefined, null, data.token);
      } catch {
        customLessonErr = "تعذر الاتصال بالخادم.";
        persistDraft();
        render();
      }
    });
    return;
  }

  if (phase === "lesson_menu") {
    if (lessonBrowseStep === "lesson_hub" && selectedLessonMatchId == null) {
      lessonBrowseStep = "categories";
      lessonBrowseMsg = "";
    }
    const filtered = lessonBrowseFilteredLessons();
    const sortedCats = lessonBrowseSortedCategories();
    const hubLesson =
      selectedLessonMatchId != null
        ? lessonBrowseLessons.find((x) => x.id === selectedLessonMatchId)
        : undefined;

    const categoriesBlock = (() => {
      const uncatTile = lessonBrowseHasUncategorized()
        ? `<button type="button" class="mode-option-btn" data-lesson-uncat="1">
            <span class="mode-option-icon" aria-hidden="true">📂</span>
            <span class="mode-option-title">دروس بدون تصنيف</span>
            <span class="mode-option-desc">عرض الدروس غير المرتبطة بتصنيف</span>
          </button>`
        : "";
      const catTiles = sortedCats
        .map(
          (c) => `<button type="button" class="mode-option-btn" data-cat-id="${c.id}">
            <span class="mode-option-icon" aria-hidden="true">${escapeHtml(c.icon || "📖")}</span>
            <span class="mode-option-title">${escapeHtml(c.nameAr)}</span>
          </button>`,
        )
        .join("");
      return `
        <p class="text-slate-300 text-sm text-right m-0">اختر تصنيفاً لعرض الدروس، أو تصفّح كل الدروس.</p>
        <div class="mode-picker-grid lesson-picker-grid flex-1 overflow-y-auto min-h-0" role="group" aria-label="تصنيفات الدروس">
          <button type="button" class="mode-option-btn" data-lesson-all="1">
            <span class="mode-option-icon" aria-hidden="true">📚</span>
            <span class="mode-option-title">جميع الدروس</span>
            <span class="mode-option-desc">كل الدروس المنشورة</span>
          </button>
          ${uncatTile}
          ${catTiles}
        </div>`;
    })();

    const lessonsBlock = (() => {
      const label = lessonBrowseCategoryLabel();
      const lessonTiles =
        filtered.length === 0
          ? `<p class="text-slate-400 text-center py-10 m-0">لا توجد دروس في هذا العرض.</p>`
          : `<div class="mode-picker-grid lesson-picker-grid flex-1 overflow-y-auto min-h-0 py-1" role="group" aria-label="قائمة الدروس">
              ${filtered
                .map(
                  (l) => `<button type="button" class="mode-option-btn" data-pick-lesson="${l.id}">
                <span class="mode-option-icon" aria-hidden="true">${escapeHtml(l.category?.icon ?? "📖")}</span>
                <span class="mode-option-title">${escapeHtml(l.title)}</span>
                <span class="mode-option-desc">${l.itemCount} سؤالاً</span>
              </button>`,
                )
                .join("")}
            </div>`;
      return `
        <div class="flex items-center gap-2 flex-wrap">
          <button type="button" id="lesson-back-categories" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">تصنيفات</button>
        </div>
        <h2 class="text-lg font-extrabold text-amber-300 text-right m-0">${escapeHtml(label)}</h2>
        ${lessonTiles}`;
    })();

    const hubTitle = escapeHtml(hubLesson?.title ?? "الدرس");
    const hubDescRaw = (hubLesson?.description ?? "").trim();
    const hubDesc =
      hubDescRaw.length > 0
        ? `<p class="text-slate-300 text-sm text-right m-0 whitespace-pre-wrap">${escapeHtml(hubDescRaw)}</p>`
        : `<p class="text-slate-400 text-sm text-right m-0">${hubLesson?.itemCount ?? 0} سؤالاً في هذا الدرس.</p>`;

    const hubBlock =
      lessonBrowseStep === "lesson_hub"
        ? `
        <div class="flex items-center gap-2 flex-wrap">
          <button type="button" id="lesson-back-lessons" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">قائمة الدروس</button>
        </div>
        <div class="text-right space-y-1">
          <h2 class="text-xl font-extrabold text-amber-300 m-0">${hubTitle}</h2>
          ${hubDesc}
        </div>
        <p id="lesson-browse-msg" class="text-amber-200 text-sm min-h-[1.25rem] m-0">${escapeHtml(lessonBrowseMsg)}</p>
        <div class="app-card p-4 space-y-3 shrink-0">
          <p class="text-slate-400 text-xs text-right m-0">يُستخدم اسمك من الشاشة الرئيسية للتحدي والغرفة. إن لم يكن معرّفاً، ارجع للرئيسية وأدخل الاسم ثم عد إلى الدروس.</p>
          <button type="button" id="lesson-menu-rest" class="ui-btn ui-btn--primary w-full py-3">التعلم الفردي</button>
          <button type="button" id="lesson-menu-public" class="ui-btn ui-btn--cta w-full py-3">ابدأ التحدي</button>
          <button type="button" id="lesson-menu-create-private" class="ui-btn ui-btn--ghost w-full py-3">إنشاء غرفة خاصة</button>
          <div class="flex gap-2">
            <input id="lesson-menu-room-code" type="text" placeholder="كود الغرفة" class="app-input w-full px-3 py-2 text-right" />
            <button type="button" id="lesson-menu-join-private" class="ui-btn ui-btn--cta px-4 py-2 shrink-0">انضمام</button>
          </div>
          <p id="lesson-menu-err" class="text-red-400 text-sm min-h-[1.25rem] m-0"></p>
          <button type="button" id="lesson-menu-goto-name" class="ui-btn ui-btn--ghost w-full py-2 text-sm">الذهاب للرئيسية لإدخال الاسم</button>
        </div>`
        : "";

    const stepIntro =
      lessonBrowseStep === "categories"
        ? categoriesBlock
        : lessonBrowseStep === "lessons"
          ? lessonsBlock
          : hubBlock;

    const showBrowseMsgInHub = lessonBrowseStep !== "lesson_hub";

    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="lesson-back-home" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">الرئيسية</button>
            <h1 class="text-xl font-extrabold text-amber-300">دروس منظمة</h1>
          </div>
          ${showBrowseMsgInHub ? `<p id="lesson-browse-msg" class="text-amber-200 text-sm min-h-[1.25rem] m-0">${escapeHtml(lessonBrowseMsg)}</p>` : ""}
          <div class="flex flex-col gap-3 flex-1 min-h-0">${stepIntro}</div>
        </div>
      `),
    );

    const roomMenuInput = app.querySelector<HTMLInputElement>("#lesson-menu-room-code");
    if (roomMenuInput) {
      roomMenuInput.value = pendingJoinRoomCode;
      roomMenuInput.addEventListener("input", () => {
        pendingJoinRoomCode = roomMenuInput.value.trim().toUpperCase();
      });
    }
    const menuErr = app.querySelector<HTMLParagraphElement>("#lesson-menu-err");

    app.querySelector("#lesson-back-home")?.addEventListener("click", () => {
      lessonBrowseMsg = "";
      selectedLessonMatchId = null;
      lessonBrowseStep = "categories";
      lessonBrowseSelectedCategoryId = null;
      phase = "name";
      render();
    });

    app.querySelector("[data-lesson-all]")?.addEventListener("click", () => {
      lessonBrowseSelectedCategoryId = null;
      lessonBrowseStep = "lessons";
      lessonBrowseMsg = "";
      render();
    });
    app.querySelector("[data-lesson-uncat]")?.addEventListener("click", () => {
      lessonBrowseSelectedCategoryId = LESSON_BROWSE_UNCATEGORIZED;
      lessonBrowseStep = "lessons";
      lessonBrowseMsg = "";
      render();
    });
    app.querySelectorAll("[data-cat-id]").forEach((node) => {
      node.addEventListener("click", () => {
        const raw = (node as HTMLElement).dataset.catId;
        const id = raw ? Number(raw) : NaN;
        if (Number.isInteger(id) && id > 0) {
          lessonBrowseSelectedCategoryId = id;
          lessonBrowseStep = "lessons";
          lessonBrowseMsg = "";
          render();
        }
      });
    });

    app.querySelector("#lesson-back-categories")?.addEventListener("click", () => {
      lessonBrowseStep = "categories";
      lessonBrowseMsg = "";
      render();
    });

    app.querySelectorAll("[data-pick-lesson]").forEach((node) => {
      node.addEventListener("click", () => {
        const raw = (node as HTMLElement).dataset.pickLesson;
        const id = raw ? Number(raw) : NaN;
        if (Number.isInteger(id) && id > 0) {
          selectedLessonMatchId = id;
          lessonBrowseStep = "lesson_hub";
          lessonBrowseMsg = "";
          render();
        }
      });
    });

    app.querySelector("#lesson-back-lessons")?.addEventListener("click", () => {
      lessonBrowseStep = "lessons";
      selectedLessonMatchId = null;
      lessonBrowseMsg = "";
      render();
    });

    const clearMenuErr = (): void => {
      if (menuErr) menuErr.textContent = "";
    };

    app.querySelector("#lesson-menu-goto-name")?.addEventListener("click", () => {
      lessonBrowseMsg = "";
      phase = "name";
      nameFlowStep = "mode";
      render();
    });

    app.querySelector("#lesson-menu-rest")?.addEventListener("click", () => {
      clearMenuErr();
      if (!selectedLessonMatchId) {
        if (menuErr) menuErr.textContent = "تعذر تحديد الدرس.";
        return;
      }
      void openLessonById(selectedLessonMatchId);
    });
    app.querySelector("#lesson-menu-public")?.addEventListener("click", () => {
      clearMenuErr();
      const name = lessonMenuPlayerName();
      if (!selectedLessonMatchId) {
        if (menuErr) menuErr.textContent = "تعذر تحديد الدرس.";
        return;
      }
      if (!name) {
        if (menuErr)
          menuErr.textContent = "لم يُعرَّف اسم اللاعب. استخدم زر «الذهاب للرئيسية لإدخال الاسم».";
        return;
      }
      storePlayerName(name);
      playerNameDraft = name;
      phase = "matchmaking";
      soloLearningPending = false;
      currentGameMode = "lesson";
      lobbyNotice = "جاري الاتصال بالخادم والبحث عن منافسين لنفس الدرس…";
      render();
      connectSocket(name, "lesson", null, "mix", "public", undefined, selectedLessonMatchId);
    });
    app.querySelector("#lesson-menu-create-private")?.addEventListener("click", () => {
      clearMenuErr();
      const name = lessonMenuPlayerName();
      if (!name) {
        if (menuErr)
          menuErr.textContent = "لم يُعرَّف اسم اللاعب. استخدم زر «الذهاب للرئيسية لإدخال الاسم».";
        return;
      }
      if (!selectedLessonMatchId) {
        if (menuErr) menuErr.textContent = "تعذر تحديد الدرس.";
        return;
      }
      storePlayerName(name);
      playerNameDraft = name;
      phase = "private_room_lobby";
      soloLearningPending = false;
      privateRoomCodeState = null;
      privateRoomInviteUrl = null;
      privateQrDataUrl = null;
      isPrivateRoomSession = true;
      lobbyNotice = "جاري إنشاء الغرفة الخاصة...";
      currentGameMode = "lesson";
      render();
      connectSocket(
        name,
        "lesson",
        null,
        "mix",
        "private_create",
        undefined,
        selectedLessonMatchId,
      );
    });
    app.querySelector("#lesson-menu-join-private")?.addEventListener("click", () => {
      clearMenuErr();
      const name = lessonMenuPlayerName();
      const roomCode = (roomMenuInput?.value || pendingJoinRoomCode).trim().toUpperCase();
      if (!name) {
        if (menuErr)
          menuErr.textContent = "لم يُعرَّف اسم اللاعب. استخدم زر «الذهاب للرئيسية لإدخال الاسم».";
        return;
      }
      if (!roomCode) {
        if (menuErr) menuErr.textContent = "أدخل كود الغرفة.";
        return;
      }
      pendingJoinRoomCode = roomCode;
      storePlayerName(name);
      playerNameDraft = name;
      phase = "matchmaking";
      soloLearningPending = false;
      privateRoomCodeState = roomCode;
      privateRoomInviteUrl = null;
      privateQrDataUrl = null;
      isPrivateRoomSession = true;
      lastPrivateRoomCode = roomCode;
      currentGameMode = "lesson";
      lobbyNotice = "جاري الانضمام للغرفة الخاصة...";
      render();
      connectSocket(name, "lesson", null, "mix", "private_join", roomCode);
    });
    return;
  }

  if (phase === "lesson_study") {
    const card = lessonStudyQueue[lessonStudyIdx];
    const total = lessonStudyQueue.length;
    const isFirst = lessonStudyIdx <= 0;
    const isLast = total > 0 && lessonStudyIdx >= total - 1;
    app.append(
      el(`
        <div class="study-shell min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="flex items-center justify-between">
            <button type="button" id="lesson-study-exit" class="ui-btn ui-btn--ghost py-2 text-sm">خروج</button>
            <div id="lesson-seg-clock" class="text-xl font-mono font-bold text-emerald-300 tabular-nums">—</div>
          </div>
          <p class="text-amber-200 text-sm text-right m-0">${escapeHtml(lessonPlayback?.title ?? "")}</p>
          <p class="text-slate-400 text-xs text-right m-0">القسم ${lessonSectionIdx + 1} من ${lessonSectionsResolved().length} — بطاقة ${lessonStudyIdx + 1} من ${total}</p>
          <div class="study-cards-container flex-1">
            <div class="study-card study-card--0">
              <p class="study-card__body font-medium whitespace-pre-wrap">${escapeHtml(card?.body ?? "")}</p>
            </div>
          </div>
          <div class="flex gap-2">
            <button type="button" id="lesson-study-prev" class="ui-btn ui-btn--ghost flex-1 py-3" ${isFirst ? "disabled" : ""}>السابق</button>
            <button type="button" id="lesson-study-skip" class="ui-btn ui-btn--primary flex-1 py-3" ${isLast ? "disabled" : ""}>التالي</button>
          </div>
          ${
            isLast && total > 0
              ? `<button type="button" id="lesson-study-finish-review" class="ui-btn ui-btn--cta w-full py-2 text-sm">أنهيت المراجعة — انتقل للاختبار</button>`
              : ""
          }
        </div>
      `),
    );
    const exit = () => {
      exitLessonPlaybackToHub();
      void fetchLessonBrowse()
        .then(() => {
          render();
        })
        .catch(() => {
          render();
        });
    };
    app.querySelector("#lesson-study-exit")?.addEventListener("click", exit);
    app.querySelector("#lesson-study-prev")?.addEventListener("click", () => {
      if (lessonStudyIdx <= 0) return;
      clearTimer();
      lessonStudyIdx--;
      lessonStudySegmentEndAt = nowSynced() + lessonStudyQueue[lessonStudyIdx].ms;
      render();
    });
    app.querySelector("#lesson-study-skip")?.addEventListener("click", () => {
      if (lessonStudyIdx >= lessonStudyQueue.length - 1) return;
      clearTimer();
      lessonStudyIdx++;
      lessonStudySegmentEndAt = nowSynced() + lessonStudyQueue[lessonStudyIdx].ms;
      render();
    });
    app.querySelector("#lesson-study-finish-review")?.addEventListener("click", () => {
      clearTimer();
      phase = "lesson_quiz";
      lessonQuizIdxInSection = 0;
      lessonPrepareCurrentLessonQuizQuestion();
      render();
    });
    clearTimer();
    timerHandle = window.setInterval(() => {
      const clock = app.querySelector<HTMLDivElement>("#lesson-seg-clock");
      const now = nowSynced();
      const sectionLeft = Math.max(0, lessonStudySectionDeadlineAt - now);
      const secShown = Math.max(0, Math.floor((sectionLeft + 250) / 1000));
      if (clock) clock.textContent = `${secShown}s`;
      if (sectionLeft <= 0) {
        clearTimer();
        phase = "lesson_quiz";
        lessonQuizIdxInSection = 0;
        lessonPrepareCurrentLessonQuizQuestion();
        render();
        return;
      }
      const cardLeft = lessonStudySegmentEndAt - now;
      if (cardLeft <= 0) {
        clearTimer();
        lessonStudyIdx++;
        if (lessonStudyIdx >= lessonStudyQueue.length) {
          phase = "lesson_quiz";
          lessonQuizIdxInSection = 0;
          lessonPrepareCurrentLessonQuizQuestion();
        } else {
          lessonStudySegmentEndAt = nowSynced() + lessonStudyQueue[lessonStudyIdx].ms;
        }
        render();
      }
    }, 200);
    return;
  }

  if (phase === "lesson_quiz") {
    const secs = lessonSectionsResolved();
    const sec = secs[lessonSectionIdx];
    const step = sec?.steps[lessonQuizIdxInSection];
    const totalQ = lessonPlayback?.steps.length ?? 0;
    const secCount = secs.length;
    app.append(
      el(`
        <div class="playing-shell app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="lesson-quiz-exit" class="ui-btn ui-btn--ghost py-2 text-sm">خروج</button>
            <div id="lesson-quiz-clock" class="text-xl font-mono font-bold text-amber-300 tabular-nums">—</div>
          </div>
          <p class="text-slate-400 text-xs text-right m-0">القسم ${lessonSectionIdx + 1} من ${secCount} — سؤال ${lessonGlobalQuestionOrdinal()} من ${totalQ}</p>
          <div class="question-card rounded-2xl p-5 flex-1 flex flex-col gap-4 shadow-xl min-h-0">
            <p id="lesson-q-text" class="text-right text-xl font-semibold leading-relaxed min-h-[4rem]"></p>
            <div id="lesson-opts" class="options-grid grid"></div>
          </div>
          <p id="lesson-q-status" class="status-line text-center text-sm min-h-[1.25rem]"></p>
        </div>
      `),
    );
    const qText = app.querySelector<HTMLParagraphElement>("#lesson-q-text");
    const opts = app.querySelector<HTMLDivElement>("#lesson-opts");
    const status = app.querySelector<HTMLParagraphElement>("#lesson-q-status");
    if (step && qText && opts) {
      qText.textContent = step.prompt;
      const prevFocus = document.activeElement;
      if (prevFocus instanceof HTMLElement && opts.contains(prevFocus)) prevFocus.blur();
      opts.innerHTML = "";
      let answered = false;
      step.options.forEach((label, idx) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "option-btn";
        b.textContent = label;
        b.addEventListener("click", () => {
          if (lessonQuizLocked || answered || lessonQuizRoundResolved) return;
          answered = true;
          const ok = idx === step.correctIndex;
          b.classList.add(ok ? "option-btn--selected" : "option-btn--pressed");
          opts.querySelectorAll("button").forEach((btn) => {
            (btn as HTMLButtonElement).disabled = true;
            btn.classList.add("option-btn--disabled");
          });
          if (status) {
            status.textContent = ok ? "صحيح!" : "غير صحيح.";
          }
          advanceLessonQuizAfterResolution(ok, idx);
        });
        opts.appendChild(b);
      });
    }
    app.querySelector("#lesson-quiz-exit")?.addEventListener("click", () => {
      exitLessonPlaybackToHub();
      void fetchLessonBrowse()
        .then(() => render())
        .catch(() => render());
    });
    startLessonQuizTimer();
    return;
  }

  if (phase === "lesson_done") {
    const total = lessonPlayback?.steps.length ?? 0;
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-6 flex flex-col items-center justify-center max-w-md mx-auto text-center gap-6">
          <h2 class="text-2xl font-extrabold text-amber-300">أنهيت الدرس</h2>
          <p class="text-slate-200 text-lg">${escapeHtml(lessonPlayback?.title ?? "")}</p>
          <p class="text-emerald-300 text-xl font-bold">النتيجة: ${lessonQuizCorrect} / ${total}</p>
          <button type="button" id="lesson-review-open" class="ui-btn ui-btn--primary w-full py-3 text-lg">مراجعة الإجابات</button>
          <button type="button" id="lesson-redo" class="ui-btn ui-btn--cta w-full py-3 text-lg">إعادة الدرس</button>
          <button type="button" id="lesson-done-end-custom" class="ui-btn ui-btn--primary w-full py-3 text-lg">إنهاء الدرس</button>
          <button type="button" id="lesson-done-home-main" class="ui-btn ui-btn--ghost w-full py-3">العودة للرئيسية</button>
        </div>
      `),
    );
    app.querySelector("#lesson-review-open")?.addEventListener("click", () => {
      lessonReviewIndex = 0;
      phase = "lesson_review";
      render();
    });
    app.querySelector("#lesson-redo")?.addEventListener("click", () => {
      const snap = lessonPlayback;
      if (!snap?.steps?.length) return;
      clearTimer();
      beginLessonPlayback(snap);
      render();
    });
    app.querySelector("#lesson-done-end-custom")?.addEventListener("click", () => {
      clearTimer();
      resetLessonState();
      customLessonPreviewLesson = null;
      customLessonValidatedBody = null;
      customLessonSessionToken = null;
      customLessonErr = "";
      customLessonMsg = "";
      phase = "custom_lesson";
      render();
    });
    app.querySelector("#lesson-done-home-main")?.addEventListener("click", () => {
      clearTimer();
      resetLessonState();
      returnToHomeFromSearch();
    });
    return;
  }

  if (phase === "lesson_review") {
    const items = lessonRestReviewItems();
    const cur = items[lessonReviewIndex];
    const n = items.length;
    app.append(
      el(`
        <div class="playing-shell app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="lesson-review-back" class="ui-btn ui-btn--ghost py-2 text-sm">رجوع للنتيجة</button>
            <span class="text-slate-400 text-xs">سؤال ${lessonReviewIndex + 1} / ${n}</span>
          </div>
          <p class="text-amber-200 text-sm text-right m-0">${escapeHtml(lessonPlayback?.title ?? "")}</p>
          <div id="lesson-review-root" class="question-card rounded-2xl p-5 flex-1 flex flex-col gap-4 shadow-xl min-h-0"></div>
          <div class="flex gap-2">
            <button type="button" id="lesson-review-prev" class="ui-btn ui-btn--ghost flex-1 py-2" ${lessonReviewIndex <= 0 ? "disabled" : ""}>السابق</button>
            <button type="button" id="lesson-review-next" class="ui-btn ui-btn--ghost flex-1 py-2" ${lessonReviewIndex >= n - 1 ? "disabled" : ""}>التالي</button>
          </div>
        </div>
      `),
    );
    const root = app.querySelector<HTMLDivElement>("#lesson-review-root");
    if (root && cur) {
      const choiceIdx = cur.choiceIndex;
      const optsHtml = cur.options
        .map((label, idx) => {
          const isCorrect = idx === cur.correctIndex;
          const isWrongPick =
            choiceIdx != null && choiceIdx !== cur.correctIndex && choiceIdx === idx;
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
      phase = "lesson_done";
      render();
    });
    app.querySelector("#lesson-review-prev")?.addEventListener("click", () => {
      if (lessonReviewIndex > 0) {
        lessonReviewIndex--;
        render();
      }
    });
    app.querySelector("#lesson-review-next")?.addEventListener("click", () => {
      if (lessonReviewIndex < n - 1) {
        lessonReviewIndex++;
        render();
      }
    });
    return;
  }

  if (phase === "match_lesson_review") {
    const items = matchLessonReviewItems ?? [];
    const cur = items[matchLessonReviewIndex];
    const n = items.length;
    app.append(
      el(`
        <div class="playing-shell app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="match-lesson-review-back" class="ui-btn ui-btn--ghost py-2 text-sm">رجوع للنتيجة</button>
            <span class="text-slate-400 text-xs">سؤال ${matchLessonReviewIndex + 1} / ${n}</span>
          </div>
          <p class="text-amber-200 text-sm text-right m-0">مراجعة الدرس</p>
          <div id="match-lesson-review-root" class="question-card rounded-2xl p-5 flex-1 flex flex-col gap-4 shadow-xl min-h-0"></div>
          <div class="flex gap-2">
            <button type="button" id="match-lesson-review-prev" class="ui-btn ui-btn--ghost flex-1 py-2" ${
              matchLessonReviewIndex <= 0 ? "disabled" : ""
            }>السابق</button>
            <button type="button" id="match-lesson-review-next" class="ui-btn ui-btn--ghost flex-1 py-2" ${
              matchLessonReviewIndex >= n - 1 ? "disabled" : ""
            }>التالي</button>
          </div>
        </div>
      `),
    );
    const root = app.querySelector<HTMLDivElement>("#match-lesson-review-root");
    if (root && cur) {
      const choiceIdx = cur.choiceIndex;
      const optsHtml = cur.options
        .map((label, idx) => {
          const isCorrect = idx === cur.correctIndex;
          const isWrongPick =
            choiceIdx != null && choiceIdx !== cur.correctIndex && choiceIdx === idx;
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
    app.querySelector("#match-lesson-review-back")?.addEventListener("click", () => {
      phase = "result";
      render();
    });
    app.querySelector("#match-lesson-review-prev")?.addEventListener("click", () => {
      if (matchLessonReviewIndex > 0) {
        matchLessonReviewIndex--;
        render();
      }
    });
    app.querySelector("#match-lesson-review-next")?.addEventListener("click", () => {
      if (matchLessonReviewIndex < n - 1) {
        matchLessonReviewIndex++;
        render();
      }
    });
    return;
  }

  if (phase === "matchmaking") {
    const isPrivateLobby = Boolean(privateRoomCodeState);
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
            <div class="${isPrivateLobby ? "w-full app-card private-room-card p-4 space-y-3 text-right" : "hidden"}">
              <p class="text-sm text-slate-300 m-0">كود الغرفة: <b id="private-room-code">${privateRoomCodeState ?? ""}</b></p>
              <div class="private-room-actions flex gap-2">
                <button id="copy-private-link-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm">نسخ الرابط</button>
                <button id="private-ready-btn" type="button" class="ui-btn ui-btn--cta w-full py-2 text-sm">جاهز</button>
              </div>
              <img id="private-qr-img" class="w-40 h-40 mx-auto rounded-lg bg-white p-2" alt="QR الغرفة" />
              <div class="space-y-2 ${mySocketId && privateRoomHostSocketId === mySocketId ? "" : "hidden"}">
                <label class="block text-xs text-slate-400">وقت السؤال (ثانية)</label>
                <input id="private-question-ms-input" type="number" min="5" max="120" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomQuestionMs / 1000)}" />
                <div class="${currentGameMode === "study_then_quiz" ? "" : "hidden"}">
                  <label class="block text-xs text-slate-400">وقت بطاقات المذاكرة (ثانية)</label>
                  <input id="private-study-ms-input" type="number" min="10" max="300" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomStudyPhaseMs / 1000)}" />
                </div>
                <button id="private-save-settings-btn" type="button" class="ui-btn ui-btn--primary w-full py-2 text-sm">حفظ إعدادات الوقت</button>
              </div>
              <div id="private-players-list" class="private-players-list text-sm text-slate-200"></div>
            </div>
            <div class="w-full flex flex-col sm:flex-row gap-3">
              <button id="cancel-search-btn" type="button" class="ui-btn ui-btn--ghost w-full py-3 text-base ${isPrivateLobby ? "hidden" : ""}">إلغاء البحث</button>
              <button id="home-search-btn" type="button" class="ui-btn ui-btn--primary w-full py-3 text-base">الصفحة الرئيسية</button>
            </div>
          </div>
        </div>
      `),
    );
    updateConnectionBadge();
    updateLobbyModeLabel();
    const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
    if (noticeEl) noticeEl.textContent = lobbyNotice;
    if (isPrivateLobby) {
      const inviteUrl = privateRoomInviteUrl || `${window.location.origin}?room=${privateRoomCodeState}`;
      const qrImg = app.querySelector<HTMLImageElement>("#private-qr-img");
      if (qrImg) {
        qrImg.src = privateQrDataUrl || "";
      }
      const playersEl = app.querySelector<HTMLDivElement>("#private-players-list");
      if (playersEl) {
        playersEl.innerHTML = lobbyPlayersList
          .map((p) => {
            const isMe = mySocketId && p.socketId === mySocketId;
            const isHost = privateRoomHostSocketId && p.socketId === privateRoomHostSocketId;
            return `<div class="private-player-row flex items-center justify-between py-2 px-2 border-b border-white/10">
              <span class="private-player-name">${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}${isHost ? " 👑" : ""}</span>
              <span class="private-player-ready ${p.ready ? "is-ready text-emerald-300" : "text-slate-400"}">${p.ready ? "جاهز" : "غير جاهز"}</span>
            </div>`;
          })
          .join("");
      }
      app.querySelector<HTMLButtonElement>("#copy-private-link-btn")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(inviteUrl);
          lobbyNotice = "تم نسخ رابط الغرفة.";
        } catch {
          lobbyNotice = "تعذر نسخ الرابط.";
        }
        const n = app.querySelector<HTMLParagraphElement>("#lobby-notice");
        if (n) n.textContent = lobbyNotice;
      });
      app.querySelector<HTMLButtonElement>("#private-ready-btn")?.addEventListener("click", () => {
        socket?.emit("private_room_set_ready", { ready: true }, (ack?: { ok?: boolean }) => {
          if (!ack?.ok) {
            lobbyNotice = "تعذر تغيير حالة الجاهزية.";
            const n = app.querySelector<HTMLParagraphElement>("#lobby-notice");
            if (n) n.textContent = lobbyNotice;
          }
        });
      });
      app.querySelector<HTMLButtonElement>("#private-save-settings-btn")?.addEventListener("click", () => {
        const qSec = Number(app.querySelector<HTMLInputElement>("#private-question-ms-input")?.value ?? "15");
        const sSecDefault = Math.max(10, Math.round(privateRoomStudyPhaseMs / 1000));
        const sSec = Number(app.querySelector<HTMLInputElement>("#private-study-ms-input")?.value ?? String(sSecDefault));
        socket?.emit("private_room_update_settings", { questionMs: qSec * 1000, studyPhaseMs: sSec * 1000 }, (ack?: { ok?: boolean; roomSettings?: { questionMs?: number; studyPhaseMs?: number } }) => {
          if (ack?.ok) {
            if (ack.roomSettings?.questionMs) privateRoomQuestionMs = ack.roomSettings.questionMs;
            if (ack.roomSettings?.studyPhaseMs) privateRoomStudyPhaseMs = ack.roomSettings.studyPhaseMs;
            lobbyNotice = "تم حفظ إعدادات الوقت.";
          } else {
            lobbyNotice = "تعذر حفظ الإعدادات.";
          }
          const n = app.querySelector<HTMLParagraphElement>("#lobby-notice");
          if (n) n.textContent = lobbyNotice;
        });
      });
    }
    app.querySelector<HTMLButtonElement>("#cancel-search-btn")?.addEventListener("click", returnToDifficultyFromSearch);
    app.querySelector<HTMLButtonElement>("#home-search-btn")?.addEventListener("click", returnToHomeFromSearch);
    syncMatchmakingStatusText();
    return;
  }

  if (phase === "private_room_lobby") {
    const inviteUrl = privateRoomInviteUrl || `${window.location.origin}?room=${privateRoomCodeState ?? ""}`;
    const meReady = Boolean(lobbyPlayersList.find((p) => p.socketId === mySocketId)?.ready);
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full">
          <header class="flex items-center justify-between py-4">
            <h1 class="text-2xl font-extrabold text-amber-300">فاهم</h1>
            <span id="conn" class="text-xs px-2 py-1 rounded-full bg-white/10">…</span>
          </header>
          <p id="lobby-mode" class="text-right text-sm text-slate-400 mb-2"></p>
          <div class="app-card private-room-card p-4 space-y-3 text-right">
            <p class="text-sm text-slate-300 m-0">كود الغرفة: <b id="private-room-code">${privateRoomCodeState ?? ""}</b></p>
            <div class="private-room-actions flex gap-2">
              <button id="copy-private-link-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm">نسخ الرابط</button>
              <button id="private-ready-btn" type="button" class="ui-btn ui-btn--cta w-full py-2 text-sm">${privateReadyPending ? "جارٍ الإرسال..." : meReady ? "إلغاء الجاهزية" : "جاهز"}</button>
            </div>
            <img id="private-qr-img" class="w-40 h-40 mx-auto rounded-lg bg-white p-2" alt="QR الغرفة" />
            <p class="text-xs text-slate-400 break-all">${escapeHtml(inviteUrl)}</p>
            <div class="space-y-2 ${mySocketId && privateRoomHostSocketId === mySocketId ? "" : "hidden"}">
              <label class="block text-xs text-slate-400">وقت السؤال (ثانية)</label>
              <input id="private-question-ms-input" type="number" min="5" max="120" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomQuestionMs / 1000)}" />
              <div class="${currentGameMode === "study_then_quiz" ? "" : "hidden"}">
                <label class="block text-xs text-slate-400">وقت بطاقات المذاكرة (ثانية)</label>
                <input id="private-study-ms-input" type="number" min="10" max="300" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomStudyPhaseMs / 1000)}" />
              </div>
              <button id="private-save-settings-btn" type="button" class="ui-btn ui-btn--primary w-full py-2 text-sm">حفظ إعدادات الوقت</button>
            </div>
            <div id="private-players-list" class="private-players-list text-sm text-slate-200"></div>
          </div>
          <p id="lobby-notice" class="text-center text-amber-200 text-sm min-h-[1.25rem] max-w-md mt-4">${escapeHtml(lobbyNotice)}</p>
          <div class="w-full flex flex-col sm:flex-row gap-3 mt-2">
            <button id="home-search-btn" type="button" class="ui-btn ui-btn--primary w-full py-3 text-base">الصفحة الرئيسية</button>
          </div>
        </div>
      `),
    );
    updateConnectionBadge();
    updateLobbyModeLabel();
    const playersEl = app.querySelector<HTMLDivElement>("#private-players-list");
    if (playersEl) {
      playersEl.innerHTML = lobbyPlayersList
        .map((p) => {
          const isMe = mySocketId && p.socketId === mySocketId;
          const isHost = privateRoomHostSocketId && p.socketId === privateRoomHostSocketId;
          return `<div class="private-player-row flex items-center justify-between py-2 px-2 border-b border-white/10">
            <span class="private-player-name">${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}${isHost ? " 👑" : ""}</span>
            <span class="private-player-ready ${p.ready ? "is-ready text-emerald-300" : "text-slate-400"}">${p.ready ? "جاهز" : "غير جاهز"}</span>
          </div>`;
        })
        .join("");
    }
    const qrImg = app.querySelector<HTMLImageElement>("#private-qr-img");
    if (qrImg) qrImg.src = privateQrDataUrl || "";
    app.querySelector<HTMLButtonElement>("#copy-private-link-btn")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteUrl);
        lobbyNotice = "تم نسخ رابط الغرفة.";
      } catch {
        lobbyNotice = "تعذر نسخ الرابط.";
      }
      const n = app.querySelector<HTMLParagraphElement>("#lobby-notice");
      if (n) n.textContent = lobbyNotice;
    });
    app.querySelector<HTMLButtonElement>("#private-ready-btn")?.addEventListener("click", () => {
      if (privateReadyPending) return;
      const me = lobbyPlayersList.find((p) => p.socketId === mySocketId);
      const nextReady = !Boolean(me?.ready);
      privateReadyPending = true;
      render();
      socket?.emit("private_room_set_ready", { ready: nextReady }, (ack?: { ok?: boolean }) => {
        privateReadyPending = false;
        if (!ack?.ok) {
          lobbyNotice = "تعذر تغيير حالة الجاهزية.";
        }
        render();
      });
    });
    app.querySelector<HTMLButtonElement>("#private-save-settings-btn")?.addEventListener("click", () => {
      const qSec = Number(app.querySelector<HTMLInputElement>("#private-question-ms-input")?.value ?? "15");
      const sSecDefault = Math.max(10, Math.round(privateRoomStudyPhaseMs / 1000));
      const sSec = Number(app.querySelector<HTMLInputElement>("#private-study-ms-input")?.value ?? String(sSecDefault));
      socket?.emit("private_room_update_settings", { questionMs: qSec * 1000, studyPhaseMs: sSec * 1000 }, (ack?: { ok?: boolean; roomSettings?: { questionMs?: number; studyPhaseMs?: number } }) => {
        if (ack?.ok) {
          if (ack.roomSettings?.questionMs) privateRoomQuestionMs = ack.roomSettings.questionMs;
          if (ack.roomSettings?.studyPhaseMs) privateRoomStudyPhaseMs = ack.roomSettings.studyPhaseMs;
          lobbyNotice = "تم حفظ إعدادات الوقت.";
        } else {
          lobbyNotice = "تعذر حفظ الإعدادات.";
        }
        render();
      });
    });
    app.querySelector<HTMLButtonElement>("#home-search-btn")?.addEventListener("click", returnToHomeFromSearch);
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
    const lessonNav = lessonMatchStudyNav && hasCards;
    const idx1 = lessonNav ? lessonMatchStudyCardIndex + 1 : 0;
    app.append(
      el(`
        <div class="study-shell min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4">
          <div class="study-progress-fixed">
            <div class="study-progress-head">
              <h2 class="text-lg font-bold text-amber-200 drop-shadow-sm">${
                lessonMatchStudyNav ? "مراجعة الدرس" : "مراجعة قبل الأسئلة"
              }</h2>
              <div id="study-main-clock" class="text-xl font-mono font-bold text-emerald-300 tabular-nums drop-shadow-sm">—</div>
            </div>
            <p id="study-main-clock-label" class="text-right text-slate-300 text-xs min-h-[1rem]">${
              lessonMatchStudyNav ? "وقت المراجعة" : "وقت المذاكرة"
            }</p>
            <div id="study-progress-track" class="study-progress-track" role="progressbar" aria-label="تقدم وقت المذاكرة" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div id="study-progress-fill" class="study-progress-fill"></div>
            </div>
          </div>
          <div class="study-content-stack">
          <div class="space-y-2">
          <button id="round-ready-btn" type="button" class="ui-btn ui-btn--primary w-full py-2 text-sm">جاهز للجولة (تخطي العداد عند جاهزية الجميع)</button>
          <p id="study-ready-state" class="text-right text-amber-200/90 text-xs min-h-[1.1rem] leading-relaxed"></p>
          </div>
          <p id="study-lesson-card-pos" class="text-right text-slate-400 text-xs min-h-[1rem] m-0 ${
            lessonNav ? "" : "hidden"
          }">بطاقة ${idx1} من ${studyCards.length}${
            lessonNav && lessonMatchSectionMeta.count > 0
              ? ` — القسم ${lessonMatchSectionMeta.index + 1} من ${lessonMatchSectionMeta.count}`
              : ""
          }${lessonNav && lessonMatchSectionMeta.title ? ` (${escapeHtml(lessonMatchSectionMeta.title)})` : ""}</p>
          <div id="study-cards" class="study-cards-container flex-1 space-y-4 overflow-y-auto pb-2"></div>
          <div class="flex gap-2 pt-1 ${lessonNav ? "" : "hidden"}">
            <button type="button" id="lesson-match-study-prev" class="ui-btn ui-btn--ghost flex-1 py-2" ${
              lessonNav && lessonMatchStudyCardIndex <= 0 ? "disabled" : ""
            }>السابق</button>
            <button type="button" id="lesson-match-study-next" class="ui-btn ui-btn--primary flex-1 py-2" ${
              lessonNav && lessonMatchStudyCardIndex >= studyCards.length - 1 ? "disabled" : ""
            }>التالي</button>
          </div>
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
      if (lessonMatchStudyNav) {
        const c = studyCards[lessonMatchStudyCardIndex];
        if (c) {
          const variant = Math.abs(c.order) % 6;
          container.innerHTML = `<div class="study-card study-card--${variant}"><p class="study-card__body font-medium whitespace-pre-wrap">${escapeHtml(c.body)}</p></div>`;
        }
      } else {
        studyCards.forEach((c, i) => {
          const card = document.createElement("div");
          const variant = Math.abs(c.order) % 6;
          card.className = `study-card study-card--${variant}`;
          card.style.animationDelay = `${i * 0.08}s`;
          card.innerHTML = `<p class="study-card__body font-medium">${escapeHtml(c.body)}</p>`;
          container.appendChild(card);
        });
      }
    }
    app.querySelector("#lesson-match-study-prev")?.addEventListener("click", () => {
      if (!lessonMatchStudyNav || lessonMatchStudyCardIndex <= 0) return;
      lessonMatchStudyCardIndex -= 1;
      render();
    });
    app.querySelector("#lesson-match-study-next")?.addEventListener("click", () => {
      if (!lessonMatchStudyNav || lessonMatchStudyCardIndex >= studyCards.length - 1) return;
      lessonMatchStudyCardIndex += 1;
      render();
    });
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
    const showPrivateRoomActions = isPrivateRoomSession && Boolean(lastPrivateRoomCode);
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
          <button id="match-lesson-review-open" type="button" class="result-screen__again ui-btn ui-btn--primary w-full py-3 text-base ${
            matchLessonReviewItems && matchLessonReviewItems.length > 0 && !showPrivateRoomActions ? "" : "hidden"
          }">مراجعة الدرس</button>
          <div class="${showPrivateRoomActions ? "w-full flex flex-col sm:flex-row gap-3" : "hidden"}">
            <button id="back-private-room" type="button" class="result-screen__again ui-btn ui-btn--cta w-full py-3 text-base">العودة للغرفة الخاصة</button>
            <button id="go-home-from-result" type="button" class="result-screen__again ui-btn ui-btn--ghost w-full py-3 text-base">الصفحة الرئيسية</button>
          </div>
          <button id="again" type="button" class="result-screen__again ui-btn ui-btn--primary w-full py-3 text-lg ${showPrivateRoomActions ? "hidden" : ""}">العب مجدداً</button>
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
    app.querySelector("#match-lesson-review-open")?.addEventListener("click", () => {
      if (!matchLessonReviewItems?.length) return;
      matchLessonReviewIndex = 0;
      phase = "match_lesson_review";
      render();
    });
    const again = app.querySelector<HTMLButtonElement>("#again")!;
    again.addEventListener("click", () => {
      matchLessonReviewItems = null;
      matchLessonReviewIndex = 0;
      phase = "name";
      nameFlowStep = "mode";
      selectedDifficultyMode = "mix";
      selectedMainCategoryId = null;
      selectedSubcategoryKey = null;
      selectedSubcategoryLabel = null;
      soloLearningPending = false;
      privateRoomCodeState = null;
      privateRoomHostSocketId = null;
      privateRoomInviteUrl = null;
      socket?.disconnect();
      socket = null;
      mySocketId = null;
      currentGameMode = null;
      studyCards = [];
      lobbyPlayersList = [];
      render();
    });
    const backPrivateRoomBtn = app.querySelector<HTMLButtonElement>("#back-private-room");
    backPrivateRoomBtn?.addEventListener("click", () => {
      const roomCode = lastPrivateRoomCode;
      if (!roomCode) return;
      const name = (playerNameDraft || getStoredPlayerName()).trim();
      if (!name) {
        phase = "name";
        pendingJoinRoomCode = roomCode;
        privateEntryAutoJoinTried = false;
        render();
        const errEl = document.querySelector<HTMLParagraphElement>("#join-err");
        if (errEl) errEl.textContent = "أدخل الاسم للعودة إلى الغرفة الخاصة.";
        return;
      }
      phase = "matchmaking";
      privateRoomCodeState = roomCode;
      privateRoomInviteUrl = `${window.location.origin}?room=${roomCode}`;
      lobbyNotice = "جاري العودة إلى الغرفة الخاصة...";
      privateReadyPending = false;
      render();
      connectSocket(name, "direct", null, "mix", "private_join", roomCode);
    });
    app.querySelector<HTMLButtonElement>("#go-home-from-result")?.addEventListener("click", () => {
      returnToHomeFromSearch();
    });
  }
}

function updateLobbyModeLabel(): void {
  const elMode = app.querySelector<HTMLParagraphElement>("#lobby-mode");
  if (!elMode || !currentGameMode) return;
  if (soloLearningPending) {
    elMode.textContent =
      currentGameMode === "direct"
        ? "التعلم الفردي — نمط مباشر"
        : currentGameMode === "lesson"
          ? "التعلم الفردي — درس في تحدٍ"
          : "التعلم الفردي — مراجعة ثم أسئلة";
    return;
  }
  if (privateRoomCodeState) {
    elMode.textContent =
      currentGameMode === "direct"
        ? `غرفة خاصة (${privateRoomCodeState}) — نمط مباشر`
        : currentGameMode === "lesson"
          ? `غرفة خاصة (${privateRoomCodeState}) — درس في تحدٍ`
          : `غرفة خاصة (${privateRoomCodeState}) — مراجعة ثم أسئلة`;
    return;
  }
  elMode.textContent =
    currentGameMode === "direct"
      ? "البحث عن تحدي — نمط مباشر"
      : currentGameMode === "lesson"
        ? "البحث عن تحدي — درس في تحدٍ"
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
  if (soloLearningPending) {
    el.textContent = "جاري تجهيز جولتك الفردية…";
    return;
  }
  if (privateRoomCodeState) {
    const allReady = lobbyPlayersList.length > 0 && lobbyPlayersList.every((p) => p.ready);
    el.textContent = allReady
      ? "الجميع جاهزون. جاري بدء الجولة..."
      : "بانتظار جاهزية جميع اللاعبين في الغرفة...";
    return;
  }
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

function resetLessonState(): void {
  lessonPlayback = null;
  lessonStudyQueue = [];
  lessonStudyIdx = 0;
  lessonStudySegmentEndAt = 0;
  lessonStudySectionDeadlineAt = 0;
  lessonQuizIdx = 0;
  lessonQuizIdxInSection = 0;
  lessonSectionIdx = 0;
  lessonQuizCorrect = 0;
  lessonQuizLocked = false;
  lessonQuizRoundResolved = false;
  lessonRestChoiceByQuestionId = new Map();
  lessonReviewIndex = 0;
  currentQuestionId = null;
}

function lessonSectionsResolved(): LessonPlaybackSection[] {
  if (!lessonPlayback) return [];
  if (lessonPlayback.sections && lessonPlayback.sections.length > 0) return lessonPlayback.sections;
  return [{ id: 0, sortOrder: 0, titleAr: null, steps: lessonPlayback.steps }];
}

function lessonGlobalQuestionOrdinal(): number {
  const secs = lessonSectionsResolved();
  let n = 0;
  for (let i = 0; i < lessonSectionIdx; i++) n += secs[i]?.steps.length ?? 0;
  return n + lessonQuizIdxInSection + 1;
}

function startLessonStudyForCurrentSection(): void {
  if (!lessonPlayback) {
    phase = "lesson_done";
    return;
  }
  const secs = lessonSectionsResolved();
  if (lessonSectionIdx >= secs.length) {
    phase = "lesson_done";
    return;
  }
  const sec = secs[lessonSectionIdx];
  lessonStudyQueue = sec.steps
    .filter((s) => Boolean(s.studyBody?.trim()))
    .map((s) => ({ body: s.studyBody as string, ms: s.effectiveStudyCardMs }));
  lessonStudyIdx = 0;
  if (lessonStudyQueue.length > 0) {
    phase = "lesson_study";
    const sumCardMs = lessonStudyQueue.reduce((acc, q) => acc + q.ms, 0);
    const phaseCap =
      typeof sec.studyPhaseMs === "number" && Number.isFinite(sec.studyPhaseMs) && sec.studyPhaseMs > 0
        ? sec.studyPhaseMs
        : sumCardMs;
    lessonStudySectionDeadlineAt = nowSynced() + Math.max(1000, phaseCap);
    lessonStudySegmentEndAt = nowSynced() + lessonStudyQueue[0].ms;
  } else {
    phase = "lesson_quiz";
    lessonQuizIdxInSection = 0;
    lessonPrepareCurrentLessonQuizQuestion();
  }
}

function lessonMenuPlayerName(): string {
  return (playerNameDraft || getStoredPlayerName() || "").trim();
}

function lessonBrowseSortedCategories(): typeof lessonBrowseCategories {
  return [...lessonBrowseCategories].sort((a, b) => {
    const ap = a.parentId == null ? 0 : 1;
    const bp = b.parentId == null ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id;
  });
}

function lessonBrowseHasUncategorized(): boolean {
  return lessonBrowseLessons.some((l) => l.category == null);
}

function lessonBrowseFilteredLessons(): typeof lessonBrowseLessons {
  if (lessonBrowseSelectedCategoryId === LESSON_BROWSE_UNCATEGORIZED) {
    return lessonBrowseLessons.filter((l) => l.category == null);
  }
  if (lessonBrowseSelectedCategoryId != null && lessonBrowseSelectedCategoryId > 0) {
    return lessonBrowseLessons.filter((l) => l.category?.id === lessonBrowseSelectedCategoryId);
  }
  return lessonBrowseLessons;
}

function lessonBrowseCategoryLabel(): string {
  if (lessonBrowseSelectedCategoryId === LESSON_BROWSE_UNCATEGORIZED) return "دروس بدون تصنيف";
  if (lessonBrowseSelectedCategoryId != null && lessonBrowseSelectedCategoryId > 0) {
    const c = lessonBrowseCategories.find((x) => x.id === lessonBrowseSelectedCategoryId);
    return c?.nameAr ?? "التصنيف";
  }
  return "جميع الدروس";
}

function exitLessonPlaybackToHub(): void {
  clearTimer();
  resetLessonState();
  lessonBrowseStep = "lesson_hub";
  phase = "lesson_menu";
}

async function fetchLessonBrowse(): Promise<void> {
  lessonBrowseMsg = "";
  const [cRes, lRes] = await Promise.all([
    fetch("/api/lesson-categories", { cache: "no-store" }),
    fetch("/api/lessons", { cache: "no-store" }),
  ]);
  const cJson = (await cRes.json()) as { ok?: boolean; categories?: typeof lessonBrowseCategories };
  const lJson = (await lRes.json()) as { ok?: boolean; lessons?: typeof lessonBrowseLessons };
  if (!cRes.ok || !cJson.ok) throw new Error("lesson_categories_failed");
  if (!lRes.ok || !lJson.ok) throw new Error("lessons_failed");
  lessonBrowseCategories = cJson.categories ?? [];
  lessonBrowseLessons = lJson.lessons ?? [];
}

function beginLessonPlayback(data: LessonPlaybackPayload): void {
  resetLessonState();
  lessonPlayback = data;
  lessonSectionIdx = 0;
  lessonQuizIdxInSection = 0;
  startLessonStudyForCurrentSection();
}

function lessonPrepareCurrentLessonQuizQuestion(): void {
  if (!lessonPlayback) {
    phase = "lesson_done";
    return;
  }
  const secs = lessonSectionsResolved();
  if (lessonSectionIdx >= secs.length) {
    phase = "lesson_done";
    return;
  }
  const sec = secs[lessonSectionIdx];
  if (lessonQuizIdxInSection >= sec.steps.length) {
    const nextSec = lessonSectionIdx + 1;
    if (nextSec >= secs.length) {
      phase = "lesson_done";
      return;
    }
    lessonSectionIdx = nextSec;
    startLessonStudyForCurrentSection();
    return;
  }
  let globalIdx = 0;
  for (let i = 0; i < lessonSectionIdx; i++) globalIdx += secs[i]?.steps.length ?? 0;
  globalIdx += lessonQuizIdxInSection;
  lessonQuizIdx = globalIdx;
  const step = sec.steps[lessonQuizIdxInSection];
  currentQuestionId = step.questionId;
  endsAt = nowSynced() + step.effectiveAnswerMs;
  lessonQuizLocked = false;
  lessonQuizRoundResolved = false;
}

function advanceLessonQuizAfterResolution(wasCorrect: boolean, selectedChoice: number | null): void {
  if (lessonQuizRoundResolved) return;
  lessonQuizRoundResolved = true;
  lessonQuizLocked = true;
  if (wasCorrect) lessonQuizCorrect++;
  if (currentQuestionId != null) {
    lessonRestChoiceByQuestionId.set(currentQuestionId, selectedChoice);
  }
  clearTimer();
  window.setTimeout(() => {
    lessonQuizIdxInSection += 1;
    lessonPrepareCurrentLessonQuizQuestion();
    const ae = document.activeElement;
    if (ae instanceof HTMLElement) ae.blur();
    render();
  }, 900);
}

function lessonRestReviewItems(): Array<{
  questionId: number;
  choiceIndex: number | null;
  correctIndex: number;
  prompt: string;
  options: string[];
  studyBody: string | null;
}> {
  if (!lessonPlayback) return [];
  return lessonPlayback.steps.map((step) => ({
    questionId: step.questionId,
    choiceIndex: lessonRestChoiceByQuestionId.has(step.questionId)
      ? (lessonRestChoiceByQuestionId.get(step.questionId) ?? null)
      : null,
    correctIndex: step.correctIndex,
    prompt: step.prompt,
    options: step.options,
    studyBody: step.studyBody,
  }));
}

async function openLessonById(id: number): Promise<void> {
  selectedLessonMatchId = id;
  lessonBrowseStep = "lesson_hub";
  lessonBrowseMsg = "جاري تحميل الدرس…";
  phase = "lesson_menu";
  render();
  try {
    const res = await fetch(`/api/lessons/${id}`, { cache: "no-store" });
    const data = (await res.json()) as { ok?: boolean; lesson?: LessonPlaybackPayload; error?: string };
    if (!res.ok || !data.ok || !data.lesson?.steps?.length) {
      lessonBrowseMsg = "تعذر تحميل الدرس أو لا يوجد محتوى منشور.";
      render();
      return;
    }
    lessonBrowseMsg = "";
    beginLessonPlayback(data.lesson);
    render();
  } catch {
    lessonBrowseMsg = "تعذر تحميل الدرس.";
    render();
  }
}

function startLessonQuizTimer(): void {
  clearTimer();
  const clock = app.querySelector<HTMLDivElement>("#lesson-quiz-clock");
  if (!clock) return;
  timerHandle = window.setInterval(() => {
    if (phase !== "lesson_quiz") return;
    const ms = endsAt - nowSynced();
    if (!lessonQuizRoundResolved && ms <= 0) {
      const opts = app.querySelector<HTMLDivElement>("#lesson-opts");
      const status = app.querySelector<HTMLParagraphElement>("#lesson-q-status");
      opts?.querySelectorAll("button").forEach((btn) => {
        const htmlBtn = btn as HTMLButtonElement;
        htmlBtn.disabled = true;
        htmlBtn.classList.add("option-btn--disabled");
      });
      if (status) status.textContent = "انتهى الوقت.";
      advanceLessonQuizAfterResolution(false, null);
      return;
    }
    const showMs = Math.max(0, ms);
    const sec = Math.max(0, Math.floor((showMs + 250) / 1000));
    clock.textContent = `${sec}s`;
  }, 200);
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

function showInsufficientAbilityTip(
  anchor: HTMLElement,
  currentKeys: number,
  abilityCost: number,
  abilityName: string,
): void {
  document.querySelectorAll(".ability-insufficient-tip").forEach((el) => el.remove());
  const tip = document.createElement("div");
  tip.className = "ability-insufficient-tip";
  tip.setAttribute("role", "status");
  const missingKeys = Math.max(1, Math.floor(abilityCost - currentKeys));
  const name = abilityName.trim() || "هذه القدرة";
  tip.textContent = `تحتاج إلى ${missingKeys} مفتاح إضافي لاستخدام ${name}`;
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
      showInsufficientAbilityTip(
        b1,
        myKeysCount(),
        abilityCostsState.skillBoost,
        b1.title || "تعزيز نقاط المهارة",
      );
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
      showInsufficientAbilityTip(
        s1,
        myKeysCount(),
        abilityCostsState.skipQuestion,
        s1.title || "تجاوز السؤال دون قلب أو نقاط",
      );
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
      showInsufficientAbilityTip(
        r1,
        myKeysCount(),
        abilityCostsState.reveal,
        r1.title || "كشف مفاتيح الجميع",
      );
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
      showInsufficientAbilityTip(
        a1,
        myKeysCount(),
        abilityCostsState.heartAttack,
        a1.title || "هجوم على قلب",
      );
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
          showInsufficientAbilityTip(
            a1,
            myKeysCount(),
            abilityCostsState.heartAttack,
            a1.title || "هجوم على قلب",
          );
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

function connectSocket(
  name: string,
  mode: GameMode,
  subcategoryKey?: string | null,
  difficultyMode: DifficultyMode = "mix",
  joinKind: JoinKind = "public",
  roomCode?: string,
  lessonIdForMatch?: number | null,
  customLessonTokenForMatch?: string | null,
): void {
  const playerSessionId = getOrCreatePlayerSessionId();
  const flowToken = ++searchFlowToken;
  const joinFlowStartMs = performance.now();
  socket?.removeAllListeners();
  socket?.disconnect();

  currentGameMode = mode;
  if (joinKind === "public" || joinKind === "solo") {
    isPrivateRoomSession = false;
    lastPrivateRoomCode = null;
  }

  const s = io({
    path: "/socket.io",
    transports: ["websocket", "polling"],
  });
  socket = s;
  let joinAckTimer: number | null = null;
  let joinCompleted = false;

  const failBackToName = (msg: string): void => {
    if (flowToken !== searchFlowToken) return;
    if (joinAckTimer) {
      window.clearTimeout(joinAckTimer);
      joinAckTimer = null;
    }
    joinCompleted = true;
    soloLearningPending = false;
    if (joinKind === "private_create" || joinKind === "private_join") {
      privateRoomCodeState = null;
      privateRoomHostSocketId = null;
      privateRoomInviteUrl = null;
      privateRoomVersionState = 0;
      privateQrDataUrl = null;
      privateReadyPending = false;
      isPrivateRoomSession = false;
    }
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
    if (noticeEl && (phase === "matchmaking" || phase === "private_room_lobby")) {
      noticeEl.textContent = joinKind === "solo"
        ? "تم الاتصال بالخادم. جاري تجهيز التعلم الفردي..."
        : joinKind === "private_create"
          ? "تم الاتصال بالخادم. جاري إنشاء الغرفة..."
          : joinKind === "private_join"
            ? "تم الاتصال بالخادم. جاري الانضمام للغرفة..."
            : "تم الاتصال بالخادم. جاري الدخول إلى البحث...";
    }
    joinAckTimer = window.setTimeout(() => {
      if (joinCompleted) return;
      failBackToName("تأخر الاتصال. تحقق من الشبكة ثم حاول مرة أخرى.");
      socket?.disconnect();
    }, 8000);
    const payload = {
      name,
      mode,
      ...(mode === "study_then_quiz" && subcategoryKey ? { subcategoryKey } : {}),
      ...(mode === "lesson" && customLessonTokenForMatch
        ? { customLessonToken: customLessonTokenForMatch }
        : mode === "lesson" && lessonIdForMatch != null && lessonIdForMatch > 0
          ? { lessonId: lessonIdForMatch }
          : {}),
      difficultyMode,
      ...(roomCode ? { roomCode } : {}),
      origin: window.location.origin,
      questionMs: privateRoomQuestionMs,
      studyPhaseMs: privateRoomStudyPhaseMs,
      playerSessionId,
    };
    const eventName =
      joinKind === "solo"
        ? "start_solo_match"
        : joinKind === "private_create"
          ? "create_private_room"
          : joinKind === "private_join"
            ? "join_private_room"
            : "join_lobby";
    s.emit(
      eventName,
      payload,
      (ack: {
        ok?: boolean;
        error?: string;
        message?: string;
        roomCode?: string;
        inviteUrl?: string;
        hostSocketId?: string;
        mode?: GameMode;
        subcategoryKey?: string | null;
        difficultyMode?: DifficultyMode;
        roomVersion?: number;
        roomSettings?: { questionMs?: number; studyPhaseMs?: number };
      }) => {
      if (flowToken !== searchFlowToken) return;
      if (joinAckTimer) {
        window.clearTimeout(joinAckTimer);
        joinAckTimer = null;
      }
      joinCompleted = true;
      if (!ack?.ok) {
        failBackToName(
          ack?.message
          || (joinKind === "solo"
            ? "تعذر بدء التعلم الفردي. حاول مرة أخرى."
            : joinKind === "private_create" || joinKind === "private_join"
              ? "تعذر الدخول إلى الغرفة الخاصة."
              : "تعذر الدخول. حاول مرة أخرى."),
        );
        return;
      }
      if (joinKind === "private_create" || joinKind === "private_join") {
        if (ack.roomCode) privateRoomCodeState = ack.roomCode;
        if (ack.inviteUrl) privateRoomInviteUrl = ack.inviteUrl;
        if (ack.hostSocketId) privateRoomHostSocketId = ack.hostSocketId;
        if (typeof ack.roomVersion === "number") privateRoomVersionState = ack.roomVersion;
        if (ack.roomSettings?.questionMs) privateRoomQuestionMs = ack.roomSettings.questionMs;
        if (ack.roomSettings?.studyPhaseMs) privateRoomStudyPhaseMs = ack.roomSettings.studyPhaseMs;
        if (ack.mode) currentGameMode = ack.mode;
        if (ack.subcategoryKey !== undefined) selectedSubcategoryKey = ack.subcategoryKey;
        if (ack.difficultyMode) selectedDifficultyMode = ack.difficultyMode;
        if (ack.roomCode) lastPrivateRoomCode = ack.roomCode;
        isPrivateRoomSession = true;
        if (privateRoomInviteUrl) {
          void ensurePrivateQrDataUrl(privateRoomInviteUrl);
        }
      }
      console.debug("[join-flow] connect->join_ack_ms", Math.round(performance.now() - joinFlowStartMs));
      if (phase !== "matchmaking" && phase !== "private_room_lobby") {
        phase = joinKind === "private_create" || joinKind === "private_join"
          ? "private_room_lobby"
          : "matchmaking";
        render();
      } else {
        const noticeEl2 = app.querySelector<HTMLParagraphElement>("#lobby-notice");
        if (noticeEl2) {
          noticeEl2.textContent = joinKind === "solo"
            ? "تم إنشاء الجولة الفردية. جاري البدء..."
            : joinKind === "private_create"
              ? "تم إنشاء الغرفة الخاصة بنجاح."
              : joinKind === "private_join"
                ? "تم الانضمام للغرفة الخاصة."
                : "تم الدخول بنجاح. جاري البحث عن منافسين...";
        }
      }
      },
    );
  });

  s.on("connect_error", () => {
    if (joinCompleted) return;
    failBackToName("تعذر الاتصال بالخادم. حاول مرة أخرى.");
  });

  s.on("disconnect", () => {
    updateConnectionBadge();
    const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
    if (noticeEl) noticeEl.textContent = "انقطع الاتصال مؤقتًا... جاري إعادة الاتصال";
  });

  s.on(
    "private_room_state",
    async (payload: {
      roomCode: string;
      hostSocketId: string;
      mode: GameMode;
      subcategoryKey: string | null;
      lessonId?: number | null;
      difficultyMode: DifficultyMode;
      roomVersion: number;
      players: Array<{ socketId: string; name: string; ready: boolean }>;
      isStarting: boolean;
      participantSocketIds: string[];
      countdownSecondsRemaining?: number;
      roomSettings: { questionMs: number; studyPhaseMs: number };
    }) => {
      if (payload.roomVersion < privateRoomVersionState) return;
      privateRoomVersionState = payload.roomVersion;
      privateRoomCodeState = payload.roomCode;
      privateRoomHostSocketId = payload.hostSocketId;
      currentGameMode = payload.mode;
      selectedSubcategoryKey = payload.subcategoryKey;
      if (payload.mode === "lesson" && payload.lessonId != null && payload.lessonId > 0) {
        selectedLessonMatchId = payload.lessonId;
      }
      selectedDifficultyMode = payload.difficultyMode;
      privateRoomQuestionMs = payload.roomSettings.questionMs;
      privateRoomStudyPhaseMs = payload.roomSettings.studyPhaseMs;
      lobbyPlayersList = payload.players;
      privateReadyPending = false;
      const inviteUrl = `${window.location.origin}?room=${payload.roomCode}`;
      privateRoomInviteUrl = inviteUrl;
      lastPrivateRoomCode = payload.roomCode;
      isPrivateRoomSession = true;
      await ensurePrivateQrDataUrl(inviteUrl);
      if (phase === "result") {
        return;
      }
      if (phase !== "countdown") {
        phase = "private_room_lobby";
      }
      if (
        payload.isStarting &&
        mySocketId &&
        payload.participantSocketIds.includes(mySocketId)
      ) {
        lobbyNotice = "جاري بدء الجولة...";
      }
      render();
    },
  );

  s.on(
    "lobby_state",
    (payload: {
      mode?: GameMode;
      players: { socketId: string; name: string; ready: boolean }[];
      isStarting?: boolean;
      participantSocketIds?: string[];
      maxPlayersPerMatch?: number;
      countdownSecondsRemaining?: number;
      isPrivate?: boolean;
      roomCode?: string;
      hostSocketId?: string;
      roomSettings?: {
        questionMs?: number;
        studyPhaseMs?: number;
      };
    }) => {
      if (phase !== "matchmaking" && phase !== "countdown" && phase !== "private_room_lobby") return;
      if (payload.isPrivate) return;
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
        (phase === "matchmaking" || phase === "private_room_lobby") &&
        payload.isStarting &&
        mySocketId &&
        participants.length > 0 &&
        isSelected
      ) {
        if (phase === "private_room_lobby" || Boolean(privateRoomCodeState)) {
          lobbyNotice = "جاري بدء الجولة...";
          lobbyPlayersList = payload.players;
          render();
          return;
        }
        lobbyNotice = "";
        lobbyPlayersList = payload.players;
        phase = "countdown";
        render();
        startCountdownTicks(
          Math.max(1, payload.countdownSecondsRemaining ?? DEFAULT_LOBBY_COUNTDOWN_SEC),
        );
      } else if (
        (phase === "matchmaking" || phase === "private_room_lobby") &&
        payload.isStarting &&
        mySocketId &&
        participants.length > 0 &&
        !isSelected
      ) {
        lobbyNotice = LOBBY_MSG_WAIT_NEXT;
      }

      lobbyPlayersList = payload.players;
      if (phase === "matchmaking" || phase === "private_room_lobby") {
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
      } else if (phase === "matchmaking" || phase === "private_room_lobby") {
        render();
      }
      return;
    }
    if (phase === "countdown") {
      startCountdownTicks(Math.max(1, payload.seconds));
      return;
    }
    if (phase === "private_room_lobby" || Boolean(privateRoomCodeState)) {
      lobbyNotice = "جاري بدء الجولة...";
      render();
      return;
    }
    if (phase !== "matchmaking" && phase !== "private_room_lobby") return;
    lobbyNotice = "";
    phase = "countdown";
    render();
    startCountdownTicks(Math.max(1, payload.seconds));
  });

  s.on("match_start_cancelled", (payload?: { reason?: string; message?: string }) => {
    if (cdInterval) {
      window.clearInterval(cdInterval);
      cdInterval = null;
    }
    if (phase === "countdown") {
      phase = "matchmaking";
    }
    lobbyNotice =
      payload?.reason === "not_enough_questions"
        ? payload.message || "لا توجد أسئلة كافية في مستوى الصعوبة هذا أو هذا التصنيف."
        : payload?.reason === "lesson_not_found" || payload?.reason === "lesson_invalid"
          ? payload?.message || "تعذر بدء مباراة الدرس."
          : LOBBY_MSG_CANCELLED;
    if (phase === "matchmaking" || phase === "private_room_lobby") render();
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
      soloLearningPending = false;
      privateRoomCodeState = null;
      privateRoomInviteUrl = null;
      applyAbilityCostsPayload(payload.abilityCosts ?? null);
      refreshKeysBadge();
      refreshAbilityAffordability();
      spectatorEligible = false;
      spectatorFollowing = false;
      if (payload.gameMode === "study_then_quiz" || payload.gameMode === "lesson") {
        phase = "studying";
        studyCards = [];
        studyEndsAt = nowSynced();
        studyStartsAt = studyEndsAt;
        studyDurationMs = 0;
        readyBtnState = "idle";
        studyPhaseState = "idle";
        activeStudyRoundToken = null;
        activeStudyMacroRound = 0;
        lessonMatchStudyNav = false;
        lessonMatchStudyCardIndex = 0;
        lessonMatchSectionMeta = { index: 0, count: 0, title: null };
        matchLessonReviewItems = null;
        matchLessonReviewIndex = 0;
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
      render();
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
      lessonSectionIndex?: number;
      lessonSectionCount?: number;
      lessonSectionTitle?: string | null;
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
      const isLessonStudy = payload.scope === "lesson";
      lessonMatchStudyNav = isLessonStudy && studyCards.length > 0;
      if (isLessonStudy) {
        readyBtnState = "idle";
        if (
          typeof payload.lessonSectionIndex === "number" &&
          typeof payload.lessonSectionCount === "number"
        ) {
          lessonMatchSectionMeta = {
            index: payload.lessonSectionIndex,
            count: payload.lessonSectionCount,
            title: payload.lessonSectionTitle ?? null,
          };
        } else {
          lessonMatchSectionMeta = { index: 0, count: 0, title: null };
        }
        lessonMatchStudyCardIndex = 0;
        render();
        startStudyTimer();
        return;
      }
      lessonMatchSectionMeta = { index: 0, count: 0, title: null };
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
      lessonMatchStudyNav = false;
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
      const prevFocusOpts = document.activeElement;
      if (prevFocusOpts instanceof HTMLElement && opts.contains(prevFocusOpts)) prevFocusOpts.blur();
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
      lessonReview?: Array<{
        questionId: number;
        choiceIndex: number | null;
        correctIndex: number;
        prompt: string;
        options: string[];
        studyBody: string | null;
      }>;
    }) => {
      if (cdInterval) {
        window.clearInterval(cdInterval);
        cdInterval = null;
      }
      clearTimer();
      const lr = payload.lessonReview;
      matchLessonReviewItems =
        Array.isArray(lr) && lr.length > 0
          ? (lr as NonNullable<typeof matchLessonReviewItems>)
          : null;
      matchLessonReviewIndex = 0;
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
        matchLessonReviewItems = null;
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

function connectSoloSocket(
  name: string,
  mode: GameMode,
  subcategoryKey?: string | null,
  difficultyMode: DifficultyMode = "mix",
  lessonIdForMatch?: number | null,
): void {
  connectSocket(name, mode, subcategoryKey, difficultyMode, "solo", undefined, lessonIdForMatch);
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

pendingJoinRoomCode = getRoomCodeFromUrl() ?? "";
if (pendingJoinRoomCode) {
  nameFlowStep = "mode";
  privateEntryAutoJoinTried = false;
}
const FAHEM_ADMIN_LESSON_PREVIEW_KEY = "fahem_admin_lesson_preview_v1";
const bootParams = new URLSearchParams(window.location.search);
const lessonIdFromUrl = Number(bootParams.get("lesson") ?? "");
const lessonPreviewBoot = bootParams.get("lessonPreview");
if (lessonPreviewBoot === "1") {
  const raw = sessionStorage.getItem(FAHEM_ADMIN_LESSON_PREVIEW_KEY);
  if (raw) {
    try {
      sessionStorage.removeItem(FAHEM_ADMIN_LESSON_PREVIEW_KEY);
      const payload = JSON.parse(raw) as LessonPlaybackPayload;
      if (payload && typeof payload === "object" && Array.isArray(payload.steps) && payload.steps.length > 0) {
        beginLessonPlayback(payload);
        history.replaceState({}, "", window.location.pathname + window.location.hash);
        render();
      } else {
        render();
      }
    } catch {
      render();
    }
  } else {
    render();
  }
} else if (Number.isInteger(lessonIdFromUrl) && lessonIdFromUrl > 0) {
  void openLessonById(lessonIdFromUrl);
} else {
  render();
}
startReleaseVersionWatch();
