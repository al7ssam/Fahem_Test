import { el } from "../utils";
import type { Phase, NameFlowStep, GameMode } from "../types";
import type { Socket } from "socket.io-client";
import type { ReviewItem } from "../../shared/reviewItem";

export type ResultScreenDeps = {
  isPrivateRoomSession: () => boolean;
  getLastPrivateRoomCode: () => string | null;
  getMatchLessonReviewItems: () => ReviewItem[] | null;
  getGameMode: () => GameMode | null;
  getMyParticipantId: () => string | null;
  getPlayerNameDraft: () => string;
  getEffectivePlayerName: (draft: string) => string;
  /** عند true يبقى زر النتيجة يعيد ضبطًا كاملاً (حالات خطأ/فارغة). */
  shouldAgainButtonUseFullReset: () => boolean;
  /** جولة جديدة بنفس إعدادات اللوبي/الفردي دون العودة لشاشة الاسم. */
  retryPublicMatchFromResult: () => void;
  // "Play Again" — resets all match/room state
  resetAllForReplay: () => void;
  // "Back to private room"
  backToPrivateRoom: (roomCode: string, name: string) => void;
  // "Go home"
  returnToHomeFromSearch: () => void;
  // Spectator
  getSocket: () => Socket | null;
  applyMatchStateSnapshotFromServer: (s: Socket, snap: Record<string, unknown>) => void;
  // Navigation
  setPhase: (p: Phase) => void;
  setMatchLessonReviewIndex: (v: number) => void;
  render: () => void;
};

export function renderResultScreen(deps: ResultScreenDeps): void {
  const showPrivateRoomActions = deps.isPrivateRoomSession() && Boolean(deps.getLastPrivateRoomCode());
  const mlItems = deps.getMatchLessonReviewItems();
  const app = document.querySelector<HTMLDivElement>("#app")!;
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
        <div id="res-team-extra" class="w-full text-right hidden"></div>
        <div id="res-stats" class="result-screen__stats hidden"></div>
        <button id="match-lesson-review-open" type="button" class="result-screen__again ui-btn ui-btn--primary w-full py-3 text-base ${
          mlItems && mlItems.length > 0 ? "" : "hidden"
        }">${deps.getGameMode() === "lesson" ? "مراجعة الدرس" : "مراجعة الأسئلة"}</button>
        <div class="${showPrivateRoomActions ? "w-full flex flex-col sm:flex-row gap-3" : "hidden"}">
          <button id="back-private-room" type="button" class="result-screen__again ui-btn ui-btn--cta w-full py-3 text-base">العودة للغرفة الخاصة</button>
          <button id="go-home-from-result" type="button" class="result-screen__again ui-btn ui-btn--ghost w-full py-3 text-base">الصفحة الرئيسية</button>
        </div>
        <button id="again" type="button" class="result-screen__again ui-btn ui-btn--primary w-full py-3 text-lg ${showPrivateRoomActions ? "hidden" : ""}">العب مجدداً</button>
      </div>
    `),
  );
  const continueWatchBtn = app.querySelector<HTMLButtonElement>("#continue-watch");
  if (continueWatchBtn) {
    continueWatchBtn.addEventListener("click", () => {
      deps.getSocket()?.emit(
        "continue_as_spectator",
        { participantId: deps.getMyParticipantId() ?? undefined },
        (ack: { ok?: boolean; snapshot?: Record<string, unknown> | null }) => {
          if (ack?.ok && ack.snapshot) {
            const s = deps.getSocket();
            if (s) deps.applyMatchStateSnapshotFromServer(s, ack.snapshot as Record<string, unknown>);
          }
        },
      );
    });
  }
  app.querySelector("#match-lesson-review-open")?.addEventListener("click", () => {
    if (!mlItems?.length) return;
    deps.setMatchLessonReviewIndex(0);
    deps.setPhase("match_lesson_review");
    deps.render();
  });
  const againBtn = app.querySelector<HTMLButtonElement>("#again")!;
  againBtn.addEventListener("click", () => {
    if (deps.shouldAgainButtonUseFullReset()) {
      deps.resetAllForReplay();
    } else {
      deps.retryPublicMatchFromResult();
    }
    deps.render();
  });
  const backPrivateRoomBtn = app.querySelector<HTMLButtonElement>("#back-private-room");
  backPrivateRoomBtn?.addEventListener("click", () => {
    const roomCode = deps.getLastPrivateRoomCode();
    if (!roomCode) return;
    const name = deps.getEffectivePlayerName(deps.getPlayerNameDraft());
    deps.backToPrivateRoom(roomCode, name);
  });
  app.querySelector<HTMLButtonElement>("#go-home-from-result")?.addEventListener("click", () => {
    deps.returnToHomeFromSearch();
  });
}
