import "./style.css";
import type { Socket } from "socket.io-client";
import { toDataURL as qrToDataURL } from "qrcode";
import {
  buildCustomLessonAiPromptText,
  clampCustomLessonFlowParams,
  CUSTOM_LESSON_FLOW_MAX_NSEC,
  CUSTOM_LESSON_FLOW_MAX_QSAME,
  DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS,
  DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
  type LessonAiPromptParams,
  type BuildLessonAiPromptOptions,
} from "./lessonPromptBuilder";
import { parseLessonPastedJson } from "@shared/lessonJsonParse";
import type { ReviewItem } from "../../shared/reviewItem";
import { loadCustomLessonDraft, saveCustomLessonDraft } from "./customLessonDraft";
import {
  hasLocalCustomLessonPromptPrefs,
  loadCustomLessonPromptPrefs,
  mergeUserPromptParamsWithSiteDefaults,
  saveCustomLessonPromptPrefs,
} from "./customLessonPromptPrefs";
import { fetchMeCustomLessonPromptParams, putMeCustomLessonPromptParams } from "./customLessonPromptPrefsApi";
import { openChatGptExternal, openGeminiExternal } from "./openExternalAiApp";
import { createAuthedSocket } from "./auth/socketFactory";
import { attachServerDrainingListener } from "./realtime/socketBindings";
import { createLobbyCountdownController } from "./realtime/lobbyCountdown";
import { tryResumeMatchAfterConnect } from "./realtime/resumeMatchAfterConnect";
import {
  applyMatchStateSnapshotFromServer as applyMatchStateSnapshotFromServerWithDeps,
  type SnapshotApplyDeps,
} from "./realtime/snapshotApply";
import { attachGameplaySocketListeners, type GameplaySocketDeps } from "./realtime/gameplaySocketListeners";
import { applyPrivateRoomStateFromPayload, type PrivateRoomStateApplyDeps } from "./realtime/privateRoomStateApply";
import type {
  PrivateRoomStateClientPayload,
  PrivateTeamLobbyTeamPayload,
} from "./realtime/privateRoomFlow";
import { renderCountdownScreen } from "./screens/CountdownScreen";
import { renderLessonDoneScreen } from "./screens/LessonDoneScreen";
import { renderLessonReviewScreen } from "./screens/LessonReviewScreen";
import { renderMatchLessonReviewScreen } from "./screens/MatchLessonReviewScreen";
import { renderResultScreen } from "./screens/ResultScreen";
import { renderSavedLessonsLibraryScreen } from "./screens/SavedLessonsLibraryScreen";
import { renderSavedLessonEditScreen } from "./screens/SavedLessonEditScreen";
import {
  cleanupEmailLinkLandingUrl,
  completeGoogleRedirectLogin,
  getAuthWelcomeLine,
} from "./auth/authFlows";
import { readPasswordResetModeFromUrl } from "./auth/emailLinkUrl";
import { getAuthState, subscribeAuthState } from "./auth/authStore";
import { getFirebaseAuth } from "./auth/firebaseClient";
import { hydrateAuthSession } from "./auth/sessionSync";
import { attachSocketAuthSync } from "./auth/socketSync";
import { getAuthTokens } from "./auth/authClient";
import { openAuthModal } from "./auth/authUi";
import {
  deleteSavedLesson,
  fetchSavedLessonDetail,
  fetchSavedLessonsList,
  patchSavedLesson,
  postSavedLesson,
  type SavedLessonSummary,
} from "./savedLessonsApi";
import {
  collectSavedLessonPayloadFromEditor,
  readLibraryIconFromEditor,
  removeQuestionFromPayload,
  removeSectionFromPayload,
  renderSavedLessonEditorMarkup,
} from "./savedLessonEditor";
import {
  getEffectivePlayerName,
  getStoredPlayerName,
  storePlayerName,
} from "./playerDisplayName";

// ── Extracted foundations (Phase 1) ──────────────────────────────────────────
import type {
  GameMode, DifficultyMode, Phase, NameFlowStep, JoinKind,
  LessonPlaybackSection, LessonPlaybackPayload,
  ResultScreenKind, ResumePolicy,
  AbilityCostsPayload, AbilityTogglesPayload, IncomingQuestionPayload,
} from "./types";
import { escapeHtml, el } from "./utils";
import {
  DEFAULT_RESULT_MESSAGES, PLAYER_SESSION_STORAGE_KEY,
  RELEASE_VERSION_QUERY_KEY, RELEASE_WATCH_FOREGROUND_INTERVAL_MS,
  RELEASE_WATCH_FOREGROUND_MAX_MS, RELEASE_WATCH_BACKGROUND_INTERVAL_MS,
  RELEASE_WATCH_BACKGROUND_MAX_MS, RELEASE_WATCH_MAX_FAILURE_BACKOFF_STEP,
  RESULT_VIDEO_SRC, CLIENT_RECONNECT_GRACE_MS,
  LOBBY_MSG_WAIT_NEXT, LOBBY_MSG_CANCELLED,
  LESSON_BROWSE_UNCATEGORIZED, FAHEM_MATCH_RESUME_KEY,
  FAHEM_ADMIN_LESSON_PREVIEW_KEY,
  NavState, ReleaseWatchState, SavedLessonsState,
} from "./state";

const app = document.querySelector<HTMLDivElement>("#app")!;

let socket: Socket | null = null;
let phase: Phase = "name";
let nameFlowStep: NameFlowStep = "mode";
/** معرّف المقعد داخل المباراة/اللوبي (ثابت أثناء الجلسة؛ مستقبلًا يُعاد ربطه بمقبس جديد عند reconnect) */
let myParticipantId: string | null = null;
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
/** آخر نوع انضمام عبر المقبس — لإعادة المحاولة من شاشة النتيجة. */
let lastSocketJoinKind: JoinKind = "public";
/** عند true يعيد زر النتيجة ضبطًا كاملاً بدل إعادة الجولة بنفس الإعدادات. */
let resultScreenAgainIsFullReset = false;
let soloLearningPending = false;
let privateRoomCodeState: string | null = null;
let privateRoomHostParticipantId: string | null = null;
let privateRoomInviteUrl: string | null = null;
let privateRoomQuestionMs = 15_000;
let privateRoomStudyPhaseMs = 60_000;
/** درس مباراة Socket: معرّف الدرس المختار من شاشة الاسم */
let selectedLessonMatchId: number | null = null;
/** واجهة بطاقة واحدة (تالي/سابق) لمراجعة الدرس في المباراة */
let lessonMatchStudyNav = false;
let lessonMatchStudyCardIndex = 0;
let lessonMatchSectionMeta = { index: 0, count: 0, title: null as string | null };
let matchLessonReviewItems: ReviewItem[] | null = null;
let matchLessonReviewIndex = 0;
let pendingJoinRoomCode = "";
let privateRoomVersionState = 0;
/** وضع الفرق في لوبي الغرفة الخاصة (من الخادم). */
let privateRoomTeamPlayModeState: "individual" | "teams_first_answer" | "teams_captain_approval" =
  "individual";
let privateRoomHeartsPerPlayerState = 3;
let privateRoomTeamsLobbyState: {
  desiredTeamCount: number;
  teamsLocked: boolean;
  teams: PrivateTeamLobbyTeamPayload[];
} | null = null;
let privateRoomUnassignedIds: string[] = [];
/** وضع الفرق أثناء المباراة الحالية (null = فردي/لوبي عام). */
let matchTeamPlayMode: "individual" | "teams_first_answer" | "teams_captain_approval" | null = null;
/** إعداد القلوب من غرفة خاصة (0–5) كما أرسله الخادم مع game_started؛ null = لوبي عام (عرض 3 خانات). */
let matchHeartsPerPlayerSetting: number | null = null;
/** تخزين/قبول رموز استئناف النقل فقط أثناء مباراة متعددة اللاعبين على الخادم (غرفة خاصة أو ≥2 لاعب). */
let reconnectRuntimeActive = false;
/** أثناء محاولة resume الصريحة نسمح بقبول token حتى قبل game_started. */
let reconnectAttemptInFlight = false;
/** Prompt reconnect الصريح عند الإقلاع. */
let reconnectPromptState: {
  matchId: string;
  participantId: string;
  expiresAt: number;
} | null = null;
let teamRoundUiLocked = false;
let teamRoundCaptainSubmitted = false;
let captainTapPendingIndex: number | null = null;
/** عدد الأصوات لكل خيار (وضع كابتن) لعرض حي على الأزرار. */
let teamVoteCountsByChoice: Record<number, number> = {};
let privateReadyPending = false;
let privateReadyTargetState: boolean | null = null;
let privateQrDataUrl: string | null = null;
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
let lobbyPlayersList: Array<{
  participantId?: string;
  userId?: string | null;
  name: string;
  ready: boolean;
}> = [];
let currentMatchPlayers: Array<{
  participantId?: string;
  userId?: string | null;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator?: boolean;
  skillPoints?: number;
  lastAward?: number;
  keys?: number;
  skillBoostStacks?: number;
  teamId?: string | null;
  isCaptain?: boolean;
  /** نتيجة آخر جولة معروضة في اللوحة (من question_result) */
  lastRoundResult?: "skipped" | "correct" | "wrong";
}> = [];

function accountUserId(): string | null {
  return getAuthState().user?.id ?? null;
}

function playerIsMe(p: { participantId?: string; userId?: string | null }): boolean {
  if (myParticipantId && p.participantId) return p.participantId === myParticipantId;
  const uid = accountUserId();
  if (uid && p.userId) return p.userId === uid;
  return false;
}

function syncMyParticipantIdFromPlayers(
  players: Array<{ participantId?: string; userId?: string | null }>,
): void {
  if (myParticipantId && players.some((p) => p.participantId === myParticipantId)) {
    return;
  }
  const uid = accountUserId();
  if (uid) {
    const me = players.find((p) => p.userId === uid);
    myParticipantId = me?.participantId ?? null;
    return;
  }
  if (players.length === 1 && players[0]?.participantId) {
    myParticipantId = players[0].participantId;
    return;
  }
  if (myParticipantId && !players.some((p) => p.participantId === myParticipantId)) {
    myParticipantId = null;
  }
}

function isPrivateRoomHost(): boolean {
  return Boolean(privateRoomHostParticipantId && myParticipantId && privateRoomHostParticipantId === myParticipantId);
}

function participantDisplayName(participantId: string): string {
  const row = lobbyPlayersList.find((p) => p.participantId === participantId);
  return row?.name?.trim() ? row.name : participantId.slice(0, 8);
}

function resetPrivateRoomTeamLobbyClientState(): void {
  privateRoomTeamPlayModeState = "individual";
  privateRoomHeartsPerPlayerState = 3;
  privateRoomTeamsLobbyState = null;
  privateRoomUnassignedIds = [];
}

function renderPrivateRoomTeamsSection(): void {
  const root = app.querySelector<HTMLDivElement>("#private-teams-root");
  if (!root) return;

  const host = isPrivateRoomHost();
  const tls = privateRoomTeamsLobbyState;
  const teamModeActive =
    privateRoomTeamPlayModeState !== "individual" && tls != null;
  const locked = Boolean(tls?.teamsLocked);

  const modeLabel =
    privateRoomTeamPlayModeState === "individual"
      ? "فردي"
      : privateRoomTeamPlayModeState === "teams_first_answer"
        ? "أول إجابة في الفريق"
        : "تصويت + موافقة الكابتن (نقرتان للكابتن)";

  /** يظهر دائماً للمضيف حتى في «فردي» حتى يمكن التبديل إلى وضع الفرق (بدون حلقة مفرغة). */
  const hostBaseAdminHtml = host
    ? `<div class="rounded-lg border border-white/10 p-3 space-y-2 bg-white/5 text-right">
        <p class="text-xs text-slate-400 m-0">إعدادات المضيف — ${escapeHtml(modeLabel)}</p>
        <div class="flex flex-wrap gap-2 items-center justify-end">
          <label class="text-xs text-slate-400">وضع اللعب</label>
          <select id="private-admin-play-mode" class="app-input px-2 py-1 text-sm">
            <option value="individual" ${privateRoomTeamPlayModeState === "individual" ? "selected" : ""}>فردي</option>
            <option value="teams_first_answer" ${privateRoomTeamPlayModeState === "teams_first_answer" ? "selected" : ""}>فرق — أول إجابة</option>
            <option value="teams_captain_approval" ${privateRoomTeamPlayModeState === "teams_captain_approval" ? "selected" : ""}>فرق — الكابتن</option>
          </select>
          <button type="button" id="private-admin-apply-mode" class="ui-btn ui-btn--ghost py-1 px-2 text-xs">تطبيق</button>
        </div>
        <div class="flex flex-wrap gap-2 items-center justify-end">
          <label class="text-xs text-slate-400">القلوب (0 = معطّل)</label>
          <select id="private-admin-hearts" class="app-input px-2 py-1 text-sm">
            ${[0, 1, 2, 3, 4, 5]
              .map(
                (h) =>
                  `<option value="${h}" ${privateRoomHeartsPerPlayerState === h ? "selected" : ""}>${h}</option>`,
              )
              .join("")}
          </select>
          <button type="button" id="private-admin-apply-hearts" class="ui-btn ui-btn--ghost py-1 px-2 text-xs">تطبيق</button>
        </div>
      </div>`
    : "";

  const hostTeamManagementHtml =
    host && teamModeActive && tls
      ? `<div class="rounded-lg border border-white/10 p-3 space-y-2 bg-white/5 text-right mt-2">
        <p class="text-xs text-slate-500 m-0">إدارة الفرق</p>
        <div class="flex flex-wrap gap-2 items-center justify-end">
          <label class="text-xs text-slate-400">عدد الفرق</label>
          <input id="private-admin-team-count" type="number" min="2" max="12" class="app-input w-20 px-2 py-1 text-sm text-center" value="${tls.desiredTeamCount}" />
          <button type="button" id="private-admin-apply-team-count" class="ui-btn ui-btn--ghost py-1 px-2 text-xs">تطبيق</button>
          <button type="button" id="private-admin-add-team" class="ui-btn ui-btn--ghost py-1 px-2 text-xs">+ فريق</button>
          <button type="button" id="private-admin-shuffle" class="ui-btn ui-btn--ghost py-1 px-2 text-xs">خلط</button>
        </div>
        <div class="flex flex-wrap gap-2 items-center justify-end">
          <button type="button" id="private-admin-lock-teams" class="ui-btn ui-btn--primary py-1 px-2 text-xs">${locked ? "إلغاء قفل الفرق" : "قفل الفرق"}</button>
        </div>
      </div>`
      : "";

  const guestModeHint =
    !host && privateRoomTeamPlayModeState === "individual"
      ? ""
      : !host
        ? `<p class="text-xs text-slate-400 text-right m-0 mt-2">${escapeHtml(modeLabel)} · القلوب لكل لاعب: ${privateRoomHeartsPerPlayerState}</p>`
        : "";

  const unassignedHtml =
    teamModeActive && privateRoomUnassignedIds.length > 0
      ? `<p class="text-amber-200/90 text-xs m-0 mt-2">لم يُعيَّن بعد: ${privateRoomUnassignedIds
          .map((id) => escapeHtml(participantDisplayName(id)))
          .join("، ")}</p>`
      : "";

  const cards =
    teamModeActive && tls
      ? tls.teams
          .map((t) => {
            const members = t.memberParticipantIds
              .map((pid) => {
                const isCap = pid === t.captainParticipantId;
                const isMe = myParticipantId === pid;
                return `<li class="text-xs ${isMe ? "text-amber-200" : "text-slate-200"}">${escapeHtml(participantDisplayName(pid))}${isCap ? " · كابتن" : ""}${isMe ? " (أنت)" : ""}</li>`;
              })
              .join("");
            const myTeam = myParticipantId && t.memberParticipantIds.includes(myParticipantId);
            const imCaptain = myParticipantId === t.captainParticipantId;
            const joinBtn =
              !locked && !myTeam
                ? `<button type="button" class="ui-btn ui-btn--cta py-1 px-2 text-xs mt-2" data-join-team="${escapeHtml(t.teamId)}">انضمام</button>`
                : "";
            const leaveBtn =
              !locked && myTeam
                ? `<button type="button" class="ui-btn ui-btn--ghost py-1 px-2 text-xs mt-2" data-leave-team="1">مغادرة الفريق</button>`
                : "";
            const nameRow = imCaptain
              ? `<div class="flex gap-1 mt-1"><input type="text" maxlength="48" class="app-input flex-1 px-2 py-1 text-xs" data-team-name-input="${escapeHtml(t.teamId)}" value="${escapeHtml(t.displayName)}" /><button type="button" class="ui-btn ui-btn--ghost py-1 px-2 text-xs" data-save-team-name="${escapeHtml(t.teamId)}">حفظ الاسم</button></div>`
              : `<p class="text-sm font-semibold text-amber-100/95 m-0">${escapeHtml(t.displayName)}</p>`;
            const captainPick =
              host && t.memberParticipantIds.length > 0
                ? `<div class="mt-1 flex flex-wrap gap-1 items-center justify-end">
              <span class="text-[10px] text-slate-400">كابتن:</span>
              <select class="app-input px-1 py-0.5 text-[10px]" data-captain-select="${escapeHtml(t.teamId)}">
                ${t.memberParticipantIds
                  .map(
                    (pid) =>
                      `<option value="${escapeHtml(pid)}" ${pid === t.captainParticipantId ? "selected" : ""}>${escapeHtml(participantDisplayName(pid))}</option>`,
                  )
                  .join("")}
              </select>
              <button type="button" class="ui-btn ui-btn--ghost py-0.5 px-1 text-[10px]" data-apply-captain="${escapeHtml(t.teamId)}">تعيين</button>
            </div>`
                : "";
            const removeEmpty =
              host && t.memberParticipantIds.length === 0 && tls.teams.length > 2
                ? `<button type="button" class="ui-btn ui-btn--ghost py-0.5 px-1 text-[10px] mt-1" data-remove-team="${escapeHtml(t.teamId)}">حذف فريق فارغ</button>`
                : "";
            return `<div class="rounded-lg border border-amber-500/20 p-3 bg-slate-900/40 text-right" data-team-card="${escapeHtml(t.teamId)}">
        ${nameRow}
        <ul class="list-none m-0 mt-2 p-0 space-y-1">${members || '<li class="text-xs text-slate-500">لا أعضاء بعد</li>'}</ul>
        ${captainPick}
        <div class="flex flex-wrap gap-2 justify-end">${joinBtn}${leaveBtn}</div>
        ${removeEmpty}
      </div>`;
          })
          .join("")
      : "";

  const teamsGridHtml = cards
    ? `<div class="grid gap-2 sm:grid-cols-2 mt-2">${cards}</div>`
    : "";

  root.innerHTML = `<div class="space-y-3 mt-2">${hostBaseAdminHtml}${hostTeamManagementHtml}${guestModeHint}${unassignedHtml}${teamsGridHtml}</div>`;

  root.querySelector("#private-admin-apply-mode")?.addEventListener("click", () => {
    const sel = root.querySelector<HTMLSelectElement>("#private-admin-play-mode");
    const v = sel?.value;
    if (!v) return;
    socket?.emit("private_room_admin_set_play_mode", { playMode: v }, (ack?: { ok?: boolean }) => {
      if (!ack?.ok) lobbyNotice = "تعذر تغيير وضع اللعب.";
      render();
    });
  });
  root.querySelector("#private-admin-apply-hearts")?.addEventListener("click", () => {
    const sel = root.querySelector<HTMLSelectElement>("#private-admin-hearts");
    const h = Number(sel?.value ?? "3");
    socket?.emit("private_room_admin_set_hearts", { heartsPerPlayer: h }, (ack?: { ok?: boolean }) => {
      if (!ack?.ok) lobbyNotice = "تعذر تغيير القلوب.";
      render();
    });
  });
  root.querySelector("#private-admin-apply-team-count")?.addEventListener("click", () => {
    const inp = root.querySelector<HTMLInputElement>("#private-admin-team-count");
    const n = Number(inp?.value ?? "2");
    socket?.emit("private_room_admin_set_desired_team_count", { desiredTeamCount: n }, (ack?: { ok?: boolean; message?: string }) => {
      if (!ack?.ok) lobbyNotice = ack?.message || "تعذر تغيير عدد الفرق.";
      render();
    });
  });
  root.querySelector("#private-admin-add-team")?.addEventListener("click", () => {
    socket?.emit("private_room_admin_add_team", {}, (ack?: { ok?: boolean }) => {
      if (!ack?.ok) lobbyNotice = "تعذر إضافة فريق.";
      render();
    });
  });
  root.querySelector("#private-admin-shuffle")?.addEventListener("click", () => {
    socket?.emit("private_room_admin_shuffle_teams", {}, (ack?: { ok?: boolean }) => {
      if (!ack?.ok) lobbyNotice = "تعذر خلط الفرق.";
      render();
    });
  });
  root.querySelector("#private-admin-lock-teams")?.addEventListener("click", () => {
    socket?.emit("private_room_admin_lock_teams", { locked: !locked }, (ack?: { ok?: boolean }) => {
      if (!ack?.ok) lobbyNotice = "تعذر قفل/فتح الفرق.";
      render();
    });
  });
  root.querySelectorAll("[data-join-team]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const teamId = (btn as HTMLButtonElement).dataset.joinTeam;
      if (!teamId) return;
      socket?.emit("private_room_join_team", { teamId }, (ack?: { ok?: boolean }) => {
        if (!ack?.ok) lobbyNotice = "تعذر الانضمام للفريق.";
        render();
      });
    });
  });
  root.querySelectorAll("[data-leave-team]").forEach((btn) => {
    btn.addEventListener("click", () => {
      socket?.emit("private_room_leave_team", {}, (ack?: { ok?: boolean }) => {
        if (!ack?.ok) lobbyNotice = "تعذر مغادرة الفريق.";
        render();
      });
    });
  });
  root.querySelectorAll("[data-save-team-name]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tid = (btn as HTMLButtonElement).dataset.saveTeamName;
      if (!tid) return;
      const inp = root.querySelector<HTMLInputElement>(`[data-team-name-input="${tid}"]`);
      const displayName = inp?.value?.trim() ?? "";
      if (!displayName) return;
      socket?.emit("private_room_update_team_name", { teamId: tid, displayName }, (ack?: { ok?: boolean }) => {
        if (!ack?.ok) lobbyNotice = "تعذر حفظ اسم الفريق.";
        render();
      });
    });
  });
  root.querySelectorAll("[data-apply-captain]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tid = (btn as HTMLButtonElement).dataset.applyCaptain;
      if (!tid) return;
      const sel = root.querySelector<HTMLSelectElement>(`[data-captain-select="${tid}"]`);
      const captainParticipantId = sel?.value;
      if (!captainParticipantId) return;
      socket?.emit(
        "private_room_admin_set_captain",
        { teamId: tid, captainParticipantId },
        (ack?: { ok?: boolean }) => {
          if (!ack?.ok) lobbyNotice = "تعذر تعيين الكابتن.";
          render();
        },
      );
    });
  });
  root.querySelectorAll("[data-remove-team]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const teamId = (btn as HTMLButtonElement).dataset.removeTeam;
      if (!teamId) return;
      socket?.emit("private_room_admin_remove_team", { teamId }, (ack?: { ok?: boolean; message?: string }) => {
        if (!ack?.ok) lobbyNotice = ack?.message || "تعذر حذف الفريق.";
        render();
      });
    });
  });
}

function findMeInPlayers(players: unknown[]): (typeof currentMatchPlayers)[number] | undefined {
  if (!Array.isArray(players)) return undefined;
  const list = players as (typeof currentMatchPlayers)[number][];
  if (myParticipantId) {
    const byPid = list.find((p) => p.participantId === myParticipantId);
    if (byPid) return byPid;
  }
  const uid = accountUserId();
  if (uid) return list.find((p) => p.userId === uid);
  return list.length === 1 ? list[0] : undefined;
}

function isSelectedForMatchStart(participantIds?: string[]): boolean {
  const pids = participantIds ?? [];
  if (pids.length === 0) return true;
  return Boolean(myParticipantId && pids.includes(myParticipantId));
}

function findServerPlayerRow<T extends { participantId?: string }>(
  list: T[],
  local: { participantId?: string },
): T | undefined {
  if (!local.participantId) return undefined;
  return list.find((p) => p.participantId === local.participantId);
}

let revealKeysActiveState = false;
let keysAttacksEnabledState = true;

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
/** تحميل شاشة الدرس المخصص بعد الانتقال (بدون حجب الخيط قبل أول رسمة). */
type CustomLessonShellBoot = "idle" | "loading" | "ready" | "error";
let customLessonShellBoot: CustomLessonShellBoot = "idle";
let savedLessonsRows: SavedLessonSummary[] = [];
let savedLessonsLoading = false;
let savedLessonsLibraryErr = "";
let savedLessonEditingId: string | null = null;
/** أيقونة المكتبة للدرس قيد التعديل (من الخادم أو بعد الحفظ) */
let savedLessonLibraryIcon: string | null = null;
/** الدرس المفتوح من المكتبة (صفحة التفاصيل بالأزرار) */
let savedLessonDetailId: string | null = null;
let savedLessonEditorPayload: Record<string, unknown> | null = null;
let savedLessonEditorErr = "";
let savedLessonEditorMsg = "";
/** وجهة الرجوع بعد الخروج من التعلم الفردي للدرس (معاينة / مكتبة / دروس المنصة) */
type LessonSoloPlaybackReturnTarget = "lesson_menu" | "saved_lessons_library" | "custom_lesson";
let lessonSoloPlaybackReturnTarget: LessonSoloPlaybackReturnTarget = "lesson_menu";
/** إعداد برومبت الدرس من الخادم (يقع إلى القيم الافتراضية في الكود عند الفشل). */
let lessonAiPromptRemote: {
  defaults: LessonAiPromptParams;
  audienceOptions: Array<{ v: string; t: string }>;
  promptTemplate: string;
} | null = null;
/** هل للمستخدم معلمات محفوظة على الخادم (تمنع استبدال الذاكرة بافتراضيات الموقع عند جلب الإعداد البعيد). */
let customLessonPromptHasServerOverride = false;

async function refreshCustomLessonPromptServerOverrideFlag(): Promise<void> {
  if (getAuthState().status !== "authenticated") {
    customLessonPromptHasServerOverride = false;
    return;
  }
  const r = await fetchMeCustomLessonPromptParams();
  customLessonPromptHasServerOverride = Boolean(r.ok && r.params != null);
}

async function bootstrapCustomLessonShell(): Promise<void> {
  try {
    await fetchLessonAiPromptPublicConfig();
    const base = defaultCustomPromptParams();
    const d = loadCustomLessonDraft();
    const localPrefs = loadCustomLessonPromptPrefs();
    let promptResolved = base;
    if (getAuthState().status === "authenticated") {
      const me = await fetchMeCustomLessonPromptParams();
      customLessonPromptHasServerOverride = Boolean(me.ok && me.params != null);
      if (me.ok && me.params != null) {
        promptResolved = mergeUserPromptParamsWithSiteDefaults(base, me.params);
      } else if (localPrefs) {
        promptResolved = mergeUserPromptParamsWithSiteDefaults(base, localPrefs.params);
      } else if (d?.promptParams) {
        promptResolved = mergeUserPromptParamsWithSiteDefaults(base, d.promptParams);
      }
    } else {
      customLessonPromptHasServerOverride = false;
      if (localPrefs) {
        promptResolved = mergeUserPromptParamsWithSiteDefaults(base, localPrefs.params);
      } else if (d?.promptParams) {
        promptResolved = mergeUserPromptParamsWithSiteDefaults(base, d.promptParams);
      }
    }
    customLessonPromptParams = promptResolved;
    if (d) {
      customLessonClientId = d.clientLessonId;
      customLessonLearningIntent = d.learningIntent;
      customLessonJsonText = d.jsonText;
      customLessonSessionToken = d.lastSessionToken ?? null;
      customLessonShowJsonPanel =
        d.showJsonPanel === true ||
        (String(d.jsonText ?? "").trim().length > 0 && d.showJsonPanel !== false);
    } else {
      customLessonClientId = "";
      customLessonLearningIntent = "";
      customLessonJsonText = "";
      customLessonSessionToken = null;
      customLessonShowJsonPanel = false;
    }
    customLessonValidatedBody = null;
    customLessonPreviewLesson = null;
    customLessonErr = "";
    customLessonMsg = "";
    customLessonShellBoot = "ready";
  } catch {
    customLessonShellBoot = "error";
    customLessonErr = "تعذر تحميل الإعدادات.";
    customLessonMsg = "";
  }
  if (phase === "custom_lesson") {
    render();
  }
}

async function fetchLessonAiPromptPublicConfig(): Promise<void> {
  try {
    const res = await fetch("/api/public/lesson-ai-prompt-config");
    const data = (await res.json()) as {
      ok?: boolean;
      config?: {
        defaults: LessonAiPromptParams;
        audienceOptions: Array<{ v: string; t: string }>;
        promptTemplate: string;
      };
    };
    if (res.ok && data.ok && data.config) {
      lessonAiPromptRemote = data.config;
      /** لا تستبدل معاملات البرومبت إذا خصّصها المستخدم محلياً أو على الخادم. */
      if (phase !== "custom_lesson") {
        if (!hasLocalCustomLessonPromptPrefs() && !customLessonPromptHasServerOverride) {
          customLessonPromptParams = defaultCustomPromptParams();
        }
      }
    }
  } catch {
    lessonAiPromptRemote = null;
  }
}

function defaultCustomPromptParams(): LessonAiPromptParams {
  return clampCustomLessonFlowParams({
    ...DEFAULT_CUSTOM_LESSON_PROMPT_DEFAULTS,
    topic: "",
  });
}

void fetchLessonAiPromptPublicConfig().then(() => {
  render();
});

let customLessonPromptParams: LessonAiPromptParams = defaultCustomPromptParams();
let lessonStudyQueue: Array<{ body: string; ms: number }> = [];
let lessonStudyIdx = 0;
/** نهاية زمن البطاقة الحالية (للانتقال التلقائي بين البطاقات) */
let lessonStudySegmentEndAt = 0;
/** نهاية زمن مذاكرة القسم كاملاً — العداد الظاهر لا يُعاد من الصفر عند «التالي» */
let lessonStudySectionDeadlineAt = 0;
let lessonQuizIdxInSection = 0;
let lessonSectionIdx = 0;
let lessonQuizCorrect = 0;
let lessonQuizLocked = false;
/** يمنع معالجة انتهاء الوقت بعد إجابة اللاعب أو معالجة المؤقت مرتين */
let lessonQuizRoundResolved = false;
/** اختيارات مسار REST: questionId → فهرس الخيار أو null إن انتهى الوقت دون إجابة */
let lessonRestChoiceByQuestionId = new Map<number, number | null>();
let lessonReviewIndex = 0;

let releaseWatchHandle: number | null = null;
let lastKnownReleaseVersion: string | null = null;
let lastKnownReleaseEtag: string | null = null;
let releaseWatchInFlight = false;
let releaseWatchFailureCount = 0;
let releaseWatchDeferredVersion: string | null = null;
let releaseWatchDeferredReason: string | null = null;
const releaseWatchMetrics = {
  totalChecks: 0,
  successChecks: 0,
  failedChecks: 0,
  notModifiedChecks: 0,
  deferredRefreshes: 0,
  immediateRefreshes: 0,
  socketRefreshSignals: 0,
};

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

function removeRoomQueryParamFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("room");
    history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* ignore */
  }
}

function clearInviteIntentState(): void {
  pendingJoinRoomCode = "";
  removeRoomQueryParamFromUrl();
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

type ReleaseVersionFetchResult =
  | { status: "ok"; releaseVersion: string; etag: string | null }
  | { status: "not_modified"; etag: string | null }
  | { status: "error" };

function isReleaseReloadSensitivePhase(current: Phase): boolean {
  return current === "playing"
    || current === "studying"
    || current === "countdown"
    || current === "lesson_quiz"
    || current === "lesson_study";
}

function computeReleaseWatchDelayMs(): number {
  const failureStep = Math.min(releaseWatchFailureCount, RELEASE_WATCH_MAX_FAILURE_BACKOFF_STEP);
  const multiplier = 2 ** failureStep;
  const base = document.hidden
    ? RELEASE_WATCH_BACKGROUND_INTERVAL_MS
    : RELEASE_WATCH_FOREGROUND_INTERVAL_MS;
  const max = document.hidden
    ? RELEASE_WATCH_BACKGROUND_MAX_MS
    : RELEASE_WATCH_FOREGROUND_MAX_MS;
  const withBackoff = Math.min(max, base * multiplier);
  const jitter = Math.floor(withBackoff * 0.15 * Math.random());
  return withBackoff + jitter;
}

function setReleaseWatchMetricsToWindow(): void {
  try {
    (window as typeof window & { __fahemReleaseWatchMetrics?: unknown }).__fahemReleaseWatchMetrics = {
      ...releaseWatchMetrics,
      releaseWatchFailureCount,
      lastKnownReleaseVersion,
      releaseWatchDeferredVersion,
      releaseWatchDeferredReason,
    };
    // Sync to AppState for debug snapshot
    ReleaseWatchState.handle = releaseWatchHandle;
    ReleaseWatchState.lastKnownVersion = lastKnownReleaseVersion;
    ReleaseWatchState.lastKnownEtag = lastKnownReleaseEtag;
    ReleaseWatchState.inFlight = releaseWatchInFlight;
    ReleaseWatchState.failureCount = releaseWatchFailureCount;
    ReleaseWatchState.deferredVersion = releaseWatchDeferredVersion;
    ReleaseWatchState.deferredReason = releaseWatchDeferredReason;
    Object.assign(ReleaseWatchState.metrics, releaseWatchMetrics);
  } catch {
    /* ignore metrics exposure failures */
  }
}

function performReleaseRefresh(releaseVersion: string): void {
  const target = new URL(window.location.href);
  target.searchParams.set(RELEASE_VERSION_QUERY_KEY, releaseVersion);
  window.location.replace(target.toString());
}

function applyReleaseVersionUpdate(
  releaseVersion: string,
  options?: { source?: "polling" | "socket"; forceImmediate?: boolean },
): void {
  lastKnownReleaseVersion = releaseVersion;
  const shouldDefer = !options?.forceImmediate && isReleaseReloadSensitivePhase(phase);
  if (shouldDefer) {
    releaseWatchDeferredVersion = releaseVersion;
    releaseWatchDeferredReason = options?.source ?? "polling";
    releaseWatchMetrics.deferredRefreshes += 1;
    setReleaseWatchMetricsToWindow();
    return;
  }
  releaseWatchMetrics.immediateRefreshes += 1;
  setReleaseWatchMetricsToWindow();
  performReleaseRefresh(releaseVersion);
}

function maybeApplyDeferredReleaseRefresh(): void {
  if (!releaseWatchDeferredVersion) return;
  if (isReleaseReloadSensitivePhase(phase)) return;
  const next = releaseWatchDeferredVersion;
  releaseWatchDeferredVersion = null;
  releaseWatchDeferredReason = null;
  applyReleaseVersionUpdate(next, { source: "polling", forceImmediate: true });
}

async function fetchReleaseVersion(): Promise<ReleaseVersionFetchResult> {
  try {
    const headers = new Headers({ "Cache-Control": "no-cache" });
    if (lastKnownReleaseEtag) {
      headers.set("If-None-Match", lastKnownReleaseEtag);
    }
    const res = await fetch("/api/release-version", {
      cache: "no-store",
      headers,
    });
    const etag = res.headers.get("etag");
    if (etag) {
      lastKnownReleaseEtag = etag;
    }
    if (res.status === 304) {
      return { status: "not_modified", etag };
    }
    if (!res.ok) return { status: "error" };
    const data = (await res.json()) as { ok?: boolean; releaseVersion?: string };
    if (!data?.ok || typeof data.releaseVersion !== "string") return { status: "error" };
    const value = data.releaseVersion.trim();
    if (!value.length) return { status: "error" };
    return { status: "ok", releaseVersion: value, etag };
  } catch {
    return { status: "error" };
  }
}

async function checkReleaseVersionForRefresh(): Promise<void> {
  if (releaseWatchInFlight) return;
  releaseWatchInFlight = true;
  releaseWatchMetrics.totalChecks += 1;
  const result = await fetchReleaseVersion();
  releaseWatchInFlight = false;
  if (result.status === "error") {
    releaseWatchFailureCount += 1;
    releaseWatchMetrics.failedChecks += 1;
    setReleaseWatchMetricsToWindow();
    return;
  }
  releaseWatchFailureCount = 0;
  if (result.status === "not_modified") {
    releaseWatchMetrics.notModifiedChecks += 1;
    maybeApplyDeferredReleaseRefresh();
    setReleaseWatchMetricsToWindow();
    return;
  }
  releaseWatchMetrics.successChecks += 1;
  const remoteVersion = result.releaseVersion;
  if (!lastKnownReleaseVersion) {
    lastKnownReleaseVersion = remoteVersion;
    maybeApplyDeferredReleaseRefresh();
    setReleaseWatchMetricsToWindow();
    return;
  }
  if (remoteVersion !== lastKnownReleaseVersion) {
    applyReleaseVersionUpdate(remoteVersion, { source: "polling" });
    return;
  }
  maybeApplyDeferredReleaseRefresh();
  setReleaseWatchMetricsToWindow();
}

function scheduleNextReleaseVersionCheck(delayMs?: number): void {
  if (releaseWatchHandle != null) {
    window.clearTimeout(releaseWatchHandle);
    releaseWatchHandle = null;
  }
  const nextDelay = delayMs ?? computeReleaseWatchDelayMs();
  releaseWatchHandle = window.setTimeout(() => {
    void runReleaseVersionCheckCycle();
  }, Math.max(0, nextDelay));
}

async function runReleaseVersionCheckCycle(forceImmediate = false): Promise<void> {
  if (forceImmediate) {
    releaseWatchFailureCount = 0;
  }
  await checkReleaseVersionForRefresh();
  scheduleNextReleaseVersionCheck();
}

function handleReleaseVersionPush(rawVersion: unknown): void {
  const next = String(rawVersion ?? "").trim();
  if (!next) return;
  releaseWatchMetrics.socketRefreshSignals += 1;
  if (next !== lastKnownReleaseVersion) {
    applyReleaseVersionUpdate(next, { source: "socket" });
    return;
  }
  maybeApplyDeferredReleaseRefresh();
  setReleaseWatchMetricsToWindow();
}

function startReleaseVersionWatch(): void {
  if (releaseWatchHandle !== null) return;
  lastKnownReleaseVersion = getReleaseVersionFromUrl();
  void runReleaseVersionCheckCycle(true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      scheduleNextReleaseVersionCheck(RELEASE_WATCH_BACKGROUND_INTERVAL_MS);
      return;
    }
    maybeApplyDeferredReleaseRefresh();
    void runReleaseVersionCheckCycle(true);
  });
  window.addEventListener("online", () => {
    void runReleaseVersionCheckCycle(true);
  });
  setReleaseWatchMetricsToWindow();
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
  participantId?: string;
  userId?: string | null;
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

/** تصفير مزامنة إصدار الغرفة عند نية اتصال خاصة جديدة (لا يمسح اسم اللاعب). */
function resetPrivateRoomSyncStateForNewSocketIntent(): void {
  privateRoomVersionState = 0;
  privateQrDataUrl = null;
}

type PrivateLobbyJoinAck = {
  participantId?: string;
  roomCode?: string;
  inviteUrl?: string;
  hostParticipantId?: string;
  mode?: GameMode;
  subcategoryKey?: string | null;
  difficultyMode?: DifficultyMode;
  roomVersion?: number;
  roomSettings?: { questionMs?: number; studyPhaseMs?: number };
};

/** تطبيق نتيجة إنشاء/انضمام غرفة خاصة بعد ack ناجح — انتقال UI واحد. */
function applyPrivateLobbyJoinAck(joinKind: JoinKind, ack: PrivateLobbyJoinAck): void {
  if (joinKind !== "private_create" && joinKind !== "private_join") return;
  if (ack.participantId) myParticipantId = ack.participantId;
  if (ack.roomCode) privateRoomCodeState = ack.roomCode;
  if (ack.inviteUrl) privateRoomInviteUrl = ack.inviteUrl;
  if (ack.hostParticipantId) privateRoomHostParticipantId = ack.hostParticipantId;
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
  if (phase !== "countdown") {
    phase = "private_room_lobby";
  }
  lobbyNotice =
    joinKind === "private_create"
      ? "تم إنشاء الغرفة الخاصة بنجاح."
      : "تم الانضمام للغرفة الخاصة.";
  if (joinKind === "private_join") {
    clearInviteIntentState();
  }
  clearReconnectMultiplayerRuntime();
  render();
}

function disconnectSearchSocket(): void {
  searchFlowToken += 1;
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  myParticipantId = null;
  privateRoomHostParticipantId = null;
  currentGameMode = null;
  lobbyNotice = "";
  lobbyPlayersList = [];
  soloLearningPending = false;
  privateRoomCodeState = null;
  privateRoomInviteUrl = null;
  privateRoomVersionState = 0;
  privateReadyPending = false;
  privateReadyTargetState = null;
  privateQrDataUrl = null;
  isPrivateRoomSession = false;
  clearReconnectMultiplayerRuntime();
}

function returnToDifficultyFromSearch(): void {
  disconnectSearchSocket();
  phase = "name";
  nameFlowStep = "difficulty";
  render();
}

function returnToHomeFromSearch(): void {
  disconnectSearchSocket();
  lessonSoloPlaybackReturnTarget = "lesson_menu";
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
  render();
}

function startReconnectFromPrompt(): void {
  const name = getEffectivePlayerName(playerNameDraft);
  storePlayerName(name);
  playerNameDraft = name;
  phase = "matchmaking";
  soloLearningPending = false;
  isPrivateRoomSession = false;
  lobbyNotice = "جاري محاولة استعادة المباراة…";
  render();
  connectSocket(name, "direct", null, "mix", "public", undefined, null, null, "resume_only");
}

function cancelReconnectPrompt(): void {
  clearReconnectMultiplayerRuntime();
  reconnectPromptState = null;
  render();
}

function cancelInvitePrompt(): void {
  clearInviteIntentState();
  phase = "name";
  nameFlowStep = "mode";
  render();
}

function isCurrentStudyRound(token?: string | null, macroRound?: number): boolean {
  if (!token || !activeStudyRoundToken) return false;
  if (token !== activeStudyRoundToken) return false;
  if (typeof macroRound === "number" && macroRound !== activeStudyMacroRound) return false;
  return true;
}

function clearTimer(): void {
  if (timerHandle != null) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function openAccountProfileModal(): void {
  const run = (): void => {
    openAuthModal({
      onCompleted: () => render(),
    });
  };
  if (typeof queueMicrotask === "function") queueMicrotask(run);
  else window.setTimeout(run, 0);
}

function render(): void {
  clearTimer();
  app.innerHTML = "";

  if (phase === "name") {
    const hasReconnectPrompt =
      reconnectPromptState != null && Number.isFinite(reconnectPromptState.expiresAt) && Date.now() < reconnectPromptState.expiresAt;
    if (!hasReconnectPrompt && reconnectPromptState) {
      reconnectPromptState = null;
    }
    const isReconnectEntryFlow = Boolean(reconnectPromptState);
    const isPrivateEntryFlow = !isReconnectEntryFlow && Boolean(pendingJoinRoomCode);
    const renderModePicker = !isPrivateEntryFlow && !isReconnectEntryFlow && nameFlowStep === "mode";
    const renderDifficultyPicker = !isPrivateEntryFlow && !isReconnectEntryFlow && nameFlowStep === "difficulty";
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
    const authUi = getAuthState();
    const guestNameFieldsHtml =
      authUi.status === "unauthenticated"
        ? `<label class="block text-right text-sm text-slate-400">اسمك في اللعبة (اختياري)</label>
              <input id="name-input" maxlength="32" type="text" placeholder="اتركه فارغاً لاستخدام «مجهول» دون اسم محفوظ" class="app-input w-full px-4 py-3 text-right text-lg" />
              <p class="text-xs text-slate-500 text-right m-0">إن لم يُعرَض لك حقلاً للاسم، سيُستخدم «مجهول» في التحدي حتى يتوفر اسم من الملف أو الحساب.</p>`
        : "";
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white flex flex-col items-center justify-center p-4">
          <div class="max-w-lg w-full space-y-6 text-center">
            <h1 class="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-l from-amber-300 to-orange-400">فاهم</h1>
            <p class="text-slate-300 text-lg">تحدٍّ سريع — من يبقى آخر يفوز؟</p>
            <div class="app-card p-6 space-y-5">
              ${guestNameFieldsHtml}
              <div class="auth-entry-inline">
                <span class="auth-entry-status">${escapeHtml(getAuthWelcomeLine(playerNameDraft))}</span>
                <button id="auth-open-btn" type="button" class="ui-btn ui-btn--ghost px-3 py-2 text-sm"${
                  authUi.status === "idle" || authUi.status === "loading" ? ' disabled aria-busy="true"' : ""
                }>
                  ${
                    authUi.status === "authenticated"
                      ? "الحساب والملف الشخصي"
                      : authUi.status === "idle" || authUi.status === "loading"
                        ? "جاري التحقق…"
                        : "تسجيل الدخول"
                  }
                </button>
              </div>
              <p class="text-sm text-slate-400 text-right m-0">${
                isReconnectEntryFlow
                  ? "لديك مباراة متعددة اللاعبين قيد التنفيذ."
                  : isPrivateEntryFlow
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
                  isReconnectEntryFlow
                    ? `
                <div class="app-card p-3 text-right space-y-2">
                  <p class="text-sm text-slate-300 m-0">يوجد اتصال قابل للاستعادة خلال مهلة قصيرة. هل تريد استعادة المباراة الآن؟</p>
                  <div class="flex gap-2">
                    <button id="reconnect-cancel-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm">إلغاء</button>
                    <button id="reconnect-confirm-btn" type="button" class="ui-btn ui-btn--cta w-full py-2 text-sm">استعادة المباراة</button>
                  </div>
                </div>
                `
                    : isPrivateEntryFlow
                    ? `
                <div class="app-card p-3 text-right">
                  <p class="text-sm text-slate-300 m-0">تم اكتشاف دعوة لغرفة خاصة عبر الرابط/الباركود. لن يتم الانضمام تلقائيًا.</p>
                  <button id="private-entry-cancel-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm mt-2">تجاهل الدعوة</button>
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
                  isPrivateEntryFlow || isReconnectEntryFlow || renderDifficultyPicker ? "" : "hidden"
                }">${
                  isReconnectEntryFlow
                    ? "استعادة المباراة"
                    : isPrivateEntryFlow
                    ? "انضمام للغرفة"
                    : renderDifficultyPicker
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
    const input = app.querySelector<HTMLInputElement>("#name-input");
    const storedName = getStoredPlayerName();
    if (input) {
      if (playerNameDraft || storedName) {
        input.value = playerNameDraft || storedName;
      }
      input.addEventListener("input", () => {
        playerNameDraft = input.value;
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          input.blur();
        }
      });
    }
    const syncDraftFromGuestInput = (): void => {
      if (input) playerNameDraft = input.value;
    };
    const resolveJoinDisplayName = (): string => {
      syncDraftFromGuestInput();
      const n = getEffectivePlayerName(playerNameDraft);
      storePlayerName(n);
      playerNameDraft = n;
      return n;
    };
    const btn = app.querySelector<HTMLButtonElement>("#join-btn")!;
    const soloBtn = app.querySelector<HTMLButtonElement>("#solo-learning-btn");
    const createPrivateBtn = app.querySelector<HTMLButtonElement>("#create-private-room-btn");
    const joinPrivateBtn = app.querySelector<HTMLButtonElement>("#join-private-room-btn");
    const privateCodeInput = app.querySelector<HTMLInputElement>("#private-room-code-input");
    const backBtn = app.querySelector<HTMLButtonElement>("#back-mode-btn");
    const err = app.querySelector<HTMLParagraphElement>("#join-err")!;
    app.querySelector<HTMLButtonElement>("#auth-open-btn")?.addEventListener("click", () => {
      openAuthModal({
        onCompleted: () => {
          render();
        },
      });
    });
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
      syncDraftFromGuestInput();
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
          syncDraftFromGuestInput();
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
            customLessonShellBoot = "loading";
            customLessonErr = "";
            customLessonMsg = "";
            phase = "custom_lesson";
            render();
            void bootstrapCustomLessonShell();
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
            return;
          }
          err.textContent = "";
          nameFlowStep = "difficulty";
          render();
        });
      });
    } else if (nameFlowStep === "main_categories") {
      modeBtns.forEach((b) => {
        b.addEventListener("click", () => {
          syncDraftFromGuestInput();
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
          syncDraftFromGuestInput();
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
      syncDraftFromGuestInput();
      if (nameFlowStep === "main_categories") {
        if (!selectedMainCategoryId) {
          err.textContent = "اختر تصنيفًا رئيسيًا.";
          return;
        }
        btn.disabled = true;
        btn.classList.add("btn-pending");
        nameFlowStep = "sub_categories";
        btn.disabled = false;
        btn.classList.remove("btn-pending");
        render();
        return;
      }
      if (nameFlowStep === "sub_categories") {
        if (!selectedSubcategoryKey) {
          err.textContent = "اختر تصنيفًا فرعيًا.";
          return;
        }
        btn.disabled = true;
        btn.classList.add("btn-pending");
        nameFlowStep = "difficulty";
        btn.disabled = false;
        btn.classList.remove("btn-pending");
        render();
        return;
      }
      const name = resolveJoinDisplayName();
      btn.disabled = true;
      btn.classList.add("btn-pending");
      if (isPrivateEntryFlow) {
        phase = "matchmaking";
        soloLearningPending = false;
        privateRoomCodeState = pendingJoinRoomCode;
        privateRoomInviteUrl = null;
        isPrivateRoomSession = true;
        lobbyNotice = "جاري الانضمام للغرفة الخاصة...";
        render();
        connectSocket(name, "direct", null, "mix", "private_join", pendingJoinRoomCode);
        return;
      }
      if (isReconnectEntryFlow) {
        startReconnectFromPrompt();
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
      if (selectedModeInName === "study_then_quiz" && !selectedSubcategoryKey) {
        err.textContent = "اختر تصنيفًا فرعيًا أولاً.";
        return;
      }
      const name = resolveJoinDisplayName();
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
      const name = resolveJoinDisplayName();
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
      const name = resolveJoinDisplayName();
      const roomCode = (privateCodeInput?.value || pendingJoinRoomCode).trim().toUpperCase();
      if (!roomCode) {
        err.textContent = "أدخل كود الغرفة.";
        return;
      }
      pendingJoinRoomCode = roomCode;
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
    app.querySelector<HTMLButtonElement>("#reconnect-confirm-btn")?.addEventListener("click", () => {
      err.textContent = "";
      syncDraftFromGuestInput();
      startReconnectFromPrompt();
    });
    app.querySelector<HTMLButtonElement>("#reconnect-cancel-btn")?.addEventListener("click", () => {
      err.textContent = "";
      cancelReconnectPrompt();
    });
    app.querySelector<HTMLButtonElement>("#private-entry-cancel-btn")?.addEventListener("click", () => {
      err.textContent = "";
      cancelInvitePrompt();
    });
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
    const persistPromptPrefs = (): void => {
      readParamsFromDom();
      saveCustomLessonPromptPrefs(customLessonPromptParams);
      if (getAuthState().status === "authenticated") {
        void putMeCustomLessonPromptParams(customLessonPromptParams).then((r) => {
          if (r.ok) customLessonPromptHasServerOverride = true;
        });
      }
      persistDraft();
    };
    const audienceOptions: Array<{ v: string; t: string }> =
      lessonAiPromptRemote?.audienceOptions && lessonAiPromptRemote.audienceOptions.length > 0
        ? lessonAiPromptRemote.audienceOptions
        : [...DEFAULT_CUSTOM_LESSON_AUDIENCE_OPTIONS];
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-3 text-right">
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <button type="button" id="cl-back" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">الرئيسية</button>
              <button type="button" id="cl-library" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">مكتبة دروسي</button>
            </div>
            <h1 class="text-xl font-extrabold text-amber-300 text-center m-0">درس مخصص</h1>
          </div>
          ${
            customLessonShellBoot === "loading"
              ? `<p class="text-amber-200 text-sm m-0" role="status">جاري تحميل الإعدادات…</p>`
              : ""
          }
          <p class="text-slate-400 text-sm m-0">اكتب ما تريد تعلّمه، انسخ البرومبت إلى ChatGPT أو Gemini، ثم الصق JSON هنا. بعد «إضافة الدرس» يمكنك حفظ نسخة في «مكتبة دروسي» عند تسجيل الدخول.</p>
          <label class="text-slate-300 text-sm">ماذا تريد أن تتعلّم؟</label>
          <textarea id="cl-intent" rows="4" class="app-input w-full px-3 py-2 text-sm" placeholder="مادة، موضوع، أو ملخّص لما تريد أن يغطيه الدرس...">${escapeHtml(customLessonLearningIntent)}</textarea>
          <details class="app-card p-3 space-y-2">
            <summary class="cursor-pointer text-amber-200 text-sm font-bold">إعدادات البرومبت (اختياري)</summary>
            <div class="grid grid-cols-2 gap-2 pt-2">
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">عدد الأقسام</span>
                <input id="cl-nsec" type="number" min="1" max="${CUSTOM_LESSON_FLOW_MAX_NSEC}" class="app-input px-2 py-1 text-sm w-full" value="${p.nSec}" title="عدد أقسام الدرس (1–${CUSTOM_LESSON_FLOW_MAX_NSEC})" aria-label="عدد أقسام الدرس" placeholder="1–${CUSTOM_LESSON_FLOW_MAX_NSEC}" />
              </div>
              <div class="flex flex-col gap-0.5 min-w-0">
                <span class="text-[10px] text-slate-500 leading-tight">أسئلة لكل قسم</span>
                <input id="cl-qsame" type="number" min="1" max="${CUSTOM_LESSON_FLOW_MAX_QSAME}" class="app-input px-2 py-1 text-sm w-full" value="${p.qSame}" title="عدد أسئلة الاختيار من متعدد في كل قسم" aria-label="عدد الأسئلة لكل قسم" placeholder="1–${CUSTOM_LESSON_FLOW_MAX_QSAME}" />
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
            <button type="button" id="cl-save-lib" class="ui-btn ui-btn--cta w-full py-2">حفظ في المكتبة</button>
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
      const n = num("#cl-nsec", 3, 1, CUSTOM_LESSON_FLOW_MAX_NSEC);
      const q = num("#cl-qsame", 5, 1, CUSTOM_LESSON_FLOW_MAX_QSAME);
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
    for (const sel of [
      "#cl-nsec",
      "#cl-qsame",
      "#cl-anssec",
      "#cl-studysec",
      "#cl-minsent",
      "#cl-maxsent",
      "#cl-audience",
    ] as const) {
      app.querySelector(sel)?.addEventListener("change", () => {
        persistPromptPrefs();
      });
    }
    app.querySelector("#cl-back")?.addEventListener("click", () => {
      persistPromptPrefs();
      customLessonShellBoot = "idle";
      phase = "name";
      nameFlowStep = "mode";
      render();
    });
    app.querySelector("#cl-library")?.addEventListener("click", () => {
      persistPromptPrefs();
      if (getAuthState().status !== "authenticated") {
        openAuthModal({
          onCompleted: () => {
            openSavedLessonsLibraryScreen();
          },
        });
        return;
      }
      openSavedLessonsLibraryScreen();
    });
    app.querySelector("#cl-copy")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      const promptOpts: BuildLessonAiPromptOptions | undefined = lessonAiPromptRemote
        ? { promptTemplate: lessonAiPromptRemote.promptTemplate }
        : undefined;
      const text = buildCustomLessonAiPromptText(
        {
          ...customLessonPromptParams,
          learningIntent: customLessonLearningIntent,
        },
        promptOpts,
      );
      try {
        await navigator.clipboard.writeText(text);
        customLessonMsg = "تم نسخ البرومبت.";
        customLessonShowJsonPanel = true;
      } catch {
        customLessonErr = "تعذر النسخ — انسخ يدوياً.";
      }
      persistPromptPrefs();
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
      const parsedJson = parseLessonPastedJson(customLessonJsonText);
      if (!parsedJson.ok) {
        customLessonErr = parsedJson.detail;
        persistPromptPrefs();
        render();
        return;
      }
      const body = parsedJson.value as Record<string, unknown>;
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
          persistPromptPrefs();
          render();
          return;
        }
        customLessonValidatedBody = body;
        customLessonPreviewLesson = data.lesson;
        customLessonMsg = `تم التحقق — ${data.lesson.steps.length} خطوة في الدرس.`;
      } catch {
        customLessonErr = "تعذر الاتصال بالخادم.";
      }
      persistPromptPrefs();
      render();
    });
    app.querySelector("#cl-solo")?.addEventListener("click", () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      if (!customLessonPreviewLesson) {
        customLessonErr = "استخدم «إضافة الدرس» أولاً.";
        persistPromptPrefs();
        render();
        return;
      }
      persistPromptPrefs();
      clearTimer();
      beginLessonPlayback(customLessonPreviewLesson, "custom_lesson");
      render();
    });
    app.querySelector("#cl-save-lib")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      if (!customLessonValidatedBody) {
        customLessonErr = "استخدم «إضافة الدرس» أولاً.";
        persistPromptPrefs();
        render();
        return;
      }
      const attempt = async (): Promise<void> => {
        const r = await postSavedLesson(customLessonValidatedBody as Record<string, unknown>);
        if (!r.ok) {
          if (r.status === 409) {
            customLessonErr = "بلغت الحد الأقصى لدروسك المحفوظة.";
          } else {
            customLessonErr = "تعذر الحفظ.";
          }
          persistPromptPrefs();
          render();
          return;
        }
        customLessonMsg = "تم حفظ الدرس في المكتبة.";
        persistPromptPrefs();
        render();
      };
      if (getAuthState().status !== "authenticated") {
        openAuthModal({
          onCompleted: () => {
            void attempt();
          },
        });
        return;
      }
      await attempt();
    });
    app.querySelector("#cl-private")?.addEventListener("click", async () => {
      readParamsFromDom();
      customLessonErr = "";
      customLessonMsg = "";
      if (!customLessonValidatedBody) {
        customLessonErr = "استخدم «إضافة الدرس» أولاً.";
        persistPromptPrefs();
        render();
        return;
      }
      const name = getEffectivePlayerName(playerNameDraft);
      try {
        const res = await fetch("/api/custom-lessons/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(customLessonValidatedBody),
        });
        const data = (await res.json()) as { ok?: boolean; token?: string; error?: string };
        if (!res.ok || !data.ok || !data.token) {
          customLessonErr = data.error || "تعذر إنشاء جلسة الدرس.";
          persistPromptPrefs();
          render();
          return;
        }
        customLessonSessionToken = data.token;
        persistPromptPrefs();
        storePlayerName(name);
        playerNameDraft = name;
        phase = "private_room_lobby";
        soloLearningPending = false;
        privateRoomCodeState = null;
        privateRoomInviteUrl = null;
        privateQrDataUrl = null;
        isPrivateRoomSession = true;
        currentGameMode = "lesson";
        lobbyNotice = "جاري إنشاء الغرفة الخاصة للدرس المخصص…";
        render();
        connectSocket(name, "lesson", null, "mix", "private_create", undefined, null, data.token);
      } catch {
        customLessonErr = "تعذر الاتصال بالخادم.";
        persistPromptPrefs();
        render();
      }
    });
    return;
  }

  if (phase === "saved_lessons_library") {
    renderSavedLessonsLibraryScreen({
      getSavedLessonsRows: () => savedLessonsRows,
      getSavedLessonsLoading: () => savedLessonsLoading,
      getSavedLessonsLibraryErr: () => savedLessonsLibraryErr,
      savedLessonLibraryIconDisplay,
      savedLessonExpiryCaption,
      setPhase: (p) => { phase = p; },
      setSavedLessonDetailId: (id) => { savedLessonDetailId = id; },
      setSavedLessonsLibraryErr: (msg) => { savedLessonsLibraryErr = msg; },
      render,
    });
    return;
  }

  if (phase === "saved_lesson_detail") {
    if (!savedLessonDetailId) {
      phase = "saved_lessons_library";
      render();
      return;
    }
    const row = savedLessonsRows.find((r) => r.id === savedLessonDetailId);
    if (!row) {
      savedLessonDetailId = null;
      phase = "saved_lessons_library";
      render();
      return;
    }
    app.append(
      el(`
        <div class="app-screen min-h-screen text-white p-4 flex flex-col max-w-lg mx-auto w-full gap-4 text-right">
          <div class="flex items-center justify-between gap-2">
            <button type="button" id="ssd-back" class="ui-btn ui-btn--ghost py-2 px-3 text-sm">المكتبة</button>
            <h1 class="text-lg font-extrabold text-amber-300 m-0 truncate max-w-[60%]">${escapeHtml(row.title)}</h1>
          </div>
          <div class="flex flex-col items-center gap-2 py-2 border border-slate-600/45 rounded-xl bg-slate-900/30">
            <span class="text-6xl leading-none select-none" aria-hidden="true">${savedLessonLibraryIconDisplay(row.libraryIcon)}</span>
            <span class="font-bold text-amber-200 text-base text-center px-2">${escapeHtml(row.title)}</span>
            <p class="text-slate-400 text-sm m-0">${escapeHtml(savedLessonExpiryCaption(row.expiresAt))}</p>
          </div>
          ${savedLessonsLibraryErr ? `<p class="text-red-400 text-sm m-0">${escapeHtml(savedLessonsLibraryErr)}</p>` : ""}
          <div class="flex flex-col gap-2 pt-1">
            <button type="button" class="ui-btn ui-btn--primary w-full py-2.5 text-sm min-h-[44px] ssl-play" data-id="${escapeHtml(row.id)}">التعلم الفردي</button>
            <button type="button" class="ui-btn ui-btn--ghost w-full py-2.5 text-sm min-h-[44px] ssl-private" data-id="${escapeHtml(row.id)}">غرفة خاصة</button>
            <button type="button" class="ui-btn ui-btn--ghost w-full py-2.5 text-sm min-h-[44px] ssl-edit" data-id="${escapeHtml(row.id)}">تعديل</button>
            <button type="button" class="ui-btn ui-btn--ghost w-full py-2.5 text-sm min-h-[44px] text-red-300 ssl-del" data-id="${escapeHtml(row.id)}">حذف</button>
          </div>
        </div>
      `),
    );
    app.querySelector("#ssd-back")?.addEventListener("click", () => {
      savedLessonDetailId = null;
      savedLessonsLibraryErr = "";
      phase = "saved_lessons_library";
      render();
    });
    app.querySelector(".ssl-play")?.addEventListener("click", async () => {
      const id = savedLessonDetailId;
      if (!id) return;
      savedLessonsLibraryErr = "";
      const det = await fetchSavedLessonDetail(id);
      const payload = det.lesson?.payload as Record<string, unknown> | undefined;
      if (!payload) {
        savedLessonsLibraryErr = "تعذر تحميل الدرس.";
        render();
        return;
      }
      try {
        const res = await fetch("/api/custom-lessons/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          lesson?: LessonPlaybackPayload;
          error?: string;
        };
        if (!res.ok || !data.ok || !data.lesson) {
          savedLessonsLibraryErr = data.error || "تعذر تشغيل الدرس.";
          render();
          return;
        }
        clearTimer();
        beginLessonPlayback(data.lesson, "saved_lessons_library");
        render();
      } catch {
        savedLessonsLibraryErr = "تعذر الاتصال بالخادم.";
        render();
      }
    });
    app.querySelector(".ssl-edit")?.addEventListener("click", async () => {
      const id = savedLessonDetailId;
      if (!id) return;
      savedLessonsLibraryErr = "";
      const det = await fetchSavedLessonDetail(id);
      const payload = det.lesson?.payload as Record<string, unknown> | undefined;
      if (!payload) {
        savedLessonsLibraryErr = "تعذر تحميل الدرس للتعديل.";
        render();
        return;
      }
      savedLessonEditingId = id;
      savedLessonEditorPayload = payload;
      const rawIcon = det.lesson?.libraryIcon;
      savedLessonLibraryIcon =
        rawIcon != null && String(rawIcon).trim() !== "" ? String(rawIcon).trim() : null;
      savedLessonEditorErr = "";
      savedLessonEditorMsg = "";
      phase = "saved_lesson_edit";
      render();
    });
    app.querySelector(".ssl-private")?.addEventListener("click", async () => {
      const id = savedLessonDetailId;
      if (!id) return;
      savedLessonsLibraryErr = "";
      const det = await fetchSavedLessonDetail(id);
      const body = det.lesson?.payload as Record<string, unknown> | undefined;
      if (!body) {
        savedLessonsLibraryErr = "تعذر تحميل الدرس.";
        render();
        return;
      }
      const name = getEffectivePlayerName(playerNameDraft);
      try {
        const res = await fetch("/api/custom-lessons/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json()) as { ok?: boolean; token?: string; error?: string };
        if (!res.ok || !data.ok || !data.token) {
          savedLessonsLibraryErr = data.error || "تعذر إنشاء جلسة الدرس.";
          render();
          return;
        }
        customLessonSessionToken = data.token;
        storePlayerName(name);
        playerNameDraft = name;
        phase = "private_room_lobby";
        soloLearningPending = false;
        privateRoomCodeState = null;
        privateRoomInviteUrl = null;
        privateQrDataUrl = null;
        isPrivateRoomSession = true;
        currentGameMode = "lesson";
        lobbyNotice = "جاري إنشاء الغرفة الخاصة للدرس المحفوظ…";
        render();
        connectSocket(name, "lesson", null, "mix", "private_create", undefined, null, data.token);
      } catch {
        savedLessonsLibraryErr = "تعذر الاتصال بالخادم.";
        render();
      }
    });
    app.querySelector(".ssl-del")?.addEventListener("click", async () => {
      const id = savedLessonDetailId;
      if (!id) return;
      if (!window.confirm("حذف هذا الدرس من المكتبة؟")) return;
      savedLessonsLibraryErr = "";
      const r = await deleteSavedLesson(id);
      if (!r.ok) {
        savedLessonsLibraryErr = "تعذر الحذف.";
        render();
        return;
      }
      savedLessonsRows = savedLessonsRows.filter((x) => x.id !== id);
      savedLessonDetailId = null;
      phase = "saved_lessons_library";
      render();
    });
    return;
  }

  if (phase === "saved_lesson_edit") {
    renderSavedLessonEditScreen({
      getSavedLessonEditingId: () => savedLessonEditingId,
      getSavedLessonEditorPayload: () => savedLessonEditorPayload,
      getSavedLessonLibraryIcon: () => savedLessonLibraryIcon,
      getSavedLessonEditorErr: () => savedLessonEditorErr,
      getSavedLessonEditorMsg: () => savedLessonEditorMsg,
      setSavedLessonLibraryIcon: (v) => { savedLessonLibraryIcon = v; },
      setSavedLessonDetailId: (v) => { savedLessonDetailId = v; },
      setSavedLessonEditorPayload: (p) => { savedLessonEditorPayload = p; },
      setSavedLessonEditorErr: (msg) => { savedLessonEditorErr = msg; },
      setSavedLessonEditorMsg: (msg) => { savedLessonEditorMsg = msg; },
      setSavedLessonEditingId: (id) => { savedLessonEditingId = id; },
      setSavedLessonsLoading: (v) => { savedLessonsLoading = v; },
      setSavedLessonsRows: (rows) => { savedLessonsRows = rows as typeof savedLessonsRows; },
      renderSavedLessonEditorMarkup,
      removeSectionFromPayload,
      removeQuestionFromPayload,
      collectSavedLessonPayloadFromEditor,
      readLibraryIconFromEditor,
      patchSavedLesson,
      fetchSavedLessonsList,
      setPhase: (p) => { phase = p; },
      render,
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
    const exit = (): void => {
      exitLessonPlaybackToHub();
      if (phase === "lesson_menu") {
        void fetchLessonBrowse()
          .then(() => {
            render();
          })
          .catch(() => {
            render();
          });
      }
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
      if (phase === "lesson_menu") {
        void fetchLessonBrowse()
          .then(() => render())
          .catch(() => render());
      }
    });
    startLessonQuizTimer();
    return;
  }

  if (phase === "lesson_done") {
    renderLessonDoneScreen({
      getLessonPlayback: () => lessonPlayback,
      getLessonQuizCorrect: () => lessonQuizCorrect,
      getLessonSoloPlaybackReturnTarget: () => lessonSoloPlaybackReturnTarget,
      setPhase: (p) => { phase = p; },
      setLessonReviewIndex: (v) => { lessonReviewIndex = v; },
      setLessonSoloPlaybackReturnTarget: (v) => { lessonSoloPlaybackReturnTarget = v as typeof lessonSoloPlaybackReturnTarget; },
      setCustomLessonPreviewLesson: () => { customLessonPreviewLesson = null; },
      setCustomLessonValidatedBody: () => { customLessonValidatedBody = null; },
      setCustomLessonSessionToken: () => { customLessonSessionToken = null; },
      setCustomLessonErr: (v) => { customLessonErr = v; },
      setCustomLessonMsg: (v) => { customLessonMsg = v; },
      clearTimer,
      resetLessonState,
      beginLessonPlayback,
      openSavedLessonsLibraryScreen,
      returnToHomeFromSearch,
      finishLessonFromDoneScreen,
      render,
    });
    return;
  }

  if (phase === "lesson_review") {
    renderLessonReviewScreen({
      getLessonReviewIndex: () => lessonReviewIndex,
      getLessonPlayback: () => lessonPlayback,
      lessonRestReviewItems,
      setPhase: (p) => { phase = p; },
      setLessonReviewIndex: (v) => { lessonReviewIndex = v; },
      render,
    });
    return;
  }

  if (phase === "match_lesson_review") {
    renderMatchLessonReviewScreen({
      getMatchLessonReviewItems: () => matchLessonReviewItems,
      getMatchLessonReviewIndex: () => matchLessonReviewIndex,
      setPhase: (p) => { phase = p; },
      setMatchLessonReviewIndex: (v) => { matchLessonReviewIndex = v; },
      render,
      getGameMode: () => currentGameMode,
    });
    return;
  }

  if (phase === "matchmaking") {
    const isPrivateLobby = Boolean(privateRoomCodeState);
    const meReadyMm = Boolean(lobbyPlayersList.find((p) => playerIsMe(p))?.ready);
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
              <p id="private-lobby-flow-status" class="text-center text-slate-200 text-sm font-medium m-0 mt-2 px-1 leading-relaxed">${escapeHtml(getPrivateRoomFlowStatusText())}</p>
              <div class="private-room-actions flex gap-2">
                <button id="copy-private-link-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm">نسخ الرابط</button>
                <button id="private-ready-btn" type="button" class="ui-btn ui-btn--cta w-full py-2 text-sm">${isPrivateLobby ? (privateReadyPending ? "جارٍ الإرسال..." : meReadyMm ? "إلغاء الجاهزية" : "جاهز") : "جاهز"}</button>
              </div>
              <img id="private-qr-img" class="w-40 h-40 mx-auto rounded-lg bg-white p-2" alt="QR الغرفة" />
              <div class="space-y-2 ${isPrivateRoomHost() ? "" : "hidden"}">
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
            const isMe = playerIsMe(p);
            const isHost =
              Boolean(
                privateRoomHostParticipantId &&
                  p.participantId &&
                  p.participantId === privateRoomHostParticipantId,
              );
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
        if (privateReadyPending) return;
        const me = lobbyPlayersList.find((p) => playerIsMe(p));
        if (!me?.participantId) {
          lobbyNotice = "تعذر تحديد هويتك في الغرفة. أعد الدخول للغرفة الخاصة.";
          render();
          return;
        }
        const nextReady = !Boolean(me?.ready);
        privateReadyPending = true;
        privateReadyTargetState = nextReady;
        render();
        const fallback = setTimeout(() => {
          if (privateReadyPending) {
            privateReadyPending = false;
            privateReadyTargetState = null;
            lobbyNotice = "تأخر تحديث الجاهزية. تحقق من الاتصال ثم حاول مرة أخرى.";
            render();
          }
        }, 5000);
        socket?.emit("private_room_set_ready", { ready: nextReady }, (ack?: { ok?: boolean }) => {
          clearTimeout(fallback);
          if (!ack?.ok) {
            privateReadyPending = false;
            privateReadyTargetState = null;
            lobbyNotice = "تعذر تغيير حالة الجاهزية.";
            const n = app.querySelector<HTMLParagraphElement>("#lobby-notice");
            if (n) n.textContent = lobbyNotice;
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
    const meReady = Boolean(lobbyPlayersList.find((p) => playerIsMe(p))?.ready);
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
            <p id="private-lobby-flow-status" class="text-center text-slate-200 text-sm font-medium m-0 mt-2 px-1 leading-relaxed">${escapeHtml(getPrivateRoomFlowStatusText())}</p>
            <div class="private-room-actions flex gap-2">
              <button id="copy-private-link-btn" type="button" class="ui-btn ui-btn--ghost w-full py-2 text-sm">نسخ الرابط</button>
              <button id="private-ready-btn" type="button" class="ui-btn ui-btn--cta w-full py-2 text-sm">${privateReadyPending ? "جارٍ الإرسال..." : meReady ? "إلغاء الجاهزية" : "جاهز"}</button>
            </div>
            <img id="private-qr-img" class="w-40 h-40 mx-auto rounded-lg bg-white p-2" alt="QR الغرفة" />
            <p class="text-xs text-slate-400 break-all">${escapeHtml(inviteUrl)}</p>
            <div class="space-y-2 ${isPrivateRoomHost() ? "" : "hidden"}">
              <label class="block text-xs text-slate-400">وقت السؤال (ثانية)</label>
              <input id="private-question-ms-input" type="number" min="5" max="120" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomQuestionMs / 1000)}" />
              <div class="${currentGameMode === "study_then_quiz" ? "" : "hidden"}">
                <label class="block text-xs text-slate-400">وقت بطاقات المذاكرة (ثانية)</label>
                <input id="private-study-ms-input" type="number" min="10" max="300" class="app-input w-full px-3 py-2 text-right" value="${Math.round(privateRoomStudyPhaseMs / 1000)}" />
              </div>
              <button id="private-save-settings-btn" type="button" class="ui-btn ui-btn--primary w-full py-2 text-sm">حفظ إعدادات الوقت</button>
            </div>
            <div id="private-teams-root" class="w-full"></div>
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
          const isMe = playerIsMe(p);
          const isHost =
            Boolean(
              privateRoomHostParticipantId &&
                p.participantId &&
                p.participantId === privateRoomHostParticipantId,
            );
          return `<div class="private-player-row flex items-center justify-between py-2 px-2 border-b border-white/10">
            <span class="private-player-name">${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}${isHost ? " 👑" : ""}</span>
            <span class="private-player-ready ${p.ready ? "is-ready text-emerald-300" : "text-slate-400"}">${p.ready ? "جاهز" : "غير جاهز"}</span>
          </div>`;
        })
        .join("");
    }
    renderPrivateRoomTeamsSection();
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
      const me = lobbyPlayersList.find((p) => playerIsMe(p));
      if (!me?.participantId) {
        lobbyNotice = "تعذر تحديد هويتك في الغرفة. أعد الدخول للغرفة الخاصة.";
        render();
        return;
      }
      const nextReady = !Boolean(me?.ready);
      privateReadyPending = true;
      privateReadyTargetState = nextReady;
      render();
      const fallback = setTimeout(() => {
        if (privateReadyPending) {
          privateReadyPending = false;
          privateReadyTargetState = null;
          lobbyNotice = "تأخر تحديث الجاهزية. تحقق من الاتصال ثم حاول مرة أخرى.";
          render();
        }
      }, 5000);
      socket?.emit("private_room_set_ready", { ready: nextReady }, (ack?: { ok?: boolean }) => {
        clearTimeout(fallback);
        if (!ack?.ok) {
          privateReadyPending = false;
          privateReadyTargetState = null;
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
    renderCountdownScreen({
      isPrivateRoomSession: () => isPrivateRoomSession,
      getLastPrivateRoomCode: () => lastPrivateRoomCode,
    });
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
            <p id="captain-mode-hint" class="hidden text-center text-amber-200/90 text-xs m-0 leading-relaxed px-1" role="note"></p>
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
    const meH = findMeInPlayers(currentMatchPlayers)?.hearts ?? 3;
    renderHearts(meH);
    renderPlayingPlayersPanel();
    refreshKeysBadge();
    startQuestionTimer();
    if (socket) bindPlayingAbilityUi(socket);
    const capHint = app.querySelector<HTMLParagraphElement>("#captain-mode-hint");
    if (capHint) {
      if (spectatorFollowing || matchTeamPlayMode !== "teams_captain_approval") {
        capHint.classList.add("hidden");
        capHint.textContent = "";
      } else {
        capHint.classList.remove("hidden");
        const me = findMeInPlayers(currentMatchPlayers);
        capHint.textContent = me?.isCaptain
          ? "وضع الكابتن: اختر خيارًا ثم اضغطه مرتين لتأكيد إجابة الفريق."
          : "وضع الكابتن: صوّت لخيار واحد؛ يؤكد الكابتن الإجابة بلمسة ثانية على نفس الخيار.";
      }
    }
    return;
  }

  if (phase === "result") {
    renderResultScreen({
      isPrivateRoomSession: () => isPrivateRoomSession,
      getLastPrivateRoomCode: () => lastPrivateRoomCode,
      getMatchLessonReviewItems: () => matchLessonReviewItems,
      getGameMode: () => currentGameMode,
      getMyParticipantId: () => myParticipantId,
      getPlayerNameDraft: () => playerNameDraft,
      getEffectivePlayerName,
      shouldAgainButtonUseFullReset: () => resultScreenAgainIsFullReset,
      retryPublicMatchFromResult,
      resetAllForReplay: () => {
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
        privateRoomHostParticipantId = null;
        myParticipantId = null;
        privateRoomInviteUrl = null;
        socket?.disconnect();
        socket = null;
        currentGameMode = null;
        studyCards = [];
        lobbyPlayersList = [];
        matchTeamPlayMode = null;
        matchHeartsPerPlayerSetting = null;
        resetPrivateRoomTeamLobbyClientState();
      },
      backToPrivateRoom: (roomCode, name) => {
        const modeForRejoin = currentGameMode ?? "direct";
        const subcategoryForRejoin =
          modeForRejoin === "study_then_quiz" ? selectedSubcategoryKey : null;
        const lessonForRejoin =
          modeForRejoin === "lesson" ? selectedLessonMatchId : undefined;
        phase = "matchmaking";
        privateRoomCodeState = roomCode;
        privateRoomInviteUrl = `${window.location.origin}?room=${roomCode}`;
        lobbyNotice = "جاري العودة إلى الغرفة الخاصة...";
        privateReadyPending = false;
        privateReadyTargetState = null;
        render();
        connectSocket(
          name,
          modeForRejoin,
          subcategoryForRejoin,
          selectedDifficultyMode,
          "private_join",
          roomCode,
          lessonForRejoin,
        );
      },
      returnToHomeFromSearch,
      getSocket: () => socket,
      applyMatchStateSnapshotFromServer,
      setPhase: (p) => { phase = p; },
      setMatchLessonReviewIndex: (v) => { matchLessonReviewIndex = v; },
      render,
    });
    return;
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
    const teamSuffix =
      privateRoomTeamPlayModeState === "teams_first_answer"
        ? " · فرق (أول إجابة)"
        : privateRoomTeamPlayModeState === "teams_captain_approval"
          ? " · فرق (الكابتن)"
          : "";
    elMode.textContent =
      currentGameMode === "direct"
        ? `غرفة خاصة (${privateRoomCodeState}) — نمط مباشر${teamSuffix}`
        : currentGameMode === "lesson"
          ? `غرفة خاصة (${privateRoomCodeState}) — درس في تحدٍ${teamSuffix}`
          : `غرفة خاصة (${privateRoomCodeState}) — مراجعة ثم أسئلة${teamSuffix}`;
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

/** حالة الجاهزية/الفرق للغرفة الخاصة — تُعرض في اللوبي وفي شاشة المطابقة عند وجود كود غرفة. */
function getPrivateRoomFlowStatusText(): string {
  const teamBlocking =
    privateRoomTeamPlayModeState !== "individual" &&
    Boolean(privateRoomTeamsLobbyState) &&
    privateRoomUnassignedIds.length > 0;
  if (teamBlocking) {
    return "وضع الفرق: عيّن كل اللاعبين في فرق قبل بدء العد التنازلي.";
  }
  const allReady = lobbyPlayersList.length > 0 && lobbyPlayersList.every((p) => p.ready);
  return allReady
    ? "الجميع جاهزون. جاري بدء الجولة..."
    : "بانتظار جاهزية جميع اللاعبين في الغرفة...";
}

function updatePrivateLobbyFlowStatusDom(): void {
  const el = app.querySelector<HTMLParagraphElement>("#private-lobby-flow-status");
  if (!el) return;
  el.textContent = getPrivateRoomFlowStatusText();
}

function syncMatchmakingStatusText(): void {
  const el = app.querySelector<HTMLParagraphElement>("#mm-status");
  if (soloLearningPending) {
    if (el) el.textContent = "جاري تجهيز جولتك الفردية…";
    return;
  }
  if (privateRoomCodeState) {
    const text = getPrivateRoomFlowStatusText();
    if (el) el.textContent = text;
    updatePrivateLobbyFlowStatusDom();
    return;
  }
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
    const isMe = playerIsMe(p);
    row.className = `players-panel__row ${isMe ? "players-panel__row--me" : ""}`;
    const points = p.skillPoints ?? 0;
    const teamTag =
      p.teamId && matchTeamPlayMode ? ` · ${p.isCaptain ? "كابتن" : "عضو فريق"}` : "";
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
    row.innerHTML = `<span>${escapeHtml(p.name)}${isMe ? " (أنت)" : ""}</span><span>${p.eliminated ? "خرج" : "نشط"} · ❤️ ${p.hearts} · ⭐ ${points} · ${keysShown}${stacks}${teamTag}${roundTag}${bonus}</span>`;
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
    const meLb =
      (row.participantId && myParticipantId && row.participantId === myParticipantId) ||
      Boolean(row.userId && accountUserId() && row.userId === accountUserId());
    item.innerHTML = `<span>${medal} #${row.rank} ${escapeHtml(row.name)}${meLb ? " (أنت)" : ""}</span><span>⭐ ${row.skillPoints}</span>`;
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
  return getEffectivePlayerName(playerNameDraft);
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

function openSavedLessonsLibraryScreen(): void {
  phase = "saved_lessons_library";
  savedLessonDetailId = null;
  savedLessonsLoading = true;
  savedLessonsLibraryErr = "";
  render();
  void fetchSavedLessonsList().then((r) => {
    savedLessonsLoading = false;
    if (r.ok) savedLessonsRows = r.lessons ?? [];
    else savedLessonsLibraryErr = "تعذر تحميل المكتبة.";
    render();
  });
}

function exitLessonPlaybackToHub(): void {
  clearTimer();
  resetLessonState();
  const target = lessonSoloPlaybackReturnTarget;
  lessonSoloPlaybackReturnTarget = "lesson_menu";

  if (target === "saved_lessons_library") {
    openSavedLessonsLibraryScreen();
    return;
  }

  if (target === "custom_lesson") {
    phase = "custom_lesson";
    render();
    return;
  }

  lessonBrowseStep = "lesson_hub";
  phase = "lesson_menu";
}

/** إنهاء الدرس من شاشة `lesson_done` — يوحّد التنقل مع `exitLessonPlaybackToHub`. */
function finishLessonFromDoneScreen(): void {
  if (lessonSoloPlaybackReturnTarget === "custom_lesson") {
    customLessonPreviewLesson = null;
    customLessonValidatedBody = null;
    customLessonSessionToken = null;
    customLessonErr = "";
    customLessonMsg = "";
  }
  exitLessonPlaybackToHub();
  if (phase === "lesson_menu") {
    void fetchLessonBrowse()
      .then(() => {
        render();
      })
      .catch(() => {
        render();
      });
  }
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

function beginLessonPlayback(
  data: LessonPlaybackPayload,
  returnTarget?: LessonSoloPlaybackReturnTarget,
): void {
  if (returnTarget !== undefined) {
    lessonSoloPlaybackReturnTarget = returnTarget;
  }
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

function lessonRestReviewItems(): ReviewItem[] {
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
    beginLessonPlayback(data.lesson, "lesson_menu");
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

/** تقدير تقريبي لعدد الأيام المتبقية قبل انتهاء صلاحية الدرس المحفوظ */
function savedLessonWholeDaysRemaining(expiresAtIso: string): number {
  const end = new Date(expiresAtIso).getTime();
  return Math.max(0, Math.ceil((end - Date.now()) / 86_400_000));
}

function savedLessonExpiryCaption(expiresAtIso: string): string {
  const n = savedLessonWholeDaysRemaining(expiresAtIso);
  if (n <= 0) return "سيتم حذفه قريباً.";
  if (n === 1) return "سيتم حذفه بعد يوم واحد.";
  if (n === 2) return "سيتم حذفه بعد يومين.";
  return `سيتم حذفه بعد ${n} أيام.`;
}

/** إيموجي المكتبة للعرض؛ الفراغ يُعرَض كتاباً افتراضياً */
function savedLessonLibraryIconDisplay(icon: string | null | undefined): string {
  const s = icon?.trim();
  return s && s.length > 0 ? escapeHtml(s) : "📖";
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
  return findMeInPlayers(currentMatchPlayers)?.keys ?? 0;
}

function patchMyKeysCount(next: number): void {
  currentMatchPlayers = currentMatchPlayers.map((p) =>
    playerIsMe(p) ? { ...p, keys: Math.max(0, next) } : p,
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

/** رسالة انقطاع/استئناف مرئية أثناء اللعب أو المذاكرة (لا يعتمد على #lobby-notice وحده). */
function surfaceGameplayConnectionMessage(message: string): void {
  if (phase === "playing") {
    const st = app.querySelector<HTMLParagraphElement>("#status");
    if (st) st.textContent = message;
    showGameToast(message);
    return;
  }
  if (phase === "studying") {
    const el = app.querySelector<HTMLParagraphElement>("#study-ready-state");
    if (el) el.textContent = message;
    showGameToast(message);
    return;
  }
  if (phase === "countdown" || phase === "match_lesson_review") {
    showGameToast(message);
  }
}

function mergeKeysFromServerList(
  list: Array<{
    participantId?: string;
    userId?: string | null;
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
    opts?.keyRewardGlow ? (findMeInPlayers(currentMatchPlayers)?.keys ?? 0) : 0;
  currentMatchPlayers = currentMatchPlayers.map((old) => {
    const n = findServerPlayerRow(list, old);
    if (!n) return old;
    const nx = n as typeof n & { teamId?: string | null; isCaptain?: boolean };
    return {
      ...old,
      ...(n.participantId !== undefined ? { participantId: n.participantId } : {}),
      ...(n.name !== undefined ? { name: n.name } : {}),
      ...(n.hearts !== undefined ? { hearts: n.hearts } : {}),
      ...(n.eliminated !== undefined ? { eliminated: n.eliminated } : {}),
      ...(n.isSpectator !== undefined ? { isSpectator: n.isSpectator } : {}),
      ...(n.skillPoints !== undefined ? { skillPoints: n.skillPoints } : {}),
      ...(n.lastAward !== undefined ? { lastAward: n.lastAward } : {}),
      ...(n.keys !== undefined ? { keys: n.keys } : {}),
      ...(n.skillBoostStacks !== undefined ? { skillBoostStacks: n.skillBoostStacks } : {}),
      ...(nx.teamId !== undefined ? { teamId: nx.teamId } : {}),
      ...(nx.isCaptain !== undefined ? { isCaptain: nx.isCaptain } : {}),
    };
  });
  refreshKeysBadge();
  refreshAbilityAffordability();
  if (opts?.keyRewardGlow) {
    const nextMe = findMeInPlayers(currentMatchPlayers)?.keys ?? prevMe;
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
      participantId?: string;
      userId?: string | null;
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
            playerIsMe(p) ? { ...p, skillBoostStacks: ack.skillBoostStacks } : p,
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
      if (playerIsMe(p)) continue;
      if (!p.participantId) continue;
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
          runAbility(
            a1,
            "ability_heart_attack",
            { targetParticipantId: p.participantId! },
            -abilityCostsState.heartAttack,
          );
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

type StoredMatchResume = {
  matchId: string;
  participantId: string;
  resumeSecret: string;
  reconnectGraceMs: number;
  storedAt: number;
  expiresAt: number;
};

function readStoredMatchResume(): StoredMatchResume | null {
  try {
    const t = sessionStorage.getItem(FAHEM_MATCH_RESUME_KEY);
    if (!t) return null;
    const o = JSON.parse(t) as StoredMatchResume;
    if (!o?.matchId || !o?.participantId || !o?.resumeSecret) return null;
    if (typeof o.storedAt !== "number") o.storedAt = Date.now();
    if (typeof o.reconnectGraceMs !== "number") o.reconnectGraceMs = CLIENT_RECONNECT_GRACE_MS;
    if (typeof o.expiresAt !== "number") o.expiresAt = o.storedAt + o.reconnectGraceMs;
    return o;
  } catch {
    return null;
  }
}

function writeStoredMatchResume(
  r: Omit<StoredMatchResume, "storedAt"> & { storedAt?: number },
): void {
  const row: StoredMatchResume = {
    ...r,
    storedAt: r.storedAt ?? Date.now(),
    reconnectGraceMs: r.reconnectGraceMs ?? CLIENT_RECONNECT_GRACE_MS,
    expiresAt: r.expiresAt ?? ((r.storedAt ?? Date.now()) + (r.reconnectGraceMs ?? CLIENT_RECONNECT_GRACE_MS)),
  };
  sessionStorage.setItem(FAHEM_MATCH_RESUME_KEY, JSON.stringify(row));
}

function clearStoredMatchResume(): void {
  try {
    sessionStorage.removeItem(FAHEM_MATCH_RESUME_KEY);
  } catch {
    /* ignore */
  }
}

function canUseReconnect(): boolean {
  return reconnectRuntimeActive || reconnectAttemptInFlight;
}

function clearReconnectMultiplayerRuntime(): void {
  reconnectRuntimeActive = false;
  reconnectAttemptInFlight = false;
  reconnectPromptState = null;
  clearStoredMatchResume();
}

function refreshReconnectPromptStateFromStorage(): void {
  const raw = readStoredMatchResume();
  if (!raw) {
    reconnectPromptState = null;
    return;
  }
  if (Date.now() > raw.expiresAt) {
    clearReconnectMultiplayerRuntime();
    reconnectPromptState = null;
    return;
  }
  reconnectPromptState = {
    matchId: raw.matchId,
    participantId: raw.participantId,
    expiresAt: raw.expiresAt,
  };
}

function applyTeamVoteBadgesToOptionButtons(): void {
  const opts = app.querySelector<HTMLDivElement>("#opts");
  if (!opts) return;
  opts.querySelectorAll<HTMLButtonElement>("button.option-btn[data-option-index]").forEach((btn) => {
    const idx = Number(btn.dataset.optionIndex);
    if (!Number.isFinite(idx)) return;
    const c = teamVoteCountsByChoice[idx];
    const tag = btn.querySelector<HTMLSpanElement>(".option-btn__vote-count");
    if (!tag) return;
    if (c && c > 0) {
      tag.textContent = String(c);
      tag.hidden = false;
    } else {
      tag.textContent = "";
      tag.hidden = true;
    }
  });
}

function bindQuestionOptionsUi(s: Socket, q: IncomingQuestionPayload): void {
  syncClock(q.serverNow);
  if (spectatorEligible && !spectatorFollowing) return;
  lessonMatchStudyNav = false;
  teamVoteCountsByChoice = {};
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
  teamRoundUiLocked = false;
  teamRoundCaptainSubmitted = false;
  captainTapPendingIndex = null;
  phase = "playing";
  if (!app.querySelector("#q-text")) render();
  const text = app.querySelector<HTMLParagraphElement>("#q-text");
  const opts = app.querySelector<HTMLDivElement>("#opts");
  const status = app.querySelector<HTMLParagraphElement>("#status");
  if (!text || !opts) return;
  if (status) status.classList.remove("status--team-lock", "status--team-votes");
  text.textContent = q.prompt;
  const prevFocusOpts = document.activeElement;
  if (prevFocusOpts instanceof HTMLElement && opts.contains(prevFocusOpts)) prevFocusOpts.blur();
  opts.innerHTML = "";
  let answered = false;
  const meRow = findMeInPlayers(currentMatchPlayers);
  const tmode = matchTeamPlayMode;
  const myTeamId = meRow?.teamId ?? null;
  const amCaptain = Boolean(meRow?.isCaptain);
  const disableAllOptionButtons = (): void => {
    opts.querySelectorAll("button").forEach((btn) => {
      const htmlBtn = btn as HTMLButtonElement;
      htmlBtn.disabled = true;
      htmlBtn.classList.add("option-btn--disabled");
      htmlBtn.classList.remove("option-btn--pressed");
    });
  };
  const highlightSelected = (choiceIdx: number): void => {
    opts.querySelectorAll("button").forEach((btn, bi) => {
      btn.classList.toggle("option-btn--selected", bi === choiceIdx);
    });
  };
  q.options.forEach((label, idx) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "option-btn";
    b.dataset.optionIndex = String(idx);
    const lab = document.createElement("span");
    lab.className = "option-btn__label";
    lab.textContent = label;
    const voteTag = document.createElement("span");
    voteTag.className = "option-btn__vote-count";
    voteTag.hidden = true;
    b.appendChild(lab);
    b.appendChild(voteTag);
    const clearPressed = (): void => {
      b.classList.remove("option-btn--pressed");
    };
    const submitAnswer = (): void => {
      if (spectatorFollowing) {
        if (status) status.textContent = "أنت في وضع المشاهد ولا يمكنك إرسال إجابة.";
        return;
      }
      if (currentQuestionId == null) {
        if (status) status.textContent = "تعذر تحديد السؤال الحالي. انتظر التحديث التالي.";
        return;
      }
      if (teamRoundUiLocked || teamRoundCaptainSubmitted) {
        if (status) status.textContent = "إجابة الفريق مقفلة لهذا السؤال.";
        return;
      }

      if (!tmode) {
        if (answered) return;
        answered = true;
        b.classList.add("option-btn--selected");
        if (status) status.textContent = "تم إرسال إجابتك.";
        s.emit("answer", {
          questionId: currentQuestionId,
          choiceIndex: idx,
        }, (ack?: { ok?: boolean }) => {
          if (!ack?.ok) {
            answered = false;
            b.classList.remove("option-btn--selected");
            opts.querySelectorAll("button").forEach((ob) => { ob.disabled = false; });
            if (status) status.textContent = "تعذر إرسال الإجابة. حاول مرة أخرى.";
          }
        });
        disableAllOptionButtons();
        return;
      }

      if (tmode === "teams_first_answer") {
        if (!myTeamId) {
          if (status) status.textContent = "يجب الانضمام إلى فريق قبل إرسال الإجابة.";
          return;
        }
        if (answered) return;
        answered = true;
        b.classList.add("option-btn--selected");
        if (status) status.textContent = "أرسلت إجابة الفريق.";
        s.emit("answer", {
          questionId: currentQuestionId,
          choiceIndex: idx,
        }, (ack?: { ok?: boolean }) => {
          if (!ack?.ok) {
            answered = false;
            b.classList.remove("option-btn--selected");
            opts.querySelectorAll("button").forEach((ob) => { ob.disabled = false; });
            if (status) status.textContent = "تعذر إرسال إجابة الفريق. حاول مرة أخرى.";
          }
        });
        disableAllOptionButtons();
        return;
      }

      if (!myTeamId) {
        if (status) status.textContent = "يجب الانضمام إلى فريق قبل التصويت أو الإرسال.";
        return;
      }
      if (amCaptain) {
        if (captainTapPendingIndex === idx) {
          s.emit("answer", {
            questionId: currentQuestionId,
            choiceIndex: idx,
          }, (ack?: { ok?: boolean }) => {
            if (!ack?.ok) {
              teamRoundCaptainSubmitted = false;
              b.classList.remove("option-btn--selected");
              opts.querySelectorAll("button").forEach((ob) => { ob.disabled = false; });
              if (status) status.textContent = "تعذر إرسال إجابة الفريق. حاول مرة أخرى.";
            }
          });
          captainTapPendingIndex = null;
          teamRoundCaptainSubmitted = true;
          if (status) status.textContent = "أرسل فريقك الإجابة.";
          disableAllOptionButtons();
        } else {
          captainTapPendingIndex = idx;
          s.emit("answer", {
            questionId: currentQuestionId,
            choiceIndex: idx,
          }, (ack?: { ok?: boolean }) => {
            if (!ack?.ok) {
              captainTapPendingIndex = null;
              highlightSelected(-1);
              if (status) status.textContent = "تعذر إرسال التصويت. حاول مرة أخرى.";
            }
          });
          highlightSelected(idx);
          if (status) status.textContent = "اضغط نفس الخيار مرة ثانية للإرسال النهائي.";
        }
        return;
      }

      s.emit("answer", {
        questionId: currentQuestionId,
        choiceIndex: idx,
      }, (ack?: { ok?: boolean }) => {
        if (!ack?.ok) {
          highlightSelected(-1);
          if (status) status.textContent = "تعذر إرسال التصويت. حاول مرة أخرى.";
        }
      });
      highlightSelected(idx);
      if (status) status.textContent = "سُجّل تصويتك. انتظر موافقة الكابتن.";
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
  applyTeamVoteBadgesToOptionButtons();
  if (status) status.textContent = "";
  const spectatorBadge = app.querySelector<HTMLParagraphElement>("#spectator-badge");
  if (spectatorBadge) {
    spectatorBadge.textContent = spectatorFollowing ? "وضع المشاهد: يمكنك المتابعة بدون إجابة." : "";
  }
  startQuestionTimer();
  if (app.querySelector("#ab-boost")) {
    renderPlayingPlayersPanel();
    bindPlayingAbilityUi(s);
  }
}

/** مزامنة حزمة المذاكرة من لقطة الاستئناف أو من أحداث `study_phase` / `round_ready_window`. */
function applyStudyBundleFromServer(study: Record<string, unknown>): void {
  const sp = study.study_phase as Record<string, unknown> | undefined;
  const rrw = study.round_ready_window as Record<string, unknown> | undefined;
  const rrs = study.round_ready_state as Record<string, unknown> | undefined;
  if (sp) {
    syncClock(sp.serverNow as number | undefined);
    if (typeof sp.roundToken === "string") activeStudyRoundToken = sp.roundToken;
    if (typeof sp.macroRound === "number") activeStudyMacroRound = sp.macroRound;
    studyCards = Array.isArray(sp.cards) ? (sp.cards as typeof studyCards) : [];
    studyEndsAt = Number(sp.endsAt) || studyEndsAt;
    studyStartsAt = Number(sp.startsAt) || Number(sp.serverNow) || nowSynced();
    studyDurationMs = Math.max(1000, studyEndsAt - studyStartsAt);
    phase = "studying";
    studyPhaseState = "study_content";
    const isLessonStudy = sp.scope === "lesson";
    lessonMatchStudyNav = isLessonStudy && studyCards.length > 0;
    if (isLessonStudy) {
      readyBtnState = "idle";
      if (typeof sp.lessonSectionIndex === "number" && typeof sp.lessonSectionCount === "number") {
        lessonMatchSectionMeta = {
          index: sp.lessonSectionIndex,
          count: sp.lessonSectionCount,
          title: (sp.lessonSectionTitle as string | null) ?? null,
        };
      } else {
        lessonMatchSectionMeta = { index: 0, count: 0, title: null };
      }
      lessonMatchStudyCardIndex = 0;
    } else {
      lessonMatchSectionMeta = { index: 0, count: 0, title: null };
    }
  }
  if (rrw) {
    syncClock(rrw.serverNow as number | undefined);
    phase = "studying";
    activeStudyRoundToken = (rrw.roundToken as string | undefined) ?? activeStudyRoundToken;
    activeStudyMacroRound = (rrw.macroRound as number | undefined) ?? activeStudyMacroRound;
    studyPhaseState = "ready_window";
    readyBtnState = "window_open";
    studyEndsAt = Number(rrw.endsAt) || studyEndsAt;
    studyStartsAt = Number(rrw.startsAt) || Number(rrw.serverNow) || nowSynced();
    studyDurationMs = Math.max(1000, studyEndsAt - studyStartsAt);
  }
  if (sp || rrw) {
    render();
  }
  const readyBtn = app.querySelector<HTMLButtonElement>("#round-ready-btn");
  const readyStateEl = app.querySelector<HTMLParagraphElement>("#study-ready-state");
  if (readyBtn && rrw) {
    readyBtn.disabled = false;
    readyBtn.textContent = "جاهز للجولة (تخطي العداد عند جاهزية الجميع)";
  }
  if (readyStateEl && rrw) {
    readyStateEl.textContent = "نافذة الجاهزية مفتوحة الآن.";
  }
  if (rrs && phase === "studying" && readyStateEl) {
    const n = (rrs.readyParticipantIds as string[] | undefined)?.length ?? 0;
    const total = typeof rrs.totalActive === "number" ? rrs.totalActive : 0;
    readyStateEl.textContent = `جاهزية اللاعبين: ${n}/${total}`;
  }
  startStudyTimer();
}

function applyGameStartedClientPayload(payload: {
  gameMode?: GameMode;
  teamPlayMode?: "individual" | "teams_first_answer" | "teams_captain_approval";
  /** إعداد المضيف في الغرفة الخاصة؛ يحدد عدد رموز القلب في الواجهة. */
  heartsPerPlayer?: number;
  revealKeysActive?: boolean;
  keysAttacksEnabled?: boolean;
  abilityCosts?: Partial<AbilityCostsPayload> | null;
  abilityToggles?: Partial<AbilityTogglesPayload> | null;
  players?: Array<{
    participantId?: string;
    userId?: string | null;
    name: string;
    hearts: number;
    eliminated: boolean;
    isSpectator?: boolean;
    skillPoints?: number;
    lastAward?: number;
    keys?: number;
    skillBoostStacks?: number;
    teamId?: string | null;
    isCaptain?: boolean;
  }>;
}): void {
  if (payload.gameMode) currentGameMode = payload.gameMode;
  matchTeamPlayMode =
    payload.teamPlayMode && payload.teamPlayMode !== "individual" ? payload.teamPlayMode : null;
  matchHeartsPerPlayerSetting =
    typeof payload.heartsPerPlayer === "number" ? payload.heartsPerPlayer : null;
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
      teamId: p.teamId ?? null,
      isCaptain: Boolean(p.isCaptain),
    }));
    syncMyParticipantIdFromPlayers(payload.players);
    const playerCount = payload.players.length;
    reconnectRuntimeActive = isPrivateRoomSession || playerCount >= 2;
    if (!reconnectRuntimeActive) {
      clearStoredMatchResume();
    }
  } else {
    reconnectRuntimeActive = false;
    clearStoredMatchResume();
  }
  soloLearningPending = false;
  privateRoomCodeState = null;
  privateRoomInviteUrl = null;
  resetPrivateRoomTeamLobbyClientState();
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
}

const snapshotApplyDeps: SnapshotApplyDeps = {
  syncClock,
  applyGameStartedClientPayload: (gs) =>
    applyGameStartedClientPayload(gs as Parameters<typeof applyGameStartedClientPayload>[0]),
  applyKeysRoomSlice: (ks, opts) =>
    applyKeysRoomSlice(ks as Parameters<typeof applyKeysRoomSlice>[0], opts),
  applyStudyBundleFromServer,
  getPhase: () => phase,
  queryStudyReadyStateEl: () => app.querySelector<HTMLParagraphElement>("#study-ready-state"),
  bindQuestionOptionsUi: (sock, q) => bindQuestionOptionsUi(sock, q as IncomingQuestionPayload),
  getMatchTeamPlayMode: () => matchTeamPlayMode,
  findMeInPlayers,
  getCurrentMatchPlayers: () => currentMatchPlayers,
  setTeamVoteCountsByChoice: (next) => {
    teamVoteCountsByChoice = next;
  },
  setCaptainTapPendingIndex: (v) => {
    captainTapPendingIndex = v;
  },
  applyTeamVoteBadgesToOptionButtons,
  queryStatusEl: () => app.querySelector<HTMLParagraphElement>("#status"),
  render,
  surfaceGameplayConnectionMessage,
  queryLobbyNoticeEl: () => app.querySelector<HTMLParagraphElement>("#lobby-notice"),
};

function applyMatchStateSnapshotFromServer(s: Socket, snap: Record<string, unknown>): void {
  applyMatchStateSnapshotFromServerWithDeps(snapshotApplyDeps, s, snap);
}

/** نتائج لا نعرض معها زر مراجعة الأسئلة رغم أن الخادم قد يرسل `lessonReview` في أنماط مباشر/مذاكرة. */
function shouldSuppressLessonReviewOnGameOver(payload: {
  outcomeType?: string;
  reason?: string;
}): boolean {
  if (payload.reason === "no_questions" || payload.outcomeType === "no_questions") return true;
  if (payload.outcomeType === "server_shutdown" || payload.reason === "server_shutdown") return true;
  if (
    payload.outcomeType === "server_aborted" ||
    payload.reason === "db_error" ||
    payload.reason === "runtime_error"
  ) {
    return true;
  }
  if (payload.outcomeType === "solo_incomplete" || payload.outcomeType === "solo_study_incomplete") {
    return true;
  }
  if (payload.outcomeType === "team_match") return true;
  return false;
}

/** ناتج `game_over` — يُستدعى من `attachGameplaySocketListeners` مع تنظيف عدّاد اللوبي من سياق المقبس. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- لقطة خادم مرنة؛ الحقول تُفرّع يدوياً كالسابق
function handleGameplayGameOver(payload: any, clearLobbyCountdown: () => void): void {
  resultScreenAgainIsFullReset = false;
  clearReconnectMultiplayerRuntime();
  matchHeartsPerPlayerSetting = null;
  clearLobbyCountdown();
  clearTimer();
  const lr = payload.lessonReview;
  const hasLessonReviewPayload = Array.isArray(lr) && lr.length > 0;
  const suppressLessonReview = shouldSuppressLessonReviewOnGameOver(payload);
  matchLessonReviewItems =
    !suppressLessonReview && hasLessonReviewPayload
      ? (lr as NonNullable<typeof matchLessonReviewItems>)
      : null;
  matchLessonReviewIndex = 0;
  phase = "result";
  render();
  const me = findMeInPlayers(payload.players);
  currentMatchPlayers = payload.players.map((p: (typeof currentMatchPlayers)[number]) => ({ ...p }));
  syncMyParticipantIdFromPlayers(payload.players);
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
    resultScreenAgainIsFullReset = true;
    return;
  }
  if (
    payload.outcomeType === "server_shutdown" ||
    payload.reason === "server_shutdown"
  ) {
    title.textContent = "توقف الخادم مؤقتًا";
    body.textContent =
      "انتهت الجلسة لأن الخادم يُحدَّث أو يُغلق. يمكنك بدء جولة جديدة بعد لحظات.";
    if (stats) stats.classList.add("hidden");
    if (againBtn) againBtn.textContent = "العودة للقائمة";
    applyResultScreenPresentation("empty", "");
    resultScreenAgainIsFullReset = true;
    return;
  }
  if (
    payload.outcomeType === "server_aborted" ||
    payload.reason === "db_error" ||
    payload.reason === "runtime_error"
  ) {
    title.textContent = "تعذر إكمال المباراة";
    body.textContent =
      "حدث خطأ في الخادم أثناء الجولة. إذا تكرر ذلك، أعد المحاولة لاحقًا.";
    if (stats) stats.classList.add("hidden");
    if (againBtn) againBtn.textContent = "العودة والمحاولة";
    applyResultScreenPresentation("empty", "");
    resultScreenAgainIsFullReset = true;
    return;
  }
  if (
    payload.outcomeType === "solo_incomplete" ||
    payload.outcomeType === "solo_study_incomplete"
  ) {
    title.textContent = loseTitle;
    body.textContent = loseCopy;
    if (againBtn) againBtn.textContent = "حاول مرة أخرى";
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
    applyResultScreenPresentation("lose", "💔");
    return;
  }
  if (payload.outcomeType === "team_match") {
    matchTeamPlayMode = null;
    const teamExtra = app.querySelector<HTMLDivElement>("#res-team-extra");
    if (teamExtra) {
      const rows = (payload.teamLeaderboard ?? [])
        .map(
          (r: { medal?: string | null; rank: number; displayName: string; teamScore: number }) =>
            `<div class="players-panel__row"><span>${r.medal === "gold" ? "🥇" : r.medal === "silver" ? "🥈" : r.medal === "bronze" ? "🥉" : `#${r.rank}`} ${escapeHtml(r.displayName)}</span><span>⭐ ${r.teamScore}</span></div>`,
        )
        .join("");
      const stars = (payload.starsOfTheMatch ?? [])
        .map(
          (r: { rank: number; name: string; individualPoints: number }) =>
            `<div class="players-panel__row"><span>#${r.rank} ${escapeHtml(r.name)}</span><span>⭐ ${r.individualPoints}</span></div>`,
        )
        .join("");
      teamExtra.innerHTML = `
            <section class="res-team-block">
              <h3 class="res-team-block__title">ترتيب الفرق</h3>
              <div class="players-panel res-team-block__panel">${rows || "<p class=\"text-slate-400 text-sm\">لا بيانات.</p>"}</div>
            </section>
            <section class="res-team-block res-team-block--stars">
              <h3 class="res-team-block__title">نجوم المباراة</h3>
              <div class="players-panel res-team-block__panel">${stars || "<p class=\"text-slate-400 text-sm\">لا بيانات.</p>"}</div>
            </section>`;
      teamExtra.classList.remove("hidden");
    }
    const wt = payload.winningTeams ?? [];
    title.textContent = "انتهت المباراة — وضع الفرق";
    body.textContent =
      wt.length > 0
        ? `الفريق (الفرق) الأعلى نقاطاً: ${wt.map((t: { displayName?: string }) => escapeHtml(t.displayName ?? "")).join("، ")}.`
        : tieCopy;
    if (againBtn) againBtn.textContent = "العب مجددًا";
    if (stats) {
      if (me) {
        stats.innerHTML = `<span class="result-screen__stat-chip">⭐ نقاطك: ${me.skillPoints ?? 0}</span>`;
        stats.classList.remove("hidden");
      } else {
        stats.classList.add("hidden");
        stats.innerHTML = "";
      }
    }
    const lbBox = app.querySelector<HTMLDivElement>("#res-leaderboard");
    if (lbBox) lbBox.innerHTML = "";
    const myTeamIdForRes =
      me && "teamId" in me ? (me as { teamId?: string | null }).teamId : null;
    const iTopTeam = Boolean(
      myTeamIdForRes && wt.some((t: { teamId?: string }) => String(t.teamId) === String(myTeamIdForRes)),
    );
    let screenKind: ResultScreenKind = "tie";
    let emoji = "🏆";
    if (wt.length === 0) {
      screenKind = "tie";
      emoji = "🤝";
    } else if (iTopTeam) {
      screenKind = "win";
      emoji = "🎉";
    } else {
      screenKind = "lose";
      emoji = "💔";
    }
    applyResultScreenPresentation(screenKind, emoji);
    return;
  }
  const winners = payload.winners ?? (payload.winner ? [payload.winner] : []);
  const iAmWinner = winners.some(
    (w: { participantId?: string; userId?: string | null }) =>
      (w.participantId && myParticipantId && w.participantId === myParticipantId) ||
      Boolean(w.userId && accountUserId() && w.userId === accountUserId()),
  );
  let kind: ResultScreenKind = "tie";
  let emojiForFallback = "🤝";
  if (iAmWinner) {
    kind = "win";
    emojiForFallback = "🎉";
    if (winners.length > 1) {
      title.textContent = winTitle;
      body.textContent = `${winCopy} — فائزون معك: ${winners.map((w: { name: string }) => w.name).join("، ")}`;
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
        : `${loseCopy} (فائزون مشتركون: ${winners.map((w: { name: string }) => w.name).join("، ")})`;
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
}

/** إعادة جولة علنية أو فردية من شاشة النتيجة دون العودة لشاشة الاسم. */
function retryPublicMatchFromResult(): void {
  if (resultScreenAgainIsFullReset) return;
  const name = getEffectivePlayerName(playerNameDraft);
  storePlayerName(name);
  playerNameDraft = name;
  const mode: GameMode = currentGameMode ?? selectedModeInName;

  matchLessonReviewItems = null;
  matchLessonReviewIndex = 0;
  myParticipantId = null;
  studyCards = [];
  lobbyPlayersList = [];
  matchTeamPlayMode = null;
  matchHeartsPerPlayerSetting = null;
  privateReadyPending = false;
  privateReadyTargetState = null;
  socket?.disconnect();
  socket = null;
  resetPrivateRoomTeamLobbyClientState();

  if (!mode || (lastSocketJoinKind !== "solo" && lastSocketJoinKind !== "public")) {
    phase = "name";
    nameFlowStep = "mode";
    render();
    return;
  }

  if (lastSocketJoinKind === "solo") {
    soloLearningPending = true;
    lobbyNotice =
      mode === "direct"
        ? `جاري بدء التعلم الفردي... (${difficultyModeLabelAr(selectedDifficultyMode)})`
        : mode === "lesson"
          ? "جاري بدء التعلم الفردي... (درس في تحدٍ)"
          : `جاري بدء التعلم الفردي... (${selectedSubcategoryLabel ?? selectedSubcategoryKey ?? ""} - ${difficultyModeLabelAr(selectedDifficultyMode)})`;
    phase = "matchmaking";
    render();
    connectSoloSocket(
      name,
      mode,
      mode === "study_then_quiz" ? selectedSubcategoryKey : null,
      selectedDifficultyMode,
      mode === "lesson" ? selectedLessonMatchId : undefined,
    );
    return;
  }

  phase = "matchmaking";
  if (mode === "direct") {
    lobbyNotice = `جاري الاتصال بالخادم... (${difficultyModeLabelAr(selectedDifficultyMode)})`;
    render();
    connectSocket(name, "direct", null, selectedDifficultyMode, "public");
    return;
  }
  if (mode === "study_then_quiz") {
    lobbyNotice = `جاري الاتصال بالخادم... (${selectedSubcategoryLabel ?? selectedSubcategoryKey ?? ""} - ${difficultyModeLabelAr(selectedDifficultyMode)})`;
    render();
    connectSocket(name, "study_then_quiz", selectedSubcategoryKey, selectedDifficultyMode, "public");
    return;
  }
  if (mode === "lesson" && selectedLessonMatchId != null && selectedLessonMatchId > 0) {
    lobbyNotice = "جاري الاتصال بالخادم والبحث عن منافسين لنفس الدرس…";
    render();
    connectSocket(name, "lesson", null, "mix", "public", undefined, selectedLessonMatchId);
    return;
  }

  phase = "name";
  nameFlowStep = "mode";
  render();
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
  resumePolicy: ResumePolicy = "none",
): void {
  const playerSessionId = getOrCreatePlayerSessionId();
  const flowToken = ++searchFlowToken;
  const joinFlowStartMs = performance.now();
  lastSocketJoinKind = joinKind;
  socket?.removeAllListeners();
  socket?.disconnect();
  reconnectRuntimeActive = false;

  currentGameMode = mode;
  if (joinKind === "public" || joinKind === "solo") {
    isPrivateRoomSession = false;
    lastPrivateRoomCode = null;
    privateRoomHostParticipantId = null;
  }
  if (joinKind === "private_create" || joinKind === "private_join") {
    resetPrivateRoomSyncStateForNewSocketIntent();
  }

  const s = createAuthedSocket();
  socket = s;
  myParticipantId = null;
  if (joinKind === "solo" || joinKind === "private_create") {
    clearReconnectMultiplayerRuntime();
  }
  let joinAckTimer: number | null = null;
  let joinCompleted = false;
  let connectionWaitTimer: number | null = null;
  let soloGameStartedWaitTimer: number | null = null;
  const JOIN_CONNECT_PHASE_MS = 20_000;
  const SOLO_GAME_STARTED_WAIT_MS = 20_000;

  const clearJoinFlowTimers = (): void => {
    if (joinAckTimer != null) {
      window.clearTimeout(joinAckTimer);
      joinAckTimer = null;
    }
    if (connectionWaitTimer != null) {
      window.clearTimeout(connectionWaitTimer);
      connectionWaitTimer = null;
    }
    if (soloGameStartedWaitTimer != null) {
      window.clearTimeout(soloGameStartedWaitTimer);
      soloGameStartedWaitTimer = null;
    }
  };

  const failBackToName = (msg: string): void => {
    if (flowToken !== searchFlowToken) return;
    myParticipantId = null;
    clearJoinFlowTimers();
    joinCompleted = true;
    soloLearningPending = false;
    if (joinKind === "private_create" || joinKind === "private_join") {
      privateRoomCodeState = null;
      privateRoomHostParticipantId = null;
      privateRoomInviteUrl = null;
      privateRoomVersionState = 0;
      privateQrDataUrl = null;
      privateReadyPending = false;
      privateReadyTargetState = null;
      isPrivateRoomSession = false;
      resetPrivateRoomTeamLobbyClientState();
      matchTeamPlayMode = null;
      matchHeartsPerPlayerSetting = null;
    }
    try {
      s.disconnect();
    } catch {
      /* ignore */
    }
    if (socket === s) {
      socket = null;
    }
    phase = "name";
    render();
    const errEl = document.querySelector<HTMLParagraphElement>("#join-err");
    if (errEl) errEl.textContent = msg;
  };

  attachServerDrainingListener(s, {
    getFlowToken: () => flowToken,
    getSearchFlowToken: () => searchFlowToken,
    failBackToName,
    disconnectSocket: () => {
      try {
        s.disconnect();
      } catch {
        /* ignore */
      }
    },
  });

  lobbyPlayersList = [];

  const DEFAULT_LOBBY_COUNTDOWN_SEC = 5;
  const lobbyCountdown = createLobbyCountdownController({
    getCdElement: () => app.querySelector<HTMLDivElement>("#cd"),
  });
  const startCountdownTicks = (initialLeft: number): void => {
    lobbyCountdown.start(initialLeft);
  };

  s.on("connect", async () => {
    if (connectionWaitTimer != null) {
      window.clearTimeout(connectionWaitTimer);
      connectionWaitTimer = null;
    }
    console.debug("[join-flow] click->connect_ms", Math.round(performance.now() - joinFlowStartMs), "socket", s.id);
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
    if (resumePolicy === "resume_only") {
      if (noticeEl) noticeEl.textContent = "جاري محاولة استعادة المباراة…";
      if (
        await tryResumeMatchAfterConnect(
          {
            getSearchFlowToken: () => searchFlowToken,
            readStoredMatchResume,
            clearReconnectMultiplayerRuntime,
            setReconnectAttemptInFlight: (v) => {
              reconnectAttemptInFlight = v;
            },
            applyReconnectSnapshot: (sock, snap) => {
              reconnectPromptState = null;
              applyMatchStateSnapshotFromServer(sock, snap);
            },
          },
          s,
          flowToken,
        )
      ) {
        clearJoinFlowTimers();
        joinCompleted = true;
        if (noticeEl) noticeEl.textContent = "تمت استعادة المباراة.";
        return;
      }
      failBackToName("تعذر استعادة المباراة. انتهت المهلة أو لم تعد الجلسة صالحة.");
      return;
    }
    joinAckTimer = window.setTimeout(() => {
      if (joinCompleted) return;
      failBackToName("انتهت مهلة انتظار رد الخادم على طلب الانضمام. تحقق من الشبكة ثم أعد المحاولة.");
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
        hostParticipantId?: string;
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
        if (ack?.error === "server_draining") {
          failBackToName("الخادم يُصفَّى للتحديث. حاول بعد قليل.");
          return;
        }
        failBackToName(
          ack?.message
          || (joinKind === "solo"
            ? "تعذر بدء التعلم الفردي. حاول مرة أخرى."
            : joinKind === "private_create" || joinKind === "private_join"
              ? "رفض الخادم طلب الغرفة الخاصة (تحقق من الكود أو الصلاحيات)."
              : "رفض الخادم طلب الدخول إلى البحث."),
        );
        return;
      }
      console.debug("[join-flow] connect->join_ack_ms", Math.round(performance.now() - joinFlowStartMs));
      if (joinKind === "private_create" || joinKind === "private_join") {
        applyPrivateLobbyJoinAck(joinKind, ack);
        return;
      }
      if (phase !== "matchmaking" && phase !== "private_room_lobby") {
        phase = "matchmaking";
        render();
      } else {
        const noticeEl2 = app.querySelector<HTMLParagraphElement>("#lobby-notice");
        if (noticeEl2) {
          noticeEl2.textContent = joinKind === "solo"
            ? "تم إنشاء الجولة الفردية. جاري البدء..."
            : "تم الدخول بنجاح. جاري البحث عن منافسين...";
        }
      }
      if (joinKind === "solo") {
        soloGameStartedWaitTimer = window.setTimeout(() => {
          if (flowToken !== searchFlowToken) return;
          failBackToName("تعذر بدء الجولة الفردية: انتهت مهلة انتظار بدء اللعب من الخادم.");
        }, SOLO_GAME_STARTED_WAIT_MS);
      }
      },
    );
  });

  s.on("connect_error", () => {
    if (joinCompleted) return;
    failBackToName("فشل اتصال المقبس (شبكة أو خادم). تحقق من الإنترنت ثم أعد المحاولة.");
  });

  s.on("disconnect", () => {
    updateConnectionBadge();
    const noticeEl = app.querySelector<HTMLParagraphElement>("#lobby-notice");
    const resume = readStoredMatchResume();
    const msg =
      resume &&
      (phase === "playing" ||
        phase === "studying" ||
        phase === "countdown" ||
        phase === "match_lesson_review")
        ? "انقطع الاتصال. جاري استعادة الاتصال بالمباراة…"
        : resume
          ? "انقطع الاتصال. جاري استعادة الاتصال بالمباراة…"
          : "انقطع الاتصال مؤقتًا... جاري إعادة الاتصال";
    if (noticeEl) noticeEl.textContent = msg;
    if (
      phase === "playing" ||
      phase === "studying" ||
      phase === "countdown" ||
      phase === "match_lesson_review"
    ) {
      surfaceGameplayConnectionMessage(msg);
    }
  });

  s.on("release_updated", (payload: { releaseVersion?: string }) => {
    handleReleaseVersionPush(payload?.releaseVersion);
  });

  s.on(
    "private_room_state",
    async (payload: PrivateRoomStateClientPayload) => {
      await applyPrivateRoomStateFromPayload(
        {
          getPrivateRoomCodeState: () => privateRoomCodeState,
          resetPrivateRoomSyncStateForNewSocketIntent,
          getPrivateRoomVersionState: () => privateRoomVersionState,
          setPrivateRoomVersionState: (v) => {
            privateRoomVersionState = v;
          },
          setPrivateRoomCodeState: (c) => {
            privateRoomCodeState = c;
          },
          setPrivateRoomHostParticipantId: (id) => {
            privateRoomHostParticipantId = id;
          },
          setCurrentGameMode: (m) => {
            currentGameMode = m;
          },
          setSelectedSubcategoryKey: (k) => {
            selectedSubcategoryKey = k;
          },
          applyLessonIdFromPrivateRoomPayload: (p) => {
            if (p.mode === "lesson" && p.lessonId != null && p.lessonId > 0) {
              selectedLessonMatchId = p.lessonId;
            }
          },
          setSelectedDifficultyMode: (d) => {
            selectedDifficultyMode = d;
          },
          setPrivateRoomQuestionMs: (n) => {
            privateRoomQuestionMs = n;
          },
          setPrivateRoomStudyPhaseMs: (n) => {
            privateRoomStudyPhaseMs = n;
          },
          setPrivateRoomTeamPlayModeState: (m) => {
            privateRoomTeamPlayModeState = m;
          },
          setPrivateRoomHeartsPerPlayerState: (n) => {
            privateRoomHeartsPerPlayerState = n;
          },
          setPrivateRoomTeamsLobbyState: (t) => {
            privateRoomTeamsLobbyState = t ?? null;
          },
          setPrivateRoomUnassignedIds: (ids) => {
            privateRoomUnassignedIds = ids;
          },
          setLobbyPlayersList: (players) => {
            lobbyPlayersList = players;
          },
          syncMyParticipantIdFromPlayers,
          setPrivateReadyPending: (v) => {
            if (!v && privateReadyTargetState !== null) return;
            privateReadyPending = v;
            if (!v) privateReadyTargetState = null;
          },
          setPrivateRoomInviteUrl: (url) => {
            privateRoomInviteUrl = url;
          },
          setLastPrivateRoomCode: (code) => {
            lastPrivateRoomCode = code;
          },
          setIsPrivateRoomSession: (v) => {
            isPrivateRoomSession = v;
          },
          ensurePrivateQrDataUrl,
          getPhase: () => phase,
          setPhase: (ph) => {
            phase = ph as Phase;
          },
          isSelectedForMatchStart,
          setLobbyNotice: (msg) => {
            lobbyNotice = msg;
          },
          render,
        } satisfies PrivateRoomStateApplyDeps,
        payload,
      );
      if (privateReadyPending) {
        const uid = accountUserId();
        const me = payload.players.find((p) => {
          if (myParticipantId && p.participantId) return p.participantId === myParticipantId;
          if (uid && p.userId) return p.userId === uid;
          return false;
        });
        if (
          me &&
          (privateReadyTargetState == null || me.ready === privateReadyTargetState)
        ) {
          privateReadyPending = false;
          privateReadyTargetState = null;
          if (phase === "private_room_lobby" || phase === "matchmaking") {
            render();
          }
        }
      }
    },
  );

  s.on(
    "lobby_state",
    (payload: {
      mode?: GameMode;
      players: {
        participantId?: string;
        userId?: string | null;
        name: string;
        ready: boolean;
      }[];
      isStarting?: boolean;
      participantIds?: string[];
      maxPlayersPerMatch?: number;
      countdownSecondsRemaining?: number;
      isPrivate?: boolean;
      roomCode?: string;
      hostParticipantId?: string;
      roomSettings?: {
        questionMs?: number;
        studyPhaseMs?: number;
      };
    }) => {
      if (phase !== "matchmaking" && phase !== "countdown" && phase !== "private_room_lobby") return;
      if (payload.isPrivate) return;
      if (payload.mode) currentGameMode = payload.mode;
      if (payload.hostParticipantId) privateRoomHostParticipantId = payload.hostParticipantId;
      currentMatchPlayers = payload.players.map((p) => ({
        participantId: p.participantId,
        userId: p.userId,
        name: p.name,
        hearts: 3,
        eliminated: false,
      }));
      lobbyPlayersList = payload.players;
      syncMyParticipantIdFromPlayers(payload.players);
      const pids = payload.participantIds ?? [];
      const hasLock = pids.length > 0;
      const isSelected = !hasLock || (myParticipantId && pids.includes(myParticipantId));

      if (phase === "countdown") {
        if (!isSelected) {
          lobbyCountdown.clear();
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
        hasLock &&
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
        hasLock &&
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

  s.on("match_starting", (raw: unknown) => {
    const payload = raw as { seconds: number; participantIds?: string[] };
    const pids = payload.participantIds ?? [];
    const hasLock = pids.length > 0;
    const isSelected = !hasLock || (myParticipantId && pids.includes(myParticipantId));
    if (!isSelected) {
      lobbyNotice = LOBBY_MSG_WAIT_NEXT;
      if (phase === "countdown") {
        lobbyCountdown.clear();
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
    if (phase !== "matchmaking") return;
    lobbyNotice = "";
    phase = "countdown";
    render();
    startCountdownTicks(Math.max(1, payload.seconds));
  });

  s.on("match_start_cancelled", (raw: unknown) => {
    const payload = raw as { reason?: string; message?: string } | undefined;
    lobbyCountdown.clear();
    if (phase === "countdown") {
      phase = "matchmaking";
    }
    lobbyNotice =
      payload?.reason === "not_enough_questions"
        ? payload.message || "لا توجد أسئلة كافية في مستوى الصعوبة هذا أو هذا التصنيف."
        : payload?.reason === "not_all_ready"
          ? payload.message || "ألغى أحد اللاعبين الجاهزية، فتوقف العد التنازلي."
        : payload?.reason === "not_enough_teams"
          ? payload.message || "يجب أن يكون هناك فريقان على الأقل بأعضاء لبدء وضع الفرق."
          : payload?.reason === "teams_lobby_missing"
            ? payload.message || "وضع الفرق غير مكتمل. اضبط الفرق من اللوبي ثم أعد المحاولة."
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
      teamPlayMode?: "individual" | "teams_first_answer" | "teams_captain_approval";
      heartsPerPlayer?: number;
      revealKeysActive?: boolean;
      keysAttacksEnabled?: boolean;
      abilityCosts?: Partial<AbilityCostsPayload> | null;
      abilityToggles?: Partial<AbilityTogglesPayload> | null;
      players?: Array<{
        participantId?: string;
        userId?: string | null;
        name: string;
        hearts: number;
        eliminated: boolean;
        isSpectator?: boolean;
        skillPoints?: number;
        lastAward?: number;
        keys?: number;
        skillBoostStacks?: number;
        teamId?: string | null;
        isCaptain?: boolean;
      }>;
    }) => {
      if (soloGameStartedWaitTimer != null) {
        window.clearTimeout(soloGameStartedWaitTimer);
        soloGameStartedWaitTimer = null;
      }
      lobbyCountdown.clear();
      applyGameStartedClientPayload(payload);
    },
  );

  s.on(
    "match_resume_token",
    (p: {
      matchId?: string;
      participantId?: string;
      resumeSecret?: string;
      reconnectGraceMs?: number;
      expiresAt?: number;
    }) => {
      if (!p.matchId || !p.participantId || !p.resumeSecret) return;
      if (!canUseReconnect()) return;
      const reconnectGraceMs =
        typeof p.reconnectGraceMs === "number" ? p.reconnectGraceMs : CLIENT_RECONNECT_GRACE_MS;
      const expiresAt =
        typeof p.expiresAt === "number" ? p.expiresAt : Date.now() + reconnectGraceMs;
      writeStoredMatchResume({
        matchId: p.matchId,
        participantId: p.participantId,
        resumeSecret: p.resumeSecret,
        reconnectGraceMs,
        expiresAt,
      });
      refreshReconnectPromptStateFromStorage();
    },
  );

  s.on(
    "round_ready_window",
    (raw: unknown) => {
      const payload = raw as {
      roundToken?: string;
      startsAt?: number;
      endsAt: number;
      serverNow?: number;
      macroRound?: number;
    };
      applyStudyBundleFromServer({ round_ready_window: payload as Record<string, unknown> });
    },
  );

  s.on(
    "study_phase",
    (raw: unknown) => {
      const payload = raw as {
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
    };
      applyStudyBundleFromServer({ study_phase: payload as Record<string, unknown> });
    },
  );

  s.on(
    "study_phase_end",
    (raw: unknown) => {
      const payload = raw as {
      roundToken?: string;
      macroRound?: number;
      startsAt?: number;
      studyEndsAt?: number;
      serverNow?: number;
    };
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
    (raw: unknown) => {
      const payload = raw as {
      roundToken?: string;
      startsAt?: number;
      endsAt?: number;
      serverNow?: number;
      macroRound?: number;
    };
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

  attachGameplaySocketListeners(s, {
    getApp: () => app,
    getPhase: () => phase,
    bindQuestionOptionsUi: (sock, q) => bindQuestionOptionsUi(sock, q as IncomingQuestionPayload),
    findMeInPlayers,
    getCurrentMatchPlayers: () => currentMatchPlayers,
    setCurrentMatchPlayers: (next) => {
      currentMatchPlayers = next as typeof currentMatchPlayers;
    },
    getMatchTeamPlayMode: () => matchTeamPlayMode,
    setTeamVoteCountsByChoice: (v) => {
      teamVoteCountsByChoice = v;
    },
    applyTeamVoteBadgesToOptionButtons,
    getMyParticipantId: () => myParticipantId,
    setTeamRoundUiLocked: (v) => {
      teamRoundUiLocked = v;
    },
    setTeamRoundCaptainSubmitted: (v) => {
      teamRoundCaptainSubmitted = v;
    },
    renderPlayingPlayersPanel,
    showGameToast,
    applyKeysRoomSlice: (slice, opts) =>
      applyKeysRoomSlice(slice as Parameters<typeof applyKeysRoomSlice>[0], opts as Parameters<typeof applyKeysRoomSlice>[1]),
    findServerPlayerRow: (list, local) =>
      findServerPlayerRow(list as never, local as never),
    renderHearts,
    refreshKeysBadge,
    accountUserId,
    isCurrentStudyRound,
    setSpectatorEligible: (v) => {
      spectatorEligible = v;
    },
    setPhase: (ph) => {
      phase = ph as Phase;
    },
    render,
    applyResultScreenPresentation,
    onGameOver: (payload) => handleGameplayGameOver(payload, () => lobbyCountdown.clear()),
    getOptsContainer: () => app.querySelector<HTMLDivElement>("#opts"),
    getStatusElement: () => app.querySelector<HTMLParagraphElement>("#status"),
    getResTitleElement: () => app.querySelector<HTMLHeadingElement>("#res-title"),
    getResBodyElement: () => app.querySelector<HTMLParagraphElement>("#res-body"),
    getResKickerElement: () => app.querySelector<HTMLParagraphElement>("#res-kicker"),
    getResStatsElement: () => app.querySelector<HTMLDivElement>("#res-stats"),
    getContinueWatchButton: () => app.querySelector<HTMLButtonElement>("#continue-watch"),
    getStudyReadyStateElement: () => app.querySelector<HTMLParagraphElement>("#study-ready-state"),
  } satisfies GameplaySocketDeps);

  connectionWaitTimer = window.setTimeout(() => {
    if (flowToken !== searchFlowToken) return;
    if (joinCompleted) return;
    failBackToName("انتهت مهلة الاتصال بالخادم. تحقق من الشبكة ثم أعد المحاولة.");
  }, JOIN_CONNECT_PHASE_MS);

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

/** عدد خانات القلب في الشريط العلوي يطابق إعداد المضيف في الغرفة الخاصة (وإلا 3 للّوبي العام). */
function heartsUiSlotCount(): number {
  const cfg = matchHeartsPerPlayerSetting;
  if (cfg === null) return 3;
  if (cfg === 0) return 3;
  return Math.min(5, Math.max(1, cfg));
}

function renderHearts(n: number): void {
  const h = app.querySelector<HTMLDivElement>("#hearts");
  if (!h) return;
  const slots = heartsUiSlotCount();
  h.innerHTML = "";
  for (let i = 0; i < slots; i++) {
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
}
refreshReconnectPromptStateFromStorage();
subscribeAuthState(() => {
  void refreshCustomLessonPromptServerOverrideFlag();
  if (phase === "name") render();
});
window.addEventListener("fahem:profile-cache-updated", () => {
  if (phase === "name") render();
});
window.addEventListener("popstate", () => {
  pendingJoinRoomCode = getRoomCodeFromUrl() ?? "";
  refreshReconnectPromptStateFromStorage();
  const pathOnly = window.location.pathname.replace(/\/$/, "") || "/";
  if (pathOnly === "/profile") {
    openAccountProfileModal();
  }
  render();
});
window.addEventListener("fahem:auth-tokens-refreshed", () => {
  if (!socket) return;
  const accessToken = getAuthTokens()?.accessToken ?? "";
  socket.auth = { accessToken };
  if (socket.connected) {
    socket.disconnect();
  }
  socket.connect();
});
window.addEventListener("storage", (event) => {
  if (!event.key) return;
  if (event.key === "fahem_auth_access_token" || event.key === "fahem_auth_refresh_token") {
    void hydrateAuthSession();
  }
});
void (async () => {
  void getFirebaseAuth().catch(() => {
    /* تهيئة SDK مسبقاً؛ النقر على تسجيل الدخول يعيد المحاولة */
  });
  try {
    await completeGoogleRedirectLogin();
  } catch (error) {
    console.error("[auth-trace] redirect_bootstrap_unhandled_error", {
      ts: new Date().toISOString(),
      reason: error instanceof Error ? error.message : "unknown_error",
    });
  }
  const bootQ = new URLSearchParams(window.location.search);
  const pwdLanding = readPasswordResetModeFromUrl();
  const isPasswordResetLanding =
    bootQ.get("authAction") === "passwordReset" && pwdLanding.mode === "resetPassword" && Boolean(pwdLanding.oobCode);

  if (isPasswordResetLanding && pwdLanding.oobCode) {
    await hydrateAuthSession();
    openAuthModal({
      passwordResetOobCode: pwdLanding.oobCode,
      onCompleted: () => {
        cleanupEmailLinkLandingUrl();
        render();
      },
    });
  } else {
    await hydrateAuthSession();
  }
})();
attachSocketAuthSync(
  () => socket,
  () => {
    socket = null;
  },
);
const bootParams = new URLSearchParams(window.location.search);
if (bootParams.get("auth") === "1") {
  openAuthModal({
    onCompleted: () => {
      const clean = new URL(window.location.href);
      clean.searchParams.delete("auth");
      history.replaceState({}, "", clean.pathname + clean.search + clean.hash);
      render();
    },
  });
}
const lessonIdFromUrl = Number(bootParams.get("lesson") ?? "");
const lessonPreviewBoot = bootParams.get("lessonPreview");
if (lessonPreviewBoot === "1") {
  const raw = sessionStorage.getItem(FAHEM_ADMIN_LESSON_PREVIEW_KEY);
  if (raw) {
    try {
      sessionStorage.removeItem(FAHEM_ADMIN_LESSON_PREVIEW_KEY);
      const payload = JSON.parse(raw) as LessonPlaybackPayload;
      if (payload && typeof payload === "object" && Array.isArray(payload.steps) && payload.steps.length > 0) {
        beginLessonPlayback(payload, "lesson_menu");
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
  const pathOnly = window.location.pathname.replace(/\/$/, "") || "/";
  if (pathOnly === "/profile") {
    history.replaceState({}, "", "/");
    openAccountProfileModal();
  }
  render();
}
startReleaseVersionWatch();
