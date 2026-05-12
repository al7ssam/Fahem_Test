import type { Socket } from "socket.io-client";

/** وسيطات السؤال من اللقطة بعد التحقق من questionId و options */
export type SnapshotQuestionArg = Record<string, unknown> & {
  questionId: number;
  options: unknown[];
};

export type SnapshotApplyDeps = {
  syncClock: (serverNow: number) => void;
  applyGameStartedClientPayload: (gs: Record<string, unknown>) => void;
  applyKeysRoomSlice: (ks: Record<string, unknown>, opts: Record<string, never>) => void;
  applyStudyBundleFromServer: (st: Record<string, unknown>) => void;
  getPhase: () => string;
  queryStudyReadyStateEl: () => HTMLParagraphElement | null;
  bindQuestionOptionsUi: (s: Socket, q: SnapshotQuestionArg) => void;
  getMatchTeamPlayMode: () => string | null;
  findMeInPlayers: (players: unknown[]) => { teamId?: string | null } | null | undefined;
  getCurrentMatchPlayers: () => unknown[];
  setTeamVoteCountsByChoice: (next: Record<number, number>) => void;
  setCaptainTapPendingIndex: (v: number | null) => void;
  applyTeamVoteBadgesToOptionButtons: () => void;
  queryStatusEl: () => HTMLParagraphElement | null;
  render: () => void;
  surfaceGameplayConnectionMessage: (msg: string) => void;
  queryLobbyNoticeEl: () => HTMLParagraphElement | null;
};

export function applyMatchStateSnapshotFromServer(
  deps: SnapshotApplyDeps,
  s: Socket,
  snap: Record<string, unknown>,
): void {
  const sn = snap.serverNow;
  if (typeof sn === "number") deps.syncClock(sn);
  const gs = snap.gameStarted as Record<string, unknown> | undefined;
  if (gs) deps.applyGameStartedClientPayload(gs);
  const ks = snap.keysRoomState as Record<string, unknown> | undefined;
  if (ks) deps.applyKeysRoomSlice(ks, {});
  const st = snap.study as Record<string, unknown> | undefined;
  if (st && st.study_phase) deps.applyStudyBundleFromServer(st);
  const hint = snap.matchPhaseHint as string | undefined;
  if (hint === "between" && deps.getPhase() === "studying") {
    const readyStateEl = deps.queryStudyReadyStateEl();
    if (readyStateEl && !snap.question) {
      readyStateEl.textContent = "انتقال إلى السؤال…";
    }
  }
  const q = snap.question as SnapshotQuestionArg | null | undefined;
  if (q && typeof q.questionId === "number" && Array.isArray(q.options)) {
    deps.bindQuestionOptionsUi(s, q);
  }
  const tvr = snap.teamVoteResync as
    | Array<{
        teamId: string;
        votes: Record<string, number>;
        captainAwaitingSecondOn: number | null;
      }>
    | undefined;
  if (tvr && deps.getMatchTeamPlayMode() === "teams_captain_approval") {
    const me = deps.findMeInPlayers(deps.getCurrentMatchPlayers());
    if (me?.teamId) {
      const mine = tvr.find((x) => x.teamId === me.teamId);
      if (mine) {
        const nextCounts: Record<number, number> = {};
        for (const v of Object.values(mine.votes)) {
          if (typeof v === "number") {
            nextCounts[v] = (nextCounts[v] ?? 0) + 1;
          }
        }
        deps.setTeamVoteCountsByChoice(nextCounts);
        deps.setCaptainTapPendingIndex(
          typeof mine.captainAwaitingSecondOn === "number" ? mine.captainAwaitingSecondOn : null,
        );
        deps.applyTeamVoteBadgesToOptionButtons();
        const stEl = deps.queryStatusEl();
        if (stEl && deps.getPhase() === "playing") {
          const n = Object.keys(mine.votes).length;
          stEl.textContent = `تصويت الفريق: ${n} عضو سجّل اختيارًا.`;
        }
      }
    }
  }
  deps.render();
  const ph = deps.getPhase();
  if (
    ph === "playing" ||
    ph === "studying" ||
    ph === "countdown" ||
    ph === "match_lesson_review"
  ) {
    deps.surfaceGameplayConnectionMessage("تم استعادة الجلسة.");
  } else {
    const noticeEl = deps.queryLobbyNoticeEl();
    if (noticeEl) noticeEl.textContent = "تم استعادة الجلسة.";
  }
}
