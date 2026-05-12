import type { NameFlowStep, Phase } from "./types";
import type { SavedLessonSummary } from "./savedLessonsApi";

// ── Group A: Constants & Config ──────────────────────────────────────────────

export const DEFAULT_RESULT_MESSAGES = {
  winnerTitle: "فزت!",
  loserTitle: "لقد خسرت يا فاشل",
  tieTitle: "تعادل كامل",
  winner: "أحسنت — بقيت حتى النهاية.",
  loser: "انتهت الجولة لصالح لاعب آخر.",
  tie: "تعادل أو لا فائز — حاول مرة أخرى!",
} as const;

export const PLAYER_SESSION_STORAGE_KEY = "fahem.playerSessionId";
export const RELEASE_VERSION_QUERY_KEY = "v";
export const RELEASE_WATCH_FOREGROUND_INTERVAL_MS = 30_000;
export const RELEASE_WATCH_FOREGROUND_MAX_MS = 60_000;
export const RELEASE_WATCH_BACKGROUND_INTERVAL_MS = 3 * 60_000;
export const RELEASE_WATCH_BACKGROUND_MAX_MS = 5 * 60_000;
export const RELEASE_WATCH_MAX_FAILURE_BACKOFF_STEP = 4;

export const RESULT_VIDEO_SRC = {
  win: "/videos/win.mp4",
  lose: "/videos/lose.mp4",
  tie: "/videos/tie.mp4",
} as const;

export const CLIENT_RECONNECT_GRACE_MS = 20_000;

export const LOBBY_MSG_WAIT_NEXT =
  "مباراة جارية الآن بين مجموعة أخرى. أنت في قائمة انتظار الجولة التالية.";
export const LOBBY_MSG_CANCELLED =
  "تم إلغاء بدء المباراة — لا يوجد الآن عدد كافٍ من اللاعبين الجاهزين.";

export const LESSON_BROWSE_UNCATEGORIZED = -1;

export const FAHEM_MATCH_RESUME_KEY = "fahem_match_resume_v1";
export const FAHEM_ADMIN_LESSON_PREVIEW_KEY = "fahem_admin_lesson_preview_v1";

// ── Group B: Navigation & UI Shell ───────────────────────────────────────────

export const NavState = {
  phase: "name" as Phase,
  nameFlowStep: "mode" as NameFlowStep,
  searchFlowToken: 0,
  lobbyNotice: "",
};

// ── Group C: Release Watch ────────────────────────────────────────────────────

export const ReleaseWatchState = {
  handle: null as number | null,
  lastKnownVersion: null as string | null,
  lastKnownEtag: null as string | null,
  inFlight: false,
  failureCount: 0,
  deferredVersion: null as string | null,
  deferredReason: null as string | null,
  metrics: {
    totalChecks: 0,
    successChecks: 0,
    failedChecks: 0,
    notModifiedChecks: 0,
    deferredRefreshes: 0,
    immediateRefreshes: 0,
    socketRefreshSignals: 0,
  },
};

// ── Group D: Saved Lessons ────────────────────────────────────────────────────

export const SavedLessonsState = {
  rows: [] as SavedLessonSummary[],
  loading: false,
  libraryErr: "",
  editingId: null as string | null,
  libraryIcon: null as string | null,
  detailId: null as string | null,
  editorPayload: null as Record<string, unknown> | null,
  editorErr: "",
  editorMsg: "",
};
