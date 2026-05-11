import type { Server } from "socket.io";
import { randomBytes, timingSafeEqual } from "crypto";
import { getPool } from "../db/pool";
import type { LessonPlaybackPayload } from "../db/lessons";
import {
  lessonPlaybackToStudyCardsFromSteps,
  lessonStepToQuestionRow,
  lessonStudyPhaseTotalMsForSteps,
} from "../db/lessons";
import {
  getRandomQuestion,
  getStudyPhaseCardsFromQuestionIds,
  type QuestionRow,
  type StudyPhaseCardPayload,
} from "../db/questions";
import { getResultMessages, type ResultMessages } from "../db/resultCopy";
import {
  DEFAULT_GAME_QUESTION_MS,
  DEFAULT_GAME_STUDY_PHASE_MS,
  clampGameQuestionMs,
  clampGameStudyPhaseMs,
  resolveQuestionMsFromAppSetting,
  resolveStudyPhaseMsFromAppSetting,
} from "./runtimeGameTiming";
import type { MatchSeatInput } from "./participantTypes";
import type {
  MatchPrivateRuntimeOptions,
  MatchTeamSnapshot,
  PrivateRoomHeartsPerPlayer,
  PrivateRoomTeamPlayMode,
} from "./privateRoomTeamTypes";
import { MATCH_RECONNECT_GRACE_MS } from "./reconnectConfig";

/** بعد انتهاء الإجابات يبقى استقبال القدرات مفعّلاً لهذا الوقت (تخفيف سباق الشبكة مع finishRound). */
const ABILITY_GRACE_MS = 500;
const MAX_ROUNDS = 50;
const DEFAULT_MAX_STUDY_ROUNDS = 3;
const DEFAULT_STUDY_ROUND_SIZE = 8;
const DEFAULT_ROUND_READY_MS = 12_000;
const RUNTIME_SETTINGS_CACHE_MS = 15_000;

export type GameMode = "direct" | "study_then_quiz" | "lesson";
export type DifficultyMode = "mix" | "easy" | "medium" | "hard";

export type MatchPlayerPublic = {
  participantId: string;
  userId: string | null;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator: boolean;
  skillPoints: number;
  lastAward: number;
  keys: number;
  skillBoostStacks: number;
  teamId: string | null;
  isCaptain: boolean;
};

type MatchPlayerState = {
  currentSocketId: string;
  userId: string | null;
  playerSessionId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator: boolean;
  skillPoints: number;
  lastAward: number;
  keys: number;
  correctStreak: number;
  skillBoostStacks: number;
  teamId: string | null;
  isCaptain: boolean;
};

export type AbilityAck =
  | { ok: true; keys: number; skillBoostStacks?: number; revealQuestions?: number }
  | { ok: false; error: string };

export class Match {
  private static runtimeSettingsCache: {
    loadedAtMs: number;
    map: Map<string, string>;
  } | null = null;
  static invalidateRuntimeSettingsCache(): void {
    Match.runtimeSettingsCache = null;
  }
  readonly room: string;
  private readonly isSoloMatch: boolean;
  /** مفتاح: participantId */
  private readonly players = new Map<string, MatchPlayerState>();
  private usedQuestionIds: number[] = [];
  private round = 0;
  private currentQuestionId: number | null = null;
  private currentCorrectIndex: number | null = null;
  private currentOptionsCount: number | null = null;
  private questionStartedAt = 0;
  private answerDeadline = 0;
  private pendingAnswers = new Map<string, number>();
  private answerTimes = new Map<string, number>();
  private questionTimer: ReturnType<typeof setTimeout> | null = null;
  private abilityGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private roundClosed = false;
  private resolveRound: (() => void) | null = null;
  private finished = false;
  private studyPhaseResolve: (() => void) | null = null;
  private studyWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private macroRound = 0;
  private activeRoundToken = "";
  private resultMessages: ResultMessages | null = null;
  private maxStudyRounds = DEFAULT_MAX_STUDY_ROUNDS;
  private studyRoundSize = DEFAULT_STUDY_ROUND_SIZE;
  private studyPhaseMs = DEFAULT_GAME_STUDY_PHASE_MS;
  private roundReady = new Set<string>();
  private roundReadyResolve: (() => void) | null = null;
  private roundReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private skipParticipantsForQuestion = new Set<string>();
  private revealRemainingByParticipant = new Map<string, number>();
  private revealMacroRoundByParticipant = new Map<string, number | null>();
  /** study_then_quiz فردي: إكمال جميع جولات المذاكرة/الأسئلة دون خروج مبكر */
  private soloStudyQuizReachedFullCourse = false;
  /** direct فردي: إكمال حلقة الأسئلة حتى حد MAX_ROUNDS وهو لا يزال حيًا */
  private soloDirectReachedFullCourse = false;
  /** في نمط الدرس: تاريخ إجابات لكل مشارك لبناء lessonReview عند game_over */
  private lessonAnswerHistory = new Map<
    string,
    Array<{
      questionId: number;
      choiceIndex: number | null;
      correctIndex: number;
      prompt: string;
      options: string[];
      studyBody: string | null;
    }>
  >();
  private readonly privateRuntime: MatchPrivateRuntimeOptions | null = null;
  private readonly teamSnapshots = new Map<string, MatchTeamSnapshot>();
  private readonly teamScores = new Map<string, number>();
  /** إرسال إجابة الفريق لهذه الجولة (teamId → من أرسل والخيار والوقت). */
  private teamRoundSubmissions = new Map<
    string,
    {
      byParticipantId: string;
      choiceIndex: number;
      at: number;
      /** لقطة skillBoostStacks عند القفل (مُرسّل قد ينقطع قبل finishRound). */
      skillBoostStacksAtLock: number;
    }
  >();
  /** وضع الكابتن: teamId → (participantId → صوت). */
  private captainRoundVotes = new Map<string, Map<string, number>>();
  /** teamId → آخر خيار نقر عليه الكابتن في انتظار النقرة الثانية للإرسال. */
  private captainAwaitingSecondOn = new Map<string, number | null>();
  /** تجنب تكرار emit لـ team_vote_update لنفس الحالة. */
  private lastTeamVoteWireKey = new Map<string, string>();
  private heartsFromAnswersDisabled = false;
  private keysStreakPerKey = 5;
  private keysSmallStreakReward = 1;
  private keysMegaStreak = 8;
  private keysMegaReward = 5;
  private keysMaxPerPlayer = 20;
  private keysSkillBoostPercent = 30;
  private keysSkillBoostMaxMultiplier = 3;
  private keysHeartAttackCost = 2;
  private keysShieldCost = 2;
  private keysRevealCost = 2;
  private keysRevealQuestionsDirect = 4;
  private keysRevealQuestionsStudy = 4;
  private keysDropRate = 1;
  private abilitySkillBoostDirectEnabled = true;
  private abilitySkillBoostStudyEnabled = true;
  private abilitySkipDirectEnabled = true;
  private abilitySkipStudyEnabled = true;
  private abilityAttackDirectEnabled = true;
  private abilityAttackStudyEnabled = true;
  private abilityRevealDirectEnabled = true;
  private abilityRevealStudyEnabled = true;
  private questionMs = DEFAULT_GAME_QUESTION_MS;
  /** رمز استئناف النقل لكل مقعد (لا يُعرَض إلا عبر `match_resume_token`). */
  private readonly resumeSecretsByParticipant = new Map<string, Buffer>();
  /** لقطات نص السؤال الحالي لإعادة المزامنة بعد الاستئناف. */
  private currentQuestionPrompt: string | null = null;
  private currentQuestionOptions: string[] | null = null;
  /** آخر حزمة مذاكرة بُثّت (لإعادة ربط منتصف المذاكرة). */
  private studyResyncBundle: {
    study_phase: Record<string, unknown>;
    round_ready_window: Record<string, unknown>;
  } | null = null;
  /** تلميح طور للّقطة: يُحدَّث عند المذاكرة / بين المذاكرة والسؤال / السؤال. */
  private matchPhaseHint: "idle" | "study" | "between" | "question" = "idle";

  constructor(
    private readonly io: Server,
    readonly matchId: string,
    entries: MatchSeatInput[],
    readonly gameMode: GameMode,
    private readonly studySubcategoryKey: string | null = null,
    private readonly difficultyMode: DifficultyMode = "mix",
    private readonly timeOverrides?: {
      questionMsOverride?: number;
      studyPhaseMsOverride?: number;
    },
    private readonly lessonPlayback: LessonPlaybackPayload | null = null,
    privateRuntime: MatchPrivateRuntimeOptions | null = null,
  ) {
    this.room = `match_${matchId}`;
    this.isSoloMatch = entries.length === 1;
    this.privateRuntime = privateRuntime;
    const teamsCfg = privateRuntime?.teams;
    if (teamsCfg?.teams?.length) {
      for (const t of teamsCfg.teams) {
        this.teamSnapshots.set(t.teamId, {
          ...t,
          memberParticipantIds: [...t.memberParticipantIds],
        });
        this.teamScores.set(t.teamId, 0);
      }
    }
    const hp = (privateRuntime?.heartsPerPlayer ?? 3) as PrivateRoomHeartsPerPlayer;
    this.heartsFromAnswersDisabled = hp === 0;
    const initialHearts = this.heartsFromAnswersDisabled ? 3 : hp;
    for (const e of entries) {
      this.players.set(e.participantId, {
        currentSocketId: e.connectionSocketId,
        userId: e.userId,
        playerSessionId: e.playerSessionId,
        name: e.name,
        hearts: initialHearts,
        eliminated: false,
        isSpectator: false,
        skillPoints: 0,
        lastAward: 0,
        keys: 0,
        correctStreak: 0,
        skillBoostStacks: 0,
        teamId: e.teamId ?? null,
        isCaptain: Boolean(e.isCaptain),
      });
      this.resumeSecretsByParticipant.set(e.participantId, randomBytes(32));
    }
  }

  private clearPerQuestionTeamState(): void {
    this.teamRoundSubmissions.clear();
    this.captainRoundVotes.clear();
    this.captainAwaitingSecondOn.clear();
    this.lastTeamVoteWireKey.clear();
  }

  private isTeamSubmissionLocked(teamId: string): boolean {
    return this.teamRoundSubmissions.has(teamId);
  }

  private snapshotPlayers(): MatchPlayerPublic[] {
    return [...this.players.entries()].map(([participantId, p]) => ({
      participantId,
      userId: p.userId,
      name: p.name,
      hearts: p.hearts,
      eliminated: p.eliminated,
      isSpectator: p.isSpectator,
      skillPoints: p.skillPoints,
      lastAward: p.lastAward,
      keys: p.keys,
      skillBoostStacks: p.skillBoostStacks,
      teamId: p.teamId,
      isCaptain: p.isCaptain,
    }));
  }

  private hasPrivateTeams(): boolean {
    return this.teamSnapshots.size > 0;
  }

  private privateTeamPlayMode(): PrivateRoomTeamPlayMode | null {
    return this.privateRuntime?.teams ? this.privateRuntime.teams.teamPlayMode : null;
  }

  /** جاهزية المذاكرة/الجولة: يتفق مع وضع الفرق عند تعطيل القلوب (لا يعتمد على hearts<=0 فقط). */
  private isParticipantActiveForStudyRound(p: MatchPlayerState): boolean {
    if (p.eliminated || p.isSpectator) return false;
    if (this.hasPrivateTeams() && this.heartsFromAnswersDisabled) return true;
    return p.hearts > 0;
  }

  private emitPlayerEliminated(
    participantId: string,
    name: string,
    reason: "hearts" | "disconnect",
  ): void {
    const pl = this.players.get(participantId);
    const payload: {
      participantId: string;
      name: string;
      reason: "hearts" | "disconnect";
      teamId?: string;
    } = { participantId, name, reason };
    if (this.hasPrivateTeams() && pl?.teamId) payload.teamId = pl.teamId;
    this.io.to(this.room).emit("player_eliminated", payload);
  }

  private emitTeamVoteUpdateIfChanged(teamId: string, votes: Map<string, number>): void {
    const awaiting = this.captainAwaitingSecondOn.get(teamId) ?? null;
    const wireKey = JSON.stringify({
      a: awaiting,
      v: [...votes.entries()].sort((x, y) => x[0].localeCompare(y[0])),
    });
    if (this.lastTeamVoteWireKey.get(teamId) === wireKey) return;
    this.lastTeamVoteWireKey.set(teamId, wireKey);
    this.io.to(this.room).emit("team_vote_update", {
      teamId,
      votes: Object.fromEntries(votes),
      captainAwaitingSecondOn: awaiting,
    });
  }

  private snapshotTeamScoresPayload(): Array<{ teamId: string; teamScore: number }> {
    return [...this.teamScores.entries()].map(([teamId, teamScore]) => ({ teamId, teamScore }));
  }

  private reassignCaptainAfterMemberLeft(leftParticipantId: string): void {
    if (!this.hasPrivateTeams()) return;
    const p = this.players.get(leftParticipantId);
    if (!p?.teamId) return;
    const tid = p.teamId;
    const snap = this.teamSnapshots.get(tid);
    if (!snap || snap.captainParticipantId !== leftParticipantId) return;
    const votes = this.captainRoundVotes.get(tid);
    votes?.delete(leftParticipantId);
    this.captainAwaitingSecondOn.delete(tid);
    this.lastTeamVoteWireKey.delete(tid);
    const next = snap.memberParticipantIds.find((pid) => {
      if (pid === leftParticipantId) return false;
      const pl = this.players.get(pid);
      return pl && this.isParticipantActiveForTeam(pl);
    });
    if (!next) {
      if (votes && this.privateTeamPlayMode() === "teams_captain_approval") {
        this.emitTeamVoteUpdateIfChanged(tid, votes);
      }
      return;
    }
    snap.captainParticipantId = next;
    for (const pid of snap.memberParticipantIds) {
      const pl = this.players.get(pid);
      if (pl) pl.isCaptain = pid === next;
    }
    this.io.to(this.room).emit("team_captain_changed", { teamId: tid, captainParticipantId: next });
    if (votes && this.privateTeamPlayMode() === "teams_captain_approval") {
      this.emitTeamVoteUpdateIfChanged(tid, votes);
    }
  }

  private runTeamRoundScoring(
    results: Array<{
      participantId: string;
      correct: boolean;
      skipped?: boolean;
      choiceIndex?: number | null;
      pointsAward: number;
      hearts: number;
      eliminated: boolean;
    }>,
    correctIndex: number,
  ): void {
    const tmode = this.privateTeamPlayMode();
    if (!tmode) return;
    const totalWindow = Math.max(1, this.answerDeadline - this.questionStartedAt);

    for (const [teamId, snap] of this.teamSnapshots) {
      const submission = this.teamRoundSubmissions.get(teamId);
      const votes = this.captainRoundVotes.get(teamId) ?? new Map<string, number>();
      const teamChoice = submission?.choiceIndex ?? null;
      const answeredTeam = submission != null;
      const teamCorrect = answeredTeam && teamChoice === correctIndex;
      const answeredAt = submission?.at ?? this.answerDeadline;
      const progress = Math.min(1, Math.max(0, (answeredAt - this.questionStartedAt) / totalWindow));
      const base = Math.round(100 - progress * 99);
      const submitter = submission ? this.players.get(submission.byParticipantId) : undefined;
      const stacks =
        submission?.skillBoostStacksAtLock ?? submitter?.skillBoostStacks ?? 0;
      let teamPointsAward = 0;
      if (teamCorrect) {
        teamPointsAward = this.applySkillBoostToAward(base, stacks);
        this.teamScores.set(teamId, (this.teamScores.get(teamId) ?? 0) + teamPointsAward);
      }

      if (tmode === "teams_first_answer") {
        if (answeredTeam && !teamCorrect && submission) {
          const lp = this.players.get(submission.byParticipantId);
          if (lp) this.damageHeart(submission.byParticipantId, lp, { skipIfHeartsDisabled: true });
        }
      } else if (answeredTeam && !teamCorrect && submission) {
        const cap = this.players.get(submission.byParticipantId);
        if (cap) this.damageHeart(submission.byParticipantId, cap, { skipIfHeartsDisabled: true });
        const wrongIdx = teamChoice;
        if (wrongIdx != null) {
          for (const pid of snap.memberParticipantIds) {
            if (pid === submission.byParticipantId) continue;
            if (votes.get(pid) === wrongIdx) {
              const pl = this.players.get(pid);
              if (pl) this.damageHeart(pid, pl, { skipIfHeartsDisabled: true });
            }
          }
        }
      }

      for (const pid of snap.memberParticipantIds) {
        const p = this.players.get(pid);
        if (!p) continue;
        if (this.skipParticipantsForQuestion.has(pid)) {
          p.lastAward = 0;
          results.push({
            participantId: pid,
            correct: false,
            skipped: true,
            choiceIndex: null,
            pointsAward: 0,
            hearts: p.hearts,
            eliminated: p.eliminated,
          });
          continue;
        }
        if (p.eliminated || (!this.heartsFromAnswersDisabled && p.hearts <= 0)) continue;

        const choiceIndexForResult: number | null =
          tmode === "teams_captain_approval"
            ? (votes.has(pid) ? (votes.get(pid) ?? null) : null)
            : submission?.byParticipantId === pid
              ? teamChoice
              : null;

        let pointsAward = 0;
        let correct = false;

        if (tmode === "teams_first_answer") {
          if (teamCorrect && submission && pid === submission.byParticipantId) {
            correct = true;
            p.correctStreak += 1;
            this.applyKeyGrants(p);
            pointsAward = teamPointsAward;
            p.skillPoints += teamPointsAward;
            p.lastAward = pointsAward;
          } else {
            p.correctStreak = 0;
            p.lastAward = 0;
          }
        } else if (teamCorrect && submission && votes.get(pid) === correctIndex) {
          correct = true;
          p.correctStreak += 1;
          this.applyKeyGrants(p);
          pointsAward = teamPointsAward;
          p.skillPoints += teamPointsAward;
          p.lastAward = pointsAward;
        } else {
          p.correctStreak = 0;
          p.lastAward = 0;
        }

        results.push({
          participantId: pid,
          correct,
          choiceIndex: choiceIndexForResult,
          pointsAward,
          hearts: p.hearts,
          eliminated: p.eliminated,
        });
      }
    }
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** استئناف النقل عبر المقبس لمباريات متعددة اللاعبين فقط (لا للتعلم الفردي). */
  allowsTransportReconnect(): boolean {
    return !this.isSoloMatch;
  }

  getParticipantIds(): readonly string[] {
    return [...this.players.keys()];
  }

  /** تحديث عنوان المقبس للمقعد (نقطة إعادة الربط عند تنفيذ reconnect لاحقًا). */
  syncParticipantSocket(participantId: string, connectionSocketId: string): void {
    const p = this.players.get(participantId);
    if (p) p.currentSocketId = connectionSocketId;
  }

  /** التحقق من رمز الاستئناف (مقارنة ثابتة الزمن). */
  verifyResumeSecret(participantId: string, secret: string): boolean {
    const raw = this.resumeSecretsByParticipant.get(participantId);
    if (!raw) return false;
    try {
      const incoming = Buffer.from(String(secret).trim(), "base64url");
      if (incoming.length !== raw.length) return false;
      return timingSafeEqual(incoming, raw);
    } catch {
      return false;
    }
  }

  /** يُستدعى بعد أول استئناف ناجح لتضييق نافذة الرمز السابق. */
  rotateResumeSecret(participantId: string): string | null {
    if (this.finished || !this.players.has(participantId)) return null;
    const buf = randomBytes(32);
    this.resumeSecretsByParticipant.set(participantId, buf);
    return buf.toString("base64url");
  }

  canContinueAsSpectator(participantId: string): boolean {
    const p = this.players.get(participantId);
    return Boolean(p && p.eliminated && p.isSpectator);
  }

  /** إعادة بث تصويت الكابتن للغرفة بعد استئناف زميل (لا يعتمد على لقطة العميل فقط). */
  emitCaptainTeamVoteResyncToRoom(): void {
    if (!this.hasPrivateTeams() || this.privateTeamPlayMode() !== "teams_captain_approval") return;
    for (const [teamId, votes] of this.captainRoundVotes.entries()) {
      if (votes.size === 0) continue;
      this.lastTeamVoteWireKey.delete(teamId);
      this.emitTeamVoteUpdateIfChanged(teamId, votes);
    }
  }

  emitKeysRoomStateToSocketForParticipant(targetSocketId: string, participantId: string): void {
    const p = this.players.get(participantId);
    if (!p) return;
    const players = this.snapshotPlayers();
    const abilityCosts = this.snapshotAbilityCosts();
    const abilityToggles = this.snapshotAbilityToggles();
    this.io.to(targetSocketId).emit("keys_room_state", {
      revealKeysActive: this.hasRevealFor(participantId),
      macroRound: this.macroRound,
      players,
      abilityCosts,
      abilityToggles,
      keysAttacksEnabled: abilityToggles.heartAttack,
    });
  }

  /** هل يُسمح بربط مقبس جديد لهذا المقعد (مباراة جارية، غير منتهية كمقعد خارج). */
  canResumeTransport(participantId: string): boolean {
    if (!this.allowsTransportReconnect()) return false;
    if (this.finished) return false;
    const p = this.players.get(participantId);
    if (!p) return false;
    if (!p.eliminated) return true;
    return p.isSpectator;
  }

  /**
   * لقطة مزامنة للمقعد بعد استئناف النقل (حد أدنى من الحقول؛ يُوسَّع لاحقًا).
   */
  buildMatchStateSnapshot(forParticipantId: string): Record<string, unknown> | null {
    if (this.finished || !this.players.has(forParticipantId)) return null;
    const serverNow = Date.now();
    const abilityCosts = this.snapshotAbilityCosts();
    const abilityToggles = this.snapshotAbilityToggles();
    const players = this.snapshotPlayers();
    const gameStarted = {
      matchId: this.matchId,
      gameMode: this.gameMode,
      teamPlayMode: this.privateRuntime?.teamPlayMode,
      subcategoryKey: this.studySubcategoryKey ?? undefined,
      difficultyMode: this.difficultyMode,
      players,
      revealKeysActive: false,
      keysAttacksEnabled: abilityToggles.heartAttack,
      abilityCosts,
      abilityToggles,
    };
    const keysRoomState = {
      revealKeysActive: this.hasRevealFor(forParticipantId),
      macroRound: this.macroRound,
      players,
      abilityCosts,
      abilityToggles,
      keysAttacksEnabled: abilityToggles.heartAttack,
    };

    let question: Record<string, unknown> | null = null;
    if (
      this.currentQuestionId != null &&
      !this.roundClosed &&
      this.currentQuestionPrompt != null &&
      this.currentQuestionOptions != null
    ) {
      question = {
        questionId: this.currentQuestionId,
        prompt: this.currentQuestionPrompt,
        options: this.currentQuestionOptions,
        endsAt: this.answerDeadline,
        abilityGraceEndsAt: this.answerDeadline + ABILITY_GRACE_MS,
        serverNow,
        round: this.round,
        macroRound: this.macroRound,
        keysAttacksEnabled: abilityToggles.heartAttack,
        abilityCosts,
        abilityToggles,
        revealKeysActive: this.hasRevealFor(forParticipantId),
      };
    }

    let study: Record<string, unknown> | null = null;
    if (this.studyResyncBundle) {
      study = {
        study_phase: this.studyResyncBundle.study_phase,
        round_ready_window: this.studyResyncBundle.round_ready_window,
        round_ready_state: {
          roundToken: this.activeRoundToken,
          macroRound: this.macroRound,
          readyParticipantIds: [...this.roundReady],
          totalActive: this.countActiveForStudyRound(),
        },
      };
    }

    let teamVoteResync: Array<{
      teamId: string;
      votes: Record<string, number>;
      captainAwaitingSecondOn: number | null;
    }> | null = null;
    if (this.hasPrivateTeams() && this.privateTeamPlayMode() === "teams_captain_approval") {
      teamVoteResync = [...this.captainRoundVotes.entries()].map(([teamId, votes]) => ({
        teamId,
        votes: Object.fromEntries(votes),
        captainAwaitingSecondOn: this.captainAwaitingSecondOn.get(teamId) ?? null,
      }));
    }

    return {
      serverNow,
      reconnectGraceMs: MATCH_RECONNECT_GRACE_MS,
      matchPhaseHint: this.matchPhaseHint,
      gameStarted,
      keysRoomState,
      question,
      study,
      teamVoteResync,
    };
  }

  /** تكاليف القدرات للعميل (مزامنة مع الإدارة). */
  private snapshotAbilityCosts(): {
    skillBoost: number;
    skipQuestion: number;
    heartAttack: number;
    reveal: number;
  } {
    return {
      skillBoost: 1,
      skipQuestion: 1,
      heartAttack: this.keysHeartAttackCost,
      reveal: this.keysRevealCost,
    };
  }

  private snapshotAbilityToggles(): {
    skillBoost: boolean;
    skipQuestion: boolean;
    heartAttack: boolean;
    reveal: boolean;
  } {
    if (this.isSoloMatch) {
      return {
        skillBoost: false,
        skipQuestion: false,
        heartAttack: false,
        reveal: false,
      };
    }
    const isDirect = this.gameMode === "direct";
    return {
      skillBoost: isDirect ? this.abilitySkillBoostDirectEnabled : this.abilitySkillBoostStudyEnabled,
      skipQuestion: isDirect ? this.abilitySkipDirectEnabled : this.abilitySkipStudyEnabled,
      heartAttack: isDirect ? this.abilityAttackDirectEnabled : this.abilityAttackStudyEnabled,
      reveal: isDirect ? this.abilityRevealDirectEnabled : this.abilityRevealStudyEnabled,
    };
  }

  private isAbilityEnabled(kind: "skill_boost" | "skip" | "attack" | "reveal"): boolean {
    const toggles = this.snapshotAbilityToggles();
    if (kind === "skill_boost") return toggles.skillBoost;
    if (kind === "skip") return toggles.skipQuestion;
    if (kind === "attack") return toggles.heartAttack;
    return toggles.reveal;
  }

  private hasRevealFor(participantId: string): boolean {
    const rem = this.revealRemainingByParticipant.get(participantId) ?? 0;
    if (rem <= 0) return false;
    if (this.gameMode === "study_then_quiz" || this.gameMode === "lesson") {
      const mr = this.revealMacroRoundByParticipant.get(participantId);
      return mr === this.macroRound;
    }
    return true;
  }

  private emitKeysRoomState(): void {
    const players = this.snapshotPlayers();
    const abilityCosts = this.snapshotAbilityCosts();
    const abilityToggles = this.snapshotAbilityToggles();
    for (const [participantId, p] of this.players) {
      this.io.to(p.currentSocketId).emit("keys_room_state", {
        revealKeysActive: this.hasRevealFor(participantId),
        macroRound: this.macroRound,
        players,
        abilityCosts,
        abilityToggles,
        keysAttacksEnabled: abilityToggles.heartAttack,
      });
    }
  }

  private isParticipantActiveForTeam(p: MatchPlayerState): boolean {
    if (p.eliminated || p.isSpectator) return false;
    if (this.heartsFromAnswersDisabled) return true;
    return p.hearts > 0;
  }

  private countActive(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.eliminated && p.hearts > 0) n++;
    }
    return n;
  }

  private teamHasActiveMember(teamId: string): boolean {
    const snap = this.teamSnapshots.get(teamId);
    if (!snap) return false;
    return snap.memberParticipantIds.some((pid) => {
      const p = this.players.get(pid);
      return p && this.isParticipantActiveForTeam(p);
    });
  }

  private countActiveTeams(): number {
    let n = 0;
    for (const tid of this.teamSnapshots.keys()) {
      if (this.teamHasActiveMember(tid)) n++;
    }
    return n;
  }

  private hasEnoughActivePlayersForQuestions(): boolean {
    if (this.hasPrivateTeams()) {
      return this.countActiveTeams() > 1;
    }
    const active = this.countActive();
    return this.isSoloMatch ? active > 0 : active > 1;
  }

  private shouldDeclareWinnerForActiveCount(): boolean {
    if (this.hasPrivateTeams()) {
      return this.countActiveTeams() <= 1;
    }
    const active = this.countActive();
    return this.isSoloMatch ? active <= 0 : active <= 1;
  }

  private allActiveAnswered(): boolean {
    if (this.hasPrivateTeams()) {
      for (const teamId of this.teamSnapshots.keys()) {
        if (!this.teamHasActiveMember(teamId)) continue;
        if (!this.teamRoundSubmissions.has(teamId)) return false;
      }
      return true;
    }
    for (const [participantId, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;
      if (!this.pendingAnswers.has(participantId)) return false;
    }
    return true;
  }

  /** نافذة القدرات (أوسع من الإجابة بـ ABILITY_GRACE_MS بعد answerDeadline). */
  private isAbilityWindowOpen(): boolean {
    return (
      !this.finished &&
      !this.roundClosed &&
      this.currentQuestionId !== null &&
      Date.now() <= this.answerDeadline + ABILITY_GRACE_MS
    );
  }

  private clearQuestionTimers(): void {
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }
    if (this.abilityGraceTimer) {
      clearTimeout(this.abilityGraceTimer);
      this.abilityGraceTimer = null;
    }
  }

  private clearRevealIfNewMacro(): void {
    let changed = false;
    for (const [participantId, mr] of this.revealMacroRoundByParticipant.entries()) {
      if (mr !== null && this.macroRound > mr) {
        this.revealMacroRoundByParticipant.delete(participantId);
        this.revealRemainingByParticipant.delete(participantId);
        changed = true;
      }
    }
    if (changed) {
      this.emitKeysRoomState();
    }
  }

  private applyKeyGrants(p: MatchPlayerState): void {
    const streak = p.correctStreak;
    if (streak <= 0) return;
    let add = 0;
    if (streak % this.keysStreakPerKey === 0) add += this.keysSmallStreakReward;
    if (streak % this.keysMegaStreak === 0) add += this.keysMegaReward;
    if (add <= 0) return;
    const scaled = Math.floor(add * this.keysDropRate);
    if (scaled <= 0) return;
    p.keys = Math.min(this.keysMaxPerPlayer, p.keys + scaled);
  }

  private applySkillBoostToAward(base: number, stacks: number): number {
    if (base <= 0 || stacks <= 0) return base;
    const mult = Math.min(
      this.keysSkillBoostMaxMultiplier,
      2 ** stacks * (this.keysSkillBoostPercent / 100),
    );
    return Math.round(base * (1 + mult));
  }

  private damageHeart(participantId: string, p: MatchPlayerState, opts?: { skipIfHeartsDisabled?: boolean }): void {
    if (opts?.skipIfHeartsDisabled && this.heartsFromAnswersDisabled) return;
    p.hearts = Math.max(0, p.hearts - 1);
    if (p.hearts === 0) {
      this.revealRemainingByParticipant.delete(participantId);
      this.revealMacroRoundByParticipant.delete(participantId);
      p.eliminated = true;
      p.isSpectator = true;
      this.emitPlayerEliminated(participantId, p.name, "hearts");
      this.io.to(p.currentSocketId).emit("spectator_offer", {
        participantId,
        reason: "hearts",
      });
    }
  }

  markRoundReady(participantId: string): void {
    if (this.finished || (this.gameMode !== "study_then_quiz" && this.gameMode !== "lesson")) return;
    const p = this.players.get(participantId);
    if (!p || !this.isParticipantActiveForStudyRound(p)) return;
    this.roundReady.add(participantId);
    this.emitRoundReadyState();
    if (this.allActiveReadyForRound()) {
      this.clearRoundReadyWait();
    }
  }

  private allActiveReadyForRound(): boolean {
    for (const [participantId, p] of this.players) {
      if (!this.isParticipantActiveForStudyRound(p)) continue;
      if (!this.roundReady.has(participantId)) return false;
    }
    return true;
  }

  private countActiveForStudyRound(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (this.isParticipantActiveForStudyRound(p)) n++;
    }
    return n;
  }

  private emitRoundReadyState(): void {
    const readyParticipantIds = [...this.roundReady];
    this.io.to(this.room).emit("round_ready_state", {
      roundToken: this.activeRoundToken,
      macroRound: this.macroRound,
      readyParticipantIds,
      totalActive: this.countActiveForStudyRound(),
    });
  }

  private clearRoundReadyWait(): void {
    if (this.roundReadyTimer) {
      clearTimeout(this.roundReadyTimer);
      this.roundReadyTimer = null;
    }
    this.roundReadyResolve?.();
    this.roundReadyResolve = null;
  }

  private clearStudyWait(): void {
    this.clearRoundReadyWait();
    if (this.studyWaitTimer) {
      clearTimeout(this.studyWaitTimer);
      this.studyWaitTimer = null;
    }
    this.studyPhaseResolve?.();
    this.studyPhaseResolve = null;
  }

  recordAnswer(participantId: string, questionId: number, choiceIndex: number): void {
    if (this.finished || this.roundClosed) return;
    if (this.currentQuestionId !== questionId) return;
    if (Date.now() > this.answerDeadline) return;
    if (this.skipParticipantsForQuestion.has(participantId)) return;
    const p = this.players.get(participantId);
    if (!p || p.eliminated || p.isSpectator) return;
    if (!this.isParticipantActiveForTeam(p)) return;

    const tMode = this.privateTeamPlayMode();
    if (tMode === "teams_first_answer") {
      if (!p.teamId) return;
      const tid = p.teamId;
      if (this.isTeamSubmissionLocked(tid)) return;
      const skillBoostStacksAtLock = p.skillBoostStacks;
      this.teamRoundSubmissions.set(tid, {
        byParticipantId: participantId,
        choiceIndex,
        at: Date.now(),
        skillBoostStacksAtLock,
      });
      this.pendingAnswers.set(participantId, choiceIndex);
      this.answerTimes.set(participantId, Date.now());
      this.io.to(this.room).emit("team_answer_locked", {
        teamId: tid,
        participantId,
        choiceIndex,
        mode: "teams_first_answer",
      });
      if (this.allActiveAnswered()) {
        this.clearQuestionTimers();
        this.finishRound();
      }
      return;
    }
    if (tMode === "teams_captain_approval") {
      if (!p.teamId) return;
      const tid = p.teamId;
      if (this.isTeamSubmissionLocked(tid)) return;
      if (!this.captainRoundVotes.has(tid)) this.captainRoundVotes.set(tid, new Map());
      const votes = this.captainRoundVotes.get(tid)!;
      if (p.isCaptain) {
        const awaiting = this.captainAwaitingSecondOn.get(tid) ?? null;
        if (awaiting === choiceIndex) {
          const stacksAtLock = p.skillBoostStacks;
          this.teamRoundSubmissions.set(tid, {
            byParticipantId: participantId,
            choiceIndex,
            at: Date.now(),
            skillBoostStacksAtLock: stacksAtLock,
          });
          votes.set(participantId, choiceIndex);
          this.captainAwaitingSecondOn.delete(tid);
          this.lastTeamVoteWireKey.delete(tid);
          this.io.to(this.room).emit("team_submitted", {
            teamId: tid,
            captainParticipantId: participantId,
            choiceIndex,
          });
          if (this.allActiveAnswered()) {
            this.clearQuestionTimers();
            this.finishRound();
          }
        } else {
          votes.set(participantId, choiceIndex);
          this.captainAwaitingSecondOn.set(tid, choiceIndex);
          this.emitTeamVoteUpdateIfChanged(tid, votes);
        }
      } else {
        votes.set(participantId, choiceIndex);
        this.emitTeamVoteUpdateIfChanged(tid, votes);
      }
      return;
    }

    if (this.pendingAnswers.has(participantId)) return;
    this.pendingAnswers.set(participantId, choiceIndex);
    this.answerTimes.set(participantId, Date.now());
    if (this.allActiveAnswered()) {
      this.clearQuestionTimers();
      this.finishRound();
    }
  }

  canAcceptChoice(questionId: number, choiceIndex: number): boolean {
    if (this.currentQuestionId !== questionId) return false;
    const optionsCount = this.currentOptionsCount ?? 0;
    if (optionsCount <= 0) return false;
    return Number.isInteger(choiceIndex) && choiceIndex >= 0 && choiceIndex < optionsCount;
  }

  handleDisconnect(participantId: string): void {
    if (this.finished) return;
    const p = this.players.get(participantId);
    if (!p || p.eliminated) return;
    if (p.teamId && this.privateTeamPlayMode() === "teams_captain_approval") {
      const votes = this.captainRoundVotes.get(p.teamId);
      if (votes?.delete(participantId)) {
        this.emitTeamVoteUpdateIfChanged(p.teamId, votes);
      }
    }
    this.reassignCaptainAfterMemberLeft(participantId);
    this.revealRemainingByParticipant.delete(participantId);
    this.revealMacroRoundByParticipant.delete(participantId);
    p.hearts = 0;
    p.eliminated = true;
    p.isSpectator = false;
    this.emitPlayerEliminated(participantId, p.name, "disconnect");
    if (this.shouldDeclareWinnerForActiveCount() && !this.finished) {
      this.clearQuestionTimers();
      this.clearStudyWait();
      this.roundClosed = true;
      this.currentQuestionId = null;
      this.currentCorrectIndex = null;
      this.currentOptionsCount = null;
      this.resolveRound?.();
      this.resolveRound = null;
      this.declareWinner();
    }
  }

  private async runStudyPhase(
    cards: Array<{ id: number; questionId: number; body: string; order: number }>,
  ): Promise<void> {
    this.activeRoundToken = `${this.matchId}:${this.macroRound}:${Date.now()}`;
    this.roundReady.clear();
    this.clearRoundReadyWait();
    const now = Date.now();
    const readyWindowMs = this.studyPhaseMs;
    const readyStartsAt = now;
    const studyStartsAt = now;
    const readyEndsAt = readyStartsAt + (readyWindowMs || DEFAULT_ROUND_READY_MS);
    const studyEndsAt = studyStartsAt + this.studyPhaseMs;

    const studyPhasePayload = {
      cards,
      roundToken: this.activeRoundToken,
      startsAt: studyStartsAt,
      endsAt: studyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
      scope: "match_start",
    };
    const roundReadyPayload = {
      roundToken: this.activeRoundToken,
      startsAt: readyStartsAt,
      endsAt: readyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
    };
    this.studyResyncBundle = {
      study_phase: { ...studyPhasePayload },
      round_ready_window: { ...roundReadyPayload },
    };
    this.matchPhaseHint = "study";
    this.io.to(this.room).emit("study_phase", studyPhasePayload);

    this.io.to(this.room).emit("round_ready_window", roundReadyPayload);
    this.emitRoundReadyState();

    const waitReady = new Promise<void>((resolve) => {
      this.roundReadyResolve = resolve;
      this.roundReadyTimer = setTimeout(() => {
        this.roundReadyTimer = null;
        this.roundReadyResolve = null;
        this.io.to(this.room).emit("round_ready_closed", {
          roundToken: this.activeRoundToken,
          startsAt: readyStartsAt,
          endsAt: readyEndsAt,
          serverNow: Date.now(),
          macroRound: this.macroRound,
        });
      }, Math.max(0, readyEndsAt - Date.now()));
    });

    const waitStudy = new Promise<void>((resolve) => {
      this.studyPhaseResolve = resolve;
      this.studyWaitTimer = setTimeout(() => {
        this.studyWaitTimer = null;
        this.studyPhaseResolve = null;
        resolve();
      }, Math.max(0, studyEndsAt - Date.now()));
    });

    await Promise.race([waitReady, waitStudy]);
    this.clearRoundReadyWait();
    this.clearStudyWait();

    this.io.to(this.room).emit("study_phase_end", {
      roundToken: this.activeRoundToken,
      macroRound: this.macroRound,
      startsAt: studyStartsAt,
      studyEndsAt,
      serverNow: Date.now(),
    });
    this.matchPhaseHint = "between";
  }

  private async loadRuntimeSettings(): Promise<void> {
    try {
      const now = Date.now();
      let map: Map<string, string>;
      const cached = Match.runtimeSettingsCache;
      if (cached && now - cached.loadedAtMs <= RUNTIME_SETTINGS_CACHE_MS) {
        map = cached.map;
      } else {
        const pool = getPool();
        const rows = await pool.query<{ key: string; value: string }>(
          `SELECT key, value
           FROM public.app_settings
           WHERE key IN (
             'game_max_study_rounds', 'game_study_round_size', 'game_study_phase_ms', 'game_question_ms',
             'keys_streak_per_key', 'keys_small_streak_reward', 'keys_mega_streak', 'keys_mega_reward', 'keys_max_per_player',
             'keys_skill_boost_percent', 'keys_skill_boost_max_multiplier',
             'keys_heart_attack_cost', 'keys_shield_cost', 'keys_reveal_cost',
             'keys_reveal_questions_direct', 'keys_reveal_questions_study',
             'keys_drop_rate',
             'ability_skill_boost_direct_enabled', 'ability_skill_boost_study_enabled',
             'ability_skip_direct_enabled', 'ability_skip_study_enabled',
             'ability_attack_direct_enabled', 'ability_attack_study_enabled',
             'ability_reveal_direct_enabled', 'ability_reveal_study_enabled'
           )`,
        );
        map = new Map(rows.rows.map((r) => [r.key, r.value]));
        Match.runtimeSettingsCache = {
          loadedAtMs: now,
          map,
        };
      }
      const maxRounds = Number(map.get("game_max_study_rounds") ?? DEFAULT_MAX_STUDY_ROUNDS);
      const roundSize = Number(map.get("game_study_round_size") ?? DEFAULT_STUDY_ROUND_SIZE);
      this.maxStudyRounds = Math.min(10, Math.max(1, Number.isFinite(maxRounds) ? maxRounds : DEFAULT_MAX_STUDY_ROUNDS));
      this.studyRoundSize = Math.min(30, Math.max(1, Number.isFinite(roundSize) ? roundSize : DEFAULT_STUDY_ROUND_SIZE));
      this.questionMs = resolveQuestionMsFromAppSetting(map.get("game_question_ms"));
      this.studyPhaseMs = resolveStudyPhaseMsFromAppSetting(map.get("game_study_phase_ms"));

      this.keysStreakPerKey = Math.min(50, Math.max(1, Number(map.get("keys_streak_per_key") ?? 5)));
      this.keysSmallStreakReward = Math.min(50, Math.max(0, Number(map.get("keys_small_streak_reward") ?? 1)));
      this.keysMegaStreak = Math.min(50, Math.max(1, Number(map.get("keys_mega_streak") ?? 8)));
      this.keysMegaReward = Math.min(50, Math.max(0, Number(map.get("keys_mega_reward") ?? 5)));
      this.keysMaxPerPlayer = Math.min(100, Math.max(1, Number(map.get("keys_max_per_player") ?? 20)));
      this.keysSkillBoostPercent = Math.min(200, Math.max(1, Number(map.get("keys_skill_boost_percent") ?? 30)));
      this.keysSkillBoostMaxMultiplier = Math.min(5, Math.max(1, Number(map.get("keys_skill_boost_max_multiplier") ?? 3)));
      this.keysHeartAttackCost = Math.min(20, Math.max(1, Number(map.get("keys_heart_attack_cost") ?? 2)));
      this.keysShieldCost = Math.min(20, Math.max(1, Number(map.get("keys_shield_cost") ?? 2)));
      this.keysRevealCost = Math.min(20, Math.max(1, Number(map.get("keys_reveal_cost") ?? 2)));
      this.keysRevealQuestionsDirect = Math.min(30, Math.max(0, Math.floor(Number(map.get("keys_reveal_questions_direct") ?? 4))));
      this.keysRevealQuestionsStudy = Math.min(30, Math.max(0, Math.floor(Number(map.get("keys_reveal_questions_study") ?? 4))));
      this.keysDropRate = Math.min(5, Math.max(0, Number(map.get("keys_drop_rate") ?? 1)));
      this.abilitySkillBoostDirectEnabled = String(map.get("ability_skill_boost_direct_enabled") ?? "1").trim() !== "0";
      this.abilitySkillBoostStudyEnabled = String(map.get("ability_skill_boost_study_enabled") ?? "1").trim() !== "0";
      this.abilitySkipDirectEnabled = String(map.get("ability_skip_direct_enabled") ?? "1").trim() !== "0";
      this.abilitySkipStudyEnabled = String(map.get("ability_skip_study_enabled") ?? "1").trim() !== "0";
      this.abilityAttackDirectEnabled = String(map.get("ability_attack_direct_enabled") ?? "1").trim() !== "0";
      this.abilityAttackStudyEnabled = String(map.get("ability_attack_study_enabled") ?? "1").trim() !== "0";
      this.abilityRevealDirectEnabled = String(map.get("ability_reveal_direct_enabled") ?? "1").trim() !== "0";
      this.abilityRevealStudyEnabled = String(map.get("ability_reveal_study_enabled") ?? "1").trim() !== "0";
      if (this.timeOverrides?.questionMsOverride !== undefined) {
        this.questionMs = clampGameQuestionMs(this.timeOverrides.questionMsOverride);
      }
      if (this.timeOverrides?.studyPhaseMsOverride !== undefined) {
        this.studyPhaseMs = clampGameStudyPhaseMs(this.timeOverrides.studyPhaseMsOverride);
      }
    } catch {
      this.maxStudyRounds = DEFAULT_MAX_STUDY_ROUNDS;
      this.studyRoundSize = DEFAULT_STUDY_ROUND_SIZE;
      this.questionMs = DEFAULT_GAME_QUESTION_MS;
      this.studyPhaseMs = DEFAULT_GAME_STUDY_PHASE_MS;
      this.keysSmallStreakReward = 1;
      this.keysRevealQuestionsDirect = 4;
      this.keysRevealQuestionsStudy = 4;
      if (this.timeOverrides?.questionMsOverride !== undefined) {
        this.questionMs = clampGameQuestionMs(this.timeOverrides.questionMsOverride);
      }
      if (this.timeOverrides?.studyPhaseMsOverride !== undefined) {
        this.studyPhaseMs = clampGameStudyPhaseMs(this.timeOverrides.studyPhaseMsOverride);
      }
    }
  }

  async run(): Promise<void> {
    const startupAt = Date.now();
    await this.loadRuntimeSettings();
    const loadRuntimeMs = Date.now() - startupAt;
    this.io.to(this.room).emit("game_started", {
      matchId: this.matchId,
      gameMode: this.gameMode,
      teamPlayMode: this.privateRuntime?.teamPlayMode,
      subcategoryKey: this.studySubcategoryKey ?? undefined,
      difficultyMode: this.difficultyMode,
      players: this.snapshotPlayers(),
      revealKeysActive: false,
      keysAttacksEnabled: this.snapshotAbilityToggles().heartAttack,
      abilityCosts: this.snapshotAbilityCosts(),
      abilityToggles: this.snapshotAbilityToggles(),
    });
    if (this.allowsTransportReconnect()) {
      for (const [pid, pl] of this.players) {
        const resumeSecret = this.resumeSecretsByParticipant.get(pid)?.toString("base64url");
        if (resumeSecret) {
          this.io.to(pl.currentSocketId).emit("match_resume_token", {
            matchId: this.matchId,
            participantId: pid,
            resumeSecret,
            reconnectGraceMs: MATCH_RECONNECT_GRACE_MS,
          });
        }
      }
    }
    console.debug(`[matchmaking] runtime_settings_loaded_ms=${loadRuntimeMs} match=${this.matchId} mode=${this.gameMode}`);
    this.emitKeysRoomState();

    const pool = getPool();
    this.resultMessages = await getResultMessages(pool);

    if (this.gameMode === "direct") {
      await this.runDirectQuestionLoop(pool);
    } else if (this.gameMode === "lesson") {
      await this.runLessonMatchLoop(pool);
    } else {
      await this.runStudyThenQuizLoop(pool);
    }

    if (!this.finished) {
      this.declareWinner();
    }
  }

  private async runDirectQuestionLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    while (!this.finished && this.hasEnoughActivePlayersForQuestions() && this.round < MAX_ROUNDS) {
      const q = await getRandomQuestion(
        pool,
        this.usedQuestionIds,
        false,
        this.difficultyMode !== "mix" ? { difficulty: this.difficultyMode } : undefined,
      );
      if (!q) {
        this.emitNoQuestions();
        return;
      }
      await this.playOneQuestion(pool, q);
      if (this.finished) return;
    }
    if (
      !this.finished &&
      this.isSoloMatch &&
      this.gameMode === "direct" &&
      this.hasEnoughActivePlayersForQuestions() &&
      this.round >= MAX_ROUNDS
    ) {
      this.soloDirectReachedFullCourse = true;
    }
  }

  private async runLessonStudyPhase(
    cards: StudyPhaseCardPayload[],
    phaseMs: number,
    sectionMeta?: {
      lessonSectionIndex: number;
      lessonSectionCount: number;
      lessonSectionTitle: string | null;
    },
  ): Promise<void> {
    if (cards.length === 0 || phaseMs <= 0) return;
    this.activeRoundToken = `${this.matchId}:${this.macroRound}:${Date.now()}`;
    this.roundReady.clear();
    this.clearRoundReadyWait();
    const now = Date.now();
    const readyWindowMs = phaseMs;
    const readyStartsAt = now;
    const studyStartsAt = now;
    const readyEndsAt = readyStartsAt + (readyWindowMs || DEFAULT_ROUND_READY_MS);
    const studyEndsAt = studyStartsAt + phaseMs;

    const studyPhasePayload = {
      cards,
      roundToken: this.activeRoundToken,
      startsAt: studyStartsAt,
      endsAt: studyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
      scope: "lesson" as const,
      ...sectionMeta,
    };
    const roundReadyPayload = {
      roundToken: this.activeRoundToken,
      startsAt: readyStartsAt,
      endsAt: readyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
    };
    this.studyResyncBundle = {
      study_phase: { ...studyPhasePayload },
      round_ready_window: { ...roundReadyPayload },
    };
    this.matchPhaseHint = "study";
    this.io.to(this.room).emit("study_phase", studyPhasePayload);

    this.io.to(this.room).emit("round_ready_window", roundReadyPayload);
    this.emitRoundReadyState();

    const waitReady = new Promise<void>((resolve) => {
      this.roundReadyResolve = resolve;
      this.roundReadyTimer = setTimeout(() => {
        this.roundReadyTimer = null;
        this.roundReadyResolve = null;
        this.io.to(this.room).emit("round_ready_closed", {
          roundToken: this.activeRoundToken,
          startsAt: readyStartsAt,
          endsAt: readyEndsAt,
          serverNow: Date.now(),
          macroRound: this.macroRound,
        });
      }, Math.max(0, readyEndsAt - Date.now()));
    });

    const waitStudy = new Promise<void>((resolve) => {
      this.studyPhaseResolve = resolve;
      this.studyWaitTimer = setTimeout(() => {
        this.studyWaitTimer = null;
        this.studyPhaseResolve = null;
        resolve();
      }, Math.max(0, studyEndsAt - Date.now()));
    });

    await Promise.race([waitReady, waitStudy]);
    this.clearRoundReadyWait();
    this.clearStudyWait();

    this.io.to(this.room).emit("study_phase_end", {
      roundToken: this.activeRoundToken,
      macroRound: this.macroRound,
      startsAt: studyStartsAt,
      studyEndsAt,
      serverNow: Date.now(),
      ...sectionMeta,
    });
    this.matchPhaseHint = "between";
  }

  private async runLessonMatchLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    void pool;
    const playback = this.lessonPlayback;
    if (!playback || playback.steps.length === 0) {
      this.emitNoQuestions();
      return;
    }
    this.lessonAnswerHistory.clear();
    for (const participantId of this.players.keys()) {
      this.lessonAnswerHistory.set(participantId, []);
    }

    const sections =
      playback.sections.length > 0
        ? playback.sections
        : [
            {
              id: 0,
              sortOrder: 0,
              titleAr: null as string | null,
              studyPhaseMs: lessonStudyPhaseTotalMsForSteps(playback.steps),
              steps: playback.steps,
            },
          ];

    const sectionCount = sections.length;

    for (let si = 0; si < sections.length; si++) {
      const sec = sections[si];
      if (this.finished) return;
      this.macroRound = si + 1;
      this.clearRevealIfNewMacro();

      const sectionMeta = {
        lessonSectionIndex: si,
        lessonSectionCount: sectionCount,
        lessonSectionTitle: sec.titleAr,
      };

      const studyCards = lessonPlaybackToStudyCardsFromSteps(sec.steps);
      const phaseMs = sec.studyPhaseMs ?? lessonStudyPhaseTotalMsForSteps(sec.steps);
      if (studyCards.length > 0) {
        await this.runLessonStudyPhase(studyCards, phaseMs, sectionMeta);
        if (this.finished) return;
      } else {
        const now = Date.now();
        this.io.to(this.room).emit("study_phase", {
          cards: [],
          roundToken: `${this.matchId}:${this.macroRound}:${now}`,
          startsAt: now,
          endsAt: now,
          serverNow: now,
          macroRound: this.macroRound,
          scope: "lesson",
          ...sectionMeta,
        });
      }

      for (const step of sec.steps) {
        if (this.finished || !this.hasEnoughActivePlayersForQuestions() || this.round >= MAX_ROUNDS) {
          return;
        }
        const q = lessonStepToQuestionRow(step);
        const answerMs =
          this.timeOverrides?.questionMsOverride != null
            ? this.timeOverrides.questionMsOverride
            : step.effectiveAnswerMs;
        await this.playOneQuestion(pool, q, answerMs);
      }
    }
  }

  private async runStudyThenQuizLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    const blockSize = this.studyRoundSize;
    const maxCardsPerBlock = this.studyRoundSize;

    while (
      !this.finished &&
      this.hasEnoughActivePlayersForQuestions() &&
      this.macroRound < this.maxStudyRounds
    ) {
      this.macroRound += 1;
      this.clearRevealIfNewMacro();

      const block: QuestionRow[] = [];
      const exclude = new Set<number>(this.usedQuestionIds);
      for (let i = 0; i < blockSize; i++) {
        const q = await getRandomQuestion(
          pool,
          [...exclude],
          true,
          this.studySubcategoryKey || this.difficultyMode !== "mix"
            ? {
                subcategoryKey: this.studySubcategoryKey,
                difficulty: this.difficultyMode !== "mix" ? this.difficultyMode : null,
              }
            : undefined,
        );
        if (!q) {
          this.emitNoQuestions();
          return;
        }
        exclude.add(q.id);
        block.push(q);
      }

      const blockIds = block.map((q) => q.id);
      const cards = await getStudyPhaseCardsFromQuestionIds(
        pool,
        blockIds,
        Math.min(maxCardsPerBlock, blockIds.length),
      );
      if (cards.length !== block.length) {
        this.emitNoQuestions();
        return;
      }
      await this.runStudyPhase(cards);
      if (this.finished) return;

      for (const q of block) {
        if (this.finished || !this.hasEnoughActivePlayersForQuestions() || this.round >= MAX_ROUNDS) {
          return;
        }
        await this.playOneQuestion(pool, q);
      }
    }
    if (
      !this.finished &&
      this.isSoloMatch &&
      this.gameMode === "study_then_quiz" &&
      this.hasEnoughActivePlayersForQuestions() &&
      this.macroRound >= this.maxStudyRounds
    ) {
      this.soloStudyQuizReachedFullCourse = true;
    }
  }

  private emitNoQuestions(): void {
    this.studyResyncBundle = null;
    this.matchPhaseHint = "idle";
    const rm = this.resultMessages ?? {
      winner: "",
      loser: "",
      tie: "",
    };
    this.io.to(this.room).emit("game_over", {
      reason: "no_questions",
      outcomeType: "no_questions",
      winner: null,
      winners: [],
      players: this.snapshotPlayers(),
      resultMessages: rm,
    });
    this.finished = true;
  }

  /**
   * يضبط حقول بداية السؤال الحي (يُصفّر حزمة المذاكرة هنا فقط بعد انتقال واضح إلى السؤال).
   * @returns مدة نافذة الإجابة بالمللي ثانية.
   */
  private beginLiveQuestionState(q: QuestionRow, answerMsOverride?: number): number {
    this.clearQuestionTimers();
    this.usedQuestionIds.push(q.id);
    this.round++;
    this.roundClosed = false;
    this.skipParticipantsForQuestion.clear();
    this.currentQuestionId = q.id;
    this.currentCorrectIndex = q.correct_index;
    this.currentOptionsCount = q.options.length;
    this.currentQuestionPrompt = q.prompt;
    this.currentQuestionOptions = [...q.options];
    this.studyResyncBundle = null;
    this.matchPhaseHint = "question";
    this.questionStartedAt = Date.now();
    const windowMs = Math.min(
      120_000,
      Math.max(5_000, answerMsOverride ?? this.questionMs),
    );
    this.answerDeadline = Date.now() + windowMs;
    this.pendingAnswers.clear();
    this.answerTimes.clear();
    this.clearPerQuestionTeamState();
    return windowMs;
  }

  private async playOneQuestion(
    pool: ReturnType<typeof getPool>,
    q: QuestionRow,
    answerMsOverride?: number,
  ): Promise<void> {
    void pool;
    const windowMs = this.beginLiveQuestionState(q, answerMsOverride);

    const waitRound = new Promise<void>((resolve) => {
      this.resolveRound = resolve;
    });

    const abilityToggles = this.snapshotAbilityToggles();
    const abilityCosts = this.snapshotAbilityCosts();
    const baseQuestionPayload = {
      questionId: q.id,
      prompt: q.prompt,
      options: q.options,
      endsAt: this.answerDeadline,
      abilityGraceEndsAt: this.answerDeadline + ABILITY_GRACE_MS,
      serverNow: Date.now(),
      round: this.round,
      macroRound: this.macroRound,
      keysAttacksEnabled: abilityToggles.heartAttack,
      abilityCosts,
      abilityToggles,
    };
    for (const [participantId, p] of this.players) {
      this.io.to(p.currentSocketId).emit("question", {
        ...baseQuestionPayload,
        revealKeysActive: this.hasRevealFor(participantId),
      });
    }

    this.questionTimer = setTimeout(() => {
      this.questionTimer = null;
      if (this.roundClosed || this.finished) return;
      this.abilityGraceTimer = setTimeout(() => {
        this.abilityGraceTimer = null;
        this.finishRound();
      }, ABILITY_GRACE_MS);
    }, windowMs);
    await waitRound;

    if (this.shouldDeclareWinnerForActiveCount() && !this.finished) {
      this.declareWinner();
    }
  }

  /**
   * يُجمّع نتائج السؤال ويُغلق الجولة؛ يُستدعى عادةً بعد انتهاء المؤقت أو اكتمال الإجابات.
   * مسارات أخرى (مثل انقطاع يُقصي اللاعبين) قد تستدعي declareWinner دون المرور بكل جولة إن انتهى النشاط.
   */
  private finishRound(): void {
    if (this.roundClosed || this.finished) return;
    this.roundClosed = true;
    this.clearQuestionTimers();

    const questionId = this.currentQuestionId;
    const correctIndex = this.currentCorrectIndex ?? 0;
    this.currentQuestionId = null;
    this.currentCorrectIndex = null;
    this.currentOptionsCount = null;
    this.currentQuestionPrompt = null;
    this.currentQuestionOptions = null;

    const results: Array<{
      participantId: string;
      correct: boolean;
      skipped?: boolean;
      choiceIndex?: number | null;
      pointsAward: number;
      hearts: number;
      eliminated: boolean;
    }> = [];

    if (this.hasPrivateTeams()) {
      this.runTeamRoundScoring(results, correctIndex);
    } else {
      for (const [participantId, p] of this.players) {
        if (p.eliminated || (!this.heartsFromAnswersDisabled && p.hearts <= 0)) continue;

        if (this.skipParticipantsForQuestion.has(participantId)) {
          p.lastAward = 0;
          results.push({
            participantId,
            correct: false,
            skipped: true,
            choiceIndex: null,
            pointsAward: 0,
            hearts: p.hearts,
            eliminated: p.eliminated,
          });
          continue;
        }

        const choice = this.pendingAnswers.get(participantId);
        const answered = choice !== undefined;
        const choiceIndexForResult: number | null = answered ? choice! : null;
        const correct = answered && choice === correctIndex;
        let pointsAward = 0;

        if (correct) {
          p.correctStreak += 1;
          this.applyKeyGrants(p);
          const answeredAt = this.answerTimes.get(participantId) ?? this.answerDeadline;
          const totalWindow = Math.max(1, this.answerDeadline - this.questionStartedAt);
          const progress = Math.min(
            1,
            Math.max(0, (answeredAt - this.questionStartedAt) / totalWindow),
          );
          const base = Math.round(100 - progress * 99);
          pointsAward = this.applySkillBoostToAward(base, p.skillBoostStacks);
          p.skillPoints += pointsAward;
        } else {
          p.correctStreak = 0;
          p.lastAward = 0;
          if (!this.heartsFromAnswersDisabled) {
            p.hearts = Math.max(0, p.hearts - 1);
            if (p.hearts === 0) {
              p.eliminated = true;
              p.isSpectator = true;
              this.emitPlayerEliminated(participantId, p.name, "hearts");
              this.io.to(p.currentSocketId).emit("spectator_offer", {
                participantId,
                reason: "hearts",
              });
            }
          }
          results.push({
            participantId,
            correct: false,
            choiceIndex: choiceIndexForResult,
            pointsAward: 0,
            hearts: p.hearts,
            eliminated: p.eliminated,
          });
          continue;
        }

        p.lastAward = pointsAward;
        results.push({
          participantId,
          correct: true,
          choiceIndex: choiceIndexForResult,
          pointsAward,
          hearts: p.hearts,
          eliminated: p.eliminated,
        });
      }
    }

    if (this.gameMode === "lesson" && questionId != null && this.lessonPlayback) {
      const step = this.lessonPlayback.steps.find((s) => s.questionId === questionId);
      if (step) {
        for (const r of results) {
          const list = this.lessonAnswerHistory.get(r.participantId);
          if (!list) continue;
          list.push({
            questionId,
            choiceIndex: r.choiceIndex ?? null,
            correctIndex,
            prompt: step.prompt,
            options: step.options,
            studyBody: step.studyBody,
          });
        }
      }
    }

    for (const [participantId, rem] of this.revealRemainingByParticipant.entries()) {
      if (rem <= 0) continue;
      const next = rem - 1;
      if (next <= 0) {
        this.revealRemainingByParticipant.delete(participantId);
        this.revealMacroRoundByParticipant.delete(participantId);
      } else {
        this.revealRemainingByParticipant.set(participantId, next);
      }
    }

    const players = this.snapshotPlayers();
    const abilityToggles = this.snapshotAbilityToggles();
    const abilityCosts = this.snapshotAbilityCosts();
    const baseResultPayload = {
      questionId,
      correctIndex,
      results,
      players,
      macroRound: this.macroRound,
      keysAttacksEnabled: abilityToggles.heartAttack,
      abilityCosts,
      abilityToggles,
      ...(this.hasPrivateTeams() ? { teamScores: this.snapshotTeamScoresPayload() } : {}),
    };
    for (const [participantId, p] of this.players) {
      this.io.to(p.currentSocketId).emit("question_result", {
        ...baseResultPayload,
        revealKeysActive: this.hasRevealFor(participantId),
      });
    }

    this.resolveRound?.();
    this.resolveRound = null;

    if (this.shouldDeclareWinnerForActiveCount()) {
      this.declareWinner();
    }
  }

  private emitFinishedGameOver(payload: Record<string, unknown>): void {
    if (this.gameMode === "lesson") {
      for (const [participantId, p] of this.players) {
        this.io.to(p.currentSocketId).emit("game_over", {
          ...payload,
          lessonReview: this.lessonAnswerHistory.get(participantId) ?? [],
        });
      }
      return;
    }
    this.io.to(this.room).emit("game_over", payload);
  }

  /** نجوم المباراة: الرتب 1–3 مع من يتساوون في أي منها (لا يُقتطع عند 3 صفوف فقط). */
  private buildStarsOfTheMatch(): Array<{
    rank: number;
    participantId: string;
    userId: string | null;
    name: string;
    individualPoints: number;
    teamId: string | null;
  }> {
    const rows = [...this.players.entries()]
      .map(([participantId, pl]) => ({
        participantId,
        userId: pl.userId,
        name: pl.name,
        skillPoints: pl.skillPoints,
        teamId: pl.teamId,
      }))
      .sort((a, b) => b.skillPoints - a.skillPoints);
    if (rows.length === 0) return [];
    let rank = 0;
    let lastScore: number | null = null;
    const ranked = rows.map((row, idx) => {
      if (lastScore === null || row.skillPoints !== lastScore) {
        rank = idx + 1;
        lastScore = row.skillPoints;
      }
      return { ...row, rank };
    });
    return ranked
      .filter((r) => r.rank <= 3)
      .map((r) => ({
        rank: r.rank,
        participantId: r.participantId,
        userId: r.userId,
        name: r.name,
        individualPoints: r.skillPoints,
        teamId: r.teamId,
      }));
  }

  private declareTeamMatchEnd(): void {
    if (this.finished) return;
    this.finished = true;
    this.studyResyncBundle = null;
    this.matchPhaseHint = "idle";
    this.clearStudyWait();
    this.clearQuestionTimers();

    const byTeam = [...this.teamScores.entries()]
      .map(([teamId, teamScore]) => {
        const snap = this.teamSnapshots.get(teamId);
        return {
          teamId,
          displayName: snap?.displayName ?? teamId,
          teamScore,
        };
      })
      .sort((a, b) => b.teamScore - a.teamScore);

    let rankCounter = 0;
    let lastScore: number | null = null;
    const teamLeaderboard = byTeam.map((row, idx) => {
      if (lastScore === null || row.teamScore !== lastScore) {
        rankCounter = idx + 1;
        lastScore = row.teamScore;
      }
      const medal =
        rankCounter === 1 ? "gold" : rankCounter === 2 ? "silver" : rankCounter === 3 ? "bronze" : null;
      return {
        rank: rankCounter,
        teamId: row.teamId,
        displayName: row.displayName,
        teamScore: row.teamScore,
        medal,
      };
    });

    const starsOfTheMatch = this.buildStarsOfTheMatch();

    const top = byTeam[0]?.teamScore ?? 0;
    const winningTeams = top > 0 ? byTeam.filter((t) => t.teamScore === top) : [];

    const bySkillDesc = [...this.players.entries()]
      .map(([participantId, p]) => ({
        participantId,
        userId: p.userId,
        name: p.name,
        skillPoints: p.skillPoints,
        hearts: p.hearts,
        eliminated: p.eliminated,
      }))
      .sort((a, b) => b.skillPoints - a.skillPoints);
    let lr = 0;
    let ls: number | null = null;
    const leaderboard = bySkillDesc.map((row, idx) => {
      if (ls === null || row.skillPoints !== ls) {
        lr = idx + 1;
        ls = row.skillPoints;
      }
      const medal =
        lr === 1 ? "gold" : lr === 2 ? "silver" : lr === 3 ? "bronze" : null;
      return {
        participantId: row.participantId,
        userId: row.userId,
        name: row.name,
        skillPoints: row.skillPoints,
        rank: lr,
        medal,
      };
    });

    const rm = this.resultMessages ?? {
      winner: "",
      loser: "",
      tie: "",
    };
    this.emitFinishedGameOver({
      reason: "finished",
      outcomeType: "team_match",
      teamLeaderboard,
      starsOfTheMatch,
      winningTeams,
      winner: null,
      winners: [],
      players: this.snapshotPlayers(),
      resultMessages: rm,
      leaderboard,
    });
  }

  private declareWinner(): void {
    if (this.finished) return;
    if (this.hasPrivateTeams()) {
      this.declareTeamMatchEnd();
      return;
    }
    this.finished = true;
    this.studyResyncBundle = null;
    this.matchPhaseHint = "idle";
    this.clearStudyWait();
    this.clearQuestionTimers();

    const bySkillDesc = [...this.players.entries()]
      .map(([participantId, p]) => ({
        participantId,
        userId: p.userId,
        name: p.name,
        skillPoints: p.skillPoints,
        hearts: p.hearts,
        eliminated: p.eliminated,
      }))
      .sort((a, b) => b.skillPoints - a.skillPoints);

    const alivePlayers = bySkillDesc.filter((p) => !p.eliminated && p.hearts > 0);
    const isSoloStudyQuiz = this.isSoloMatch && this.gameMode === "study_then_quiz";
    const isSoloDirect = this.isSoloMatch && this.gameMode === "direct";
    const soloRequiresFullCourse = isSoloStudyQuiz || isSoloDirect;
    const soloReachedFullCourse = isSoloStudyQuiz
      ? this.soloStudyQuizReachedFullCourse
      : isSoloDirect
        ? this.soloDirectReachedFullCourse
        : false;

    const emitSoloIncomplete = (reason: "eliminated" | "solo_path_incomplete"): void => {
      const rm = this.resultMessages ?? {
        winner: "",
        loser: "",
        tie: "",
      };
      const leaderboard = bySkillDesc.map((row, idx) => ({
        participantId: row.participantId,
        userId: row.userId,
        name: row.name,
        skillPoints: row.skillPoints,
        rank: idx + 1,
        medal: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : null,
      }));
      this.emitFinishedGameOver({
        reason,
        outcomeType: "solo_incomplete",
        winner: null,
        winners: [],
        players: this.snapshotPlayers(),
        resultMessages: rm,
        leaderboard,
      });
    };

    if (this.isSoloMatch && alivePlayers.length === 0) {
      emitSoloIncomplete("eliminated");
      return;
    }

    if (soloRequiresFullCourse && alivePlayers.length === 1 && !soloReachedFullCourse) {
      emitSoloIncomplete("solo_path_incomplete");
      return;
    }

    if (alivePlayers.length === 1) {
      const winner = {
        participantId: alivePlayers[0].participantId,
        userId: alivePlayers[0].userId,
        name: alivePlayers[0].name,
      };
      const rm = this.resultMessages ?? {
        winner: "",
        loser: "",
        tie: "",
      };
      this.emitFinishedGameOver({
        reason: "finished",
        outcomeType: "single_winner",
        winner,
        winners: [winner],
        players: this.snapshotPlayers(),
        resultMessages: rm,
        leaderboard: bySkillDesc.map((row, idx) => ({
          participantId: row.participantId,
          userId: row.userId,
          name: row.name,
          skillPoints: row.skillPoints,
          rank: idx + 1,
          medal: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : null,
        })),
      });
      return;
    }

    const topSkillPoints = bySkillDesc[0]?.skillPoints ?? 0;
    const winners =
      topSkillPoints > 0
        ? bySkillDesc
            .filter((row) => row.skillPoints === topSkillPoints)
            .map((row) => ({
              participantId: row.participantId,
              userId: row.userId,
              name: row.name,
            }))
        : [];

    const winner =
      winners.length === 1
        ? {
            participantId: winners[0].participantId,
            userId: winners[0].userId,
            name: winners[0].name,
          }
        : null;
    const outcomeType: "single_winner" | "shared_winners" | "tie_all_zero" =
      winners.length === 0
        ? "tie_all_zero"
        : winners.length === 1
          ? "single_winner"
          : "shared_winners";

    let lastScore: number | null = null;
    let lastRank = 0;
    const leaderboard = bySkillDesc.map((row, idx) => {
      if (lastScore === null || row.skillPoints !== lastScore) {
        lastRank = idx + 1;
        lastScore = row.skillPoints;
      }
      const medal =
        lastRank === 1
          ? "gold"
          : lastRank === 2
            ? "silver"
            : lastRank === 3
              ? "bronze"
              : null;
      return {
        ...row,
        rank: lastRank,
        medal,
      };
    });

    const rm = this.resultMessages ?? {
      winner: "",
      loser: "",
      tie: "",
    };
    this.emitFinishedGameOver({
      reason: "finished",
      outcomeType,
      winner,
      winners,
      players: this.snapshotPlayers(),
      resultMessages: rm,
      leaderboard,
    });
  }

  tryAbilitySkillBoost(participantId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("skill_boost")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(participantId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (!this.isAbilityWindowOpen()) return { ok: false, error: "question_closed" };
    if (p.keys < 1) return { ok: false, error: "not_enough_keys" };
    p.keys -= 1;
    p.skillBoostStacks += 1;
    this.emitKeysRoomState();
    return { ok: true, keys: p.keys, skillBoostStacks: p.skillBoostStacks };
  }

  tryAbilitySkipQuestion(participantId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("skip")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(participantId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (!this.isAbilityWindowOpen()) return { ok: false, error: "question_closed" };
    if (this.pendingAnswers.has(participantId)) return { ok: false, error: "already_answered" };
    if (this.skipParticipantsForQuestion.has(participantId)) return { ok: false, error: "already_skipped" };
    if (p.keys < 1) return { ok: false, error: "not_enough_keys" };
    p.keys -= 1;
    this.skipParticipantsForQuestion.add(participantId);
    this.emitKeysRoomState();
    return { ok: true, keys: p.keys };
  }

  tryAbilityHeartAttack(attackerParticipantId: string, victimParticipantId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (!this.isAbilityEnabled("attack")) return { ok: false, error: "ability_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityWindowOpen()) return { ok: false, error: "question_closed" };
    if (attackerParticipantId === victimParticipantId) return { ok: false, error: "invalid_target" };
    const attacker = this.players.get(attackerParticipantId);
    const victim = this.players.get(victimParticipantId);
    if (!attacker || !victim) return { ok: false, error: "invalid_target" };
    if (attacker.eliminated || attacker.hearts <= 0 || attacker.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (victim.eliminated || victim.hearts <= 0 || victim.isSpectator) {
      return { ok: false, error: "invalid_target" };
    }
    if (attacker.keys < this.keysHeartAttackCost) {
      return { ok: false, error: "not_enough_keys" };
    }
    attacker.keys -= this.keysHeartAttackCost;

    let outcome: "hit" | "blocked" = "hit";
    if (victim.keys >= this.keysShieldCost) {
      victim.keys -= this.keysShieldCost;
      outcome = "blocked";
    } else {
      this.damageHeart(victimParticipantId, victim);
    }

    this.io.to(this.room).emit("ability_heart_resolved", {
      attackerParticipantId,
      attackerUserId: attacker.userId,
      attackerName: attacker.name,
      victimParticipantId,
      victimUserId: victim.userId,
      victimName: victim.name,
      outcome,
      shieldCost: this.keysShieldCost,
    });
    this.emitKeysRoomState();

    if (this.shouldDeclareWinnerForActiveCount() && !this.finished) {
      this.declareWinner();
    }
    return { ok: true, keys: attacker.keys };
  }

  tryAbilityRevealKeys(participantId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("reveal")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(participantId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (p.keys < this.keysRevealCost) return { ok: false, error: "not_enough_keys" };

    let revealQuestions = 0;
    if (this.gameMode === "study_then_quiz" || this.gameMode === "lesson") {
      if (this.macroRound <= 0) return { ok: false, error: "reveal_not_available" };
      if (this.keysRevealQuestionsStudy <= 0) return { ok: false, error: "reveal_not_available" };
      if (
        this.hasRevealFor(participantId) &&
        this.revealMacroRoundByParticipant.get(participantId) === this.macroRound
      ) {
        return { ok: false, error: "reveal_already_active" };
      }
      p.keys -= this.keysRevealCost;
      revealQuestions = this.keysRevealQuestionsStudy;
      this.revealRemainingByParticipant.set(participantId, revealQuestions);
      this.revealMacroRoundByParticipant.set(participantId, this.macroRound);
    } else {
      if (this.keysRevealQuestionsDirect <= 0) {
        return { ok: false, error: "reveal_disabled_direct" };
      }
      if (this.hasRevealFor(participantId)) {
        return { ok: false, error: "reveal_already_active" };
      }
      p.keys -= this.keysRevealCost;
      revealQuestions = this.keysRevealQuestionsDirect;
      this.revealRemainingByParticipant.set(participantId, revealQuestions);
      this.revealMacroRoundByParticipant.set(participantId, null);
    }

    this.emitKeysRoomState();
    return { ok: true, keys: p.keys, revealQuestions };
  }
}
