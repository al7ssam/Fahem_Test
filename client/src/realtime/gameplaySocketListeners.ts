import type { Socket } from "socket.io-client";
import type { SnapshotQuestionArg } from "./snapshotApply";

export type GameplaySocketDeps = {
  getApp: () => HTMLElement;
  getPhase: () => string;
  bindQuestionOptionsUi: (s: Socket, q: SnapshotQuestionArg) => void;
  findMeInPlayers: (players: unknown[]) =>
    | {
        teamId?: string | null;
        participantId?: string;
        userId?: string | null;
        isCaptain?: boolean;
        hearts?: number;
        skillPoints?: number;
        lastRoundResult?: unknown;
      }
    | undefined;
  getCurrentMatchPlayers: () => unknown[];
  setCurrentMatchPlayers: (next: unknown[]) => void;
  getMatchTeamPlayMode: () => string | null;
  setTeamVoteCountsByChoice: (v: Record<number, number>) => void;
  applyTeamVoteBadgesToOptionButtons: () => void;
  getMyParticipantId: () => string | null;
  setTeamRoundUiLocked: (v: boolean) => void;
  setTeamRoundCaptainSubmitted: (v: boolean) => void;
  renderPlayingPlayersPanel: () => void;
  showGameToast: (msg: string) => void;
  applyKeysRoomSlice: (slice: Record<string, unknown>, opts?: Record<string, unknown>) => void;
  findServerPlayerRow: (server: unknown[], local: Record<string, unknown>) => unknown | undefined;
  renderHearts: (n: number) => void;
  refreshKeysBadge: () => void;
  accountUserId: () => string | null;
  isCurrentStudyRound: (roundToken?: string, macroRound?: number) => boolean;
  setSpectatorEligible: (v: boolean) => void;
  setPhase: (p: string) => void;
  render: () => void;
  applyResultScreenPresentation: (kind: "win" | "lose" | "tie" | "empty", emoji: string) => void;
  onGameOver: (payload: unknown) => void;
  // DOM element accessors — replace app().querySelector calls
  getOptsContainer: () => HTMLDivElement | null;
  getStatusElement: () => HTMLParagraphElement | null;
  getResTitleElement: () => HTMLHeadingElement | null;
  getResBodyElement: () => HTMLParagraphElement | null;
  getResKickerElement: () => HTMLParagraphElement | null;
  getResStatsElement: () => HTMLDivElement | null;
  getContinueWatchButton: () => HTMLButtonElement | null;
  getStudyReadyStateElement: () => HTMLParagraphElement | null;
};

export function attachGameplaySocketListeners(s: Socket, deps: GameplaySocketDeps): void {
  s.on("question", (q: SnapshotQuestionArg) => {
    deps.bindQuestionOptionsUi(s, q);
  });

  s.on(
    "team_vote_update",
    (payload: {
      teamId?: string;
      votes?: Record<string, number>;
      captainAwaitingSecondOn?: number | null;
    }) => {
      if (deps.getPhase() !== "playing") return;
      const me = deps.findMeInPlayers(deps.getCurrentMatchPlayers());
      if (!me?.teamId || payload.teamId !== me.teamId) return;
      const votes = payload.votes ?? {};
      const next: Record<number, number> = {};
      for (const v of Object.values(votes)) {
        if (typeof v === "number") {
          next[v] = (next[v] ?? 0) + 1;
        }
      }
      deps.setTeamVoteCountsByChoice(next);
      deps.applyTeamVoteBadgesToOptionButtons();
      const st = deps.getStatusElement();
      if (st && deps.getMatchTeamPlayMode() === "teams_captain_approval") {
        const n = Object.keys(votes).length;
        st.textContent = `تصويت الفريق: ${n} عضو سجّل اختيارًا للآن.`;
        st.classList.add("status--team-votes");
      }
    },
  );

  s.on("team_answer_locked", (payload: { teamId?: string; participantId?: string; mode?: string }) => {
    if (deps.getPhase() !== "playing") return;
    if (payload.mode !== "teams_first_answer") return;
    const me = deps.findMeInPlayers(deps.getCurrentMatchPlayers());
    if (!me?.teamId || payload.teamId !== me.teamId) return;
    if (payload.participantId && deps.getMyParticipantId() && payload.participantId !== deps.getMyParticipantId()) {
      deps.setTeamRoundUiLocked(true);
      const optsEl = deps.getOptsContainer();
      const st = deps.getStatusElement();
      if (optsEl) {
        optsEl.querySelectorAll("button").forEach((btn) => {
          const htmlBtn = btn as HTMLButtonElement;
          htmlBtn.disabled = true;
          htmlBtn.classList.add("option-btn--disabled");
        });
      }
      if (st) {
        st.textContent = "قُفلت إجابة الفريق من زميلك — لا يمكن تغيير الخيار.";
        st.classList.add("status--team-lock");
      }
    }
  });

  s.on("team_submitted", (payload: { teamId?: string }) => {
    if (deps.getPhase() !== "playing") return;
    const me = deps.findMeInPlayers(deps.getCurrentMatchPlayers());
    if (!me?.teamId || payload.teamId !== me.teamId) return;
    deps.setTeamRoundCaptainSubmitted(true);
    const optsEl = deps.getOptsContainer();
    if (optsEl) {
      optsEl.querySelectorAll("button").forEach((btn) => {
        const htmlBtn = btn as HTMLButtonElement;
        htmlBtn.disabled = true;
        htmlBtn.classList.add("option-btn--disabled");
      });
    }
    const st = deps.getStatusElement();
    if (st) {
      st.textContent = "أُرسلت إجابة الفريق — انتظر نتيجة السؤال.";
      st.classList.add("status--team-lock");
    }
  });

  s.on("team_captain_changed", (payload: { teamId?: string; captainParticipantId?: string }) => {
    const tid = payload.teamId;
    const cap = payload.captainParticipantId;
    if (tid && cap) {
      deps.setCurrentMatchPlayers(
        deps.getCurrentMatchPlayers().map((pl) => {
          const row = pl as { teamId?: string | null; participantId?: string; isCaptain?: boolean };
          if (row.teamId !== tid) return pl;
          return { ...(pl as Record<string, unknown>), isCaptain: row.participantId === cap } as unknown;
        }),
      );
      deps.renderPlayingPlayersPanel();
    }
    deps.showGameToast(
      payload.captainParticipantId
        ? "تغيّر قائد أحد الفرق. تحقق من لوحة اللاعبين."
        : "تغيّر قائد الفريق.",
    );
  });

  s.on(
    "question_result",
    (payload: {
      revealKeysActive?: boolean;
      keysAttacksEnabled?: boolean;
      abilityCosts?: unknown;
      abilityToggles?: unknown;
      results?: Array<{
        participantId?: string;
        correct: boolean;
        skipped?: boolean;
        pointsAward?: number;
        hearts: number;
        eliminated: boolean;
      }>;
      players: Array<{
        participantId?: string;
        userId?: string | null;
        hearts: number;
        eliminated: boolean;
        skillPoints?: number;
        lastAward?: number;
        isSpectator?: boolean;
        keys?: number;
        skillBoostStacks?: number;
        teamId?: string | null;
        isCaptain?: boolean;
      }>;
    }) => {
      deps.applyKeysRoomSlice(
        {
          revealKeysActive: payload.revealKeysActive,
          keysAttacksEnabled: payload.keysAttacksEnabled,
          abilityCosts: payload.abilityCosts,
          abilityToggles: payload.abilityToggles,
          players: payload.players,
        },
        { skipPanelRender: true, keyRewardGlow: true },
      );
      const me = deps.findMeInPlayers(payload.players);
      if (me && deps.getPhase() === "playing") deps.renderHearts(me.hearts ?? 0);
      const results = payload.results ?? [];
      deps.setCurrentMatchPlayers(
        deps.getCurrentMatchPlayers().map((player) => {
          const p = player as Record<string, unknown>;
          const next = deps.findServerPlayerRow(payload.players, p) as Record<string, unknown> | undefined;
          const rr = results.find((r) => r.participantId === p.participantId);
          const lastRoundResult = rr
            ? rr.skipped
              ? ("skipped" as const)
              : rr.correct
                ? ("correct" as const)
                : ("wrong" as const)
            : undefined;
          if (!next) {
            const { lastRoundResult: _lr, ...rest } = p;
            return rest;
          }
          const nx = next as typeof next & { teamId?: string | null; isCaptain?: boolean };
          return {
            ...p,
            participantId: next.participantId ?? p.participantId,
            hearts: next.hearts,
            eliminated: next.eliminated,
            skillPoints: (next.skillPoints as number | undefined) ?? (p.skillPoints as number | undefined) ?? 0,
            lastAward: (next.lastAward as number | undefined) ?? 0,
            isSpectator: (next.isSpectator as boolean | undefined) ?? (p.isSpectator as boolean | undefined) ?? false,
            keys: (next.keys as number | undefined) ?? (p.keys as number | undefined) ?? 0,
            skillBoostStacks:
              (next.skillBoostStacks as number | undefined) ?? (p.skillBoostStacks as number | undefined) ?? 0,
            teamId: nx.teamId !== undefined ? nx.teamId : p.teamId,
            isCaptain: nx.isCaptain !== undefined ? nx.isCaptain : p.isCaptain,
            lastRoundResult,
          };
        }),
      );
      deps.refreshKeysBadge();
      deps.renderPlayingPlayersPanel();
      const status = deps.getStatusElement();
      if (status) status.textContent = "جاري السؤال التالي…";
    },
  );

  s.on("game_over", deps.onGameOver);

  s.on(
    "keys_room_state",
    (payload: {
      revealKeysActive?: boolean;
      abilityCosts?: unknown;
      abilityToggles?: unknown;
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
      }>;
    }) => {
      deps.applyKeysRoomSlice({
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
      attackerParticipantId?: string;
      attackerUserId?: string | null;
      attackerName?: string;
      victimParticipantId?: string;
      victimUserId?: string | null;
      victimName?: string;
      outcome?: "hit" | "blocked";
      shieldCost?: number;
    }) => {
      const aName = payload.attackerName ?? "لاعب";
      const vName = payload.victimName ?? "لاعب";
      const uid = deps.accountUserId();
      const victimIsMe =
        (deps.getMyParticipantId() && payload.victimParticipantId === deps.getMyParticipantId()) ||
        Boolean(uid && payload.victimUserId && payload.victimUserId === uid);
      const attackerIsMe =
        (deps.getMyParticipantId() && payload.attackerParticipantId === deps.getMyParticipantId()) ||
        Boolean(uid && payload.attackerUserId && payload.attackerUserId === uid);
      if (victimIsMe) {
        if (payload.outcome === "blocked") {
          deps.showGameToast(`${aName} أطلق عليك صاروخاً — تصدّيت بمفاتيح!`);
        } else {
          deps.showGameToast(`${aName} أطلق عليك صاروخاً — خسرت قلباً!`);
        }
      } else if (attackerIsMe) {
        if (payload.outcome === "blocked") {
          deps.showGameToast(`${vName} تصدّى بمفاتيح (${payload.shieldCost ?? 2} مفتاحاً).`);
        } else {
          deps.showGameToast(`أصبت ${vName} — خسر قلباً.`);
        }
      }
    },
  );

  s.on(
    "player_eliminated",
    (p: { name: string; participantId?: string; reason?: string; teamId?: string }) => {
      deps.setCurrentMatchPlayers(
        deps.getCurrentMatchPlayers().map((x) => {
          const row = x as { participantId?: string; name?: string; eliminated?: boolean; hearts?: number };
          return (p.participantId && row.participantId === p.participantId) ||
            (!p.participantId && row.name === p.name)
            ? { ...row, eliminated: true, hearts: 0 }
            : x;
        }),
      );
      deps.renderPlayingPlayersPanel();
      const status = deps.getStatusElement();
      if (status && deps.getPhase() === "playing") {
        const teamHint = p.teamId && deps.getMatchTeamPlayMode() ? " (فريق)" : "";
        status.textContent =
          p.reason === "disconnect"
            ? `${p.name} خرج من اللعبة${teamHint}.`
            : `${p.name} نفدت قلوبه${teamHint}.`;
      }
    },
  );

  s.on("spectator_offer", (p: { participantId?: string }) => {
    const forMe = Boolean(deps.getMyParticipantId() && p.participantId === deps.getMyParticipantId());
    if (!forMe) return;
    deps.setSpectatorEligible(true);
    deps.setPhase("result");
    deps.render();
    const title = deps.getResTitleElement();
    const body = deps.getResBodyElement();
    const kicker = deps.getResKickerElement();
    const stats = deps.getResStatsElement();
    const continueWatch = deps.getContinueWatchButton();
    if (kicker) kicker.hidden = true;
    if (title) title.textContent = "خرجت من الجولة";
    if (body) body.textContent = "يمكنك متابعة المباراة كمشاهد حتى النهاية.";
    if (stats) {
      stats.classList.add("hidden");
      stats.innerHTML = "";
    }
    if (continueWatch) continueWatch.classList.remove("hidden");
    deps.applyResultScreenPresentation("lose", "💔");
  });

  s.on(
    "round_ready_state",
    (p: {
      roundToken?: string;
      macroRound?: number;
      readyParticipantIds?: string[];
      totalActive: number;
    }) => {
      if (!deps.isCurrentStudyRound(p.roundToken, p.macroRound)) return;
      const readyStateEl = deps.getStudyReadyStateElement();
      if (readyStateEl && deps.getPhase() === "studying") {
        const n = p.readyParticipantIds?.length ?? 0;
        readyStateEl.textContent = `جاهزية اللاعبين: ${n}/${p.totalActive}`;
      }
    },
  );
}
