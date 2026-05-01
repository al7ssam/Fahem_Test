import type { Server } from "socket.io";
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

const QUESTION_MS = 15_000;
/** بعد انتهاء الإجابات يبقى استقبال القدرات مفعّلاً لهذا الوقت (تخفيف سباق الشبكة مع finishRound). */
const ABILITY_GRACE_MS = 500;
const MAX_ROUNDS = 50;
const DEFAULT_MAX_STUDY_ROUNDS = 3;
const DEFAULT_STUDY_ROUND_SIZE = 8;
const DEFAULT_STUDY_PHASE_MS = 60_000;
const DEFAULT_ROUND_READY_MS = 12_000;
const RUNTIME_SETTINGS_CACHE_MS = 15_000;

export type GameMode = "direct" | "study_then_quiz" | "lesson";
export type DifficultyMode = "mix" | "easy" | "medium" | "hard";

export type MatchPlayerPublic = {
  socketId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator: boolean;
  skillPoints: number;
  lastAward: number;
  keys: number;
  skillBoostStacks: number;
};

type MatchPlayerState = {
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
  private readonly players = new Map<string, MatchPlayerState>();
  private readonly playerSessionToSocket = new Map<string, string>();
  private readonly socketToPlayerSession = new Map<string, string>();
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
  private studyPhaseMs = DEFAULT_STUDY_PHASE_MS;
  private roundReady = new Set<string>();
  private roundReadyResolve: (() => void) | null = null;
  private roundReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private skipSocketsForQuestion = new Set<string>();
  private revealRemainingBySocket = new Map<string, number>();
  private revealMacroRoundBySocket = new Map<string, number | null>();
  /** في نمط الدرس: تاريخ إجابات لكل مقبس لبناء lessonReview عند game_over */
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
  private questionMs = QUESTION_MS;

  constructor(
    private readonly io: Server,
    readonly matchId: string,
    entries: Array<{ socketId: string; name: string; playerSessionId: string }>,
    readonly gameMode: GameMode,
    private readonly studySubcategoryKey: string | null = null,
    private readonly difficultyMode: DifficultyMode = "mix",
    private readonly timeOverrides?: {
      questionMsOverride?: number;
      studyPhaseMsOverride?: number;
    },
    private readonly lessonPlayback: LessonPlaybackPayload | null = null,
  ) {
    this.room = `match_${matchId}`;
    this.isSoloMatch = entries.length === 1;
    for (const e of entries) {
      this.players.set(e.socketId, {
        playerSessionId: e.playerSessionId,
        name: e.name,
        hearts: 3,
        eliminated: false,
        isSpectator: false,
        skillPoints: 0,
        lastAward: 0,
        keys: 0,
        correctStreak: 0,
        skillBoostStacks: 0,
      });
      this.playerSessionToSocket.set(e.playerSessionId, e.socketId);
      this.socketToPlayerSession.set(e.socketId, e.playerSessionId);
    }
  }

  private snapshotPlayers(): MatchPlayerPublic[] {
    return [...this.players.entries()].map(([socketId, p]) => ({
      socketId,
      name: p.name,
      hearts: p.hearts,
      eliminated: p.eliminated,
      isSpectator: p.isSpectator,
      skillPoints: p.skillPoints,
      lastAward: p.lastAward,
      keys: p.keys,
      skillBoostStacks: p.skillBoostStacks,
    }));
  }

  isFinished(): boolean {
    return this.finished;
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

  private hasRevealFor(socketId: string): boolean {
    const rem = this.revealRemainingBySocket.get(socketId) ?? 0;
    if (rem <= 0) return false;
    if (this.gameMode === "study_then_quiz" || this.gameMode === "lesson") {
      const mr = this.revealMacroRoundBySocket.get(socketId);
      return mr === this.macroRound;
    }
    return true;
  }

  private emitKeysRoomState(): void {
    const players = this.snapshotPlayers();
    const abilityCosts = this.snapshotAbilityCosts();
    const abilityToggles = this.snapshotAbilityToggles();
    for (const socketId of this.players.keys()) {
      this.io.to(socketId).emit("keys_room_state", {
        revealKeysActive: this.hasRevealFor(socketId),
        macroRound: this.macroRound,
        players,
        abilityCosts,
        abilityToggles,
        keysAttacksEnabled: abilityToggles.heartAttack,
      });
    }
  }

  private countActive(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.eliminated && p.hearts > 0) n++;
    }
    return n;
  }

  private hasEnoughActivePlayersForQuestions(): boolean {
    const active = this.countActive();
    return this.isSoloMatch ? active > 0 : active > 1;
  }

  private shouldDeclareWinnerForActiveCount(): boolean {
    const active = this.countActive();
    return this.isSoloMatch ? active <= 0 : active <= 1;
  }

  private allActiveAnswered(): boolean {
    for (const [id, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;
      if (!this.pendingAnswers.has(id)) return false;
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
    for (const [socketId, mr] of this.revealMacroRoundBySocket.entries()) {
      if (mr !== null && this.macroRound > mr) {
        this.revealMacroRoundBySocket.delete(socketId);
        this.revealRemainingBySocket.delete(socketId);
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

  private damageHeart(socketId: string, p: MatchPlayerState): void {
    p.hearts = Math.max(0, p.hearts - 1);
    if (p.hearts === 0) {
      this.revealRemainingBySocket.delete(socketId);
      this.revealMacroRoundBySocket.delete(socketId);
      p.eliminated = true;
      p.isSpectator = true;
      this.io.to(this.room).emit("player_eliminated", {
        socketId,
        name: p.name,
        reason: "hearts",
      });
      this.io.to(socketId).emit("spectator_offer", {
        socketId,
        reason: "hearts",
      });
    }
  }

  markRoundReady(socketId: string): void {
    if (this.finished || this.gameMode !== "study_then_quiz") return;
    const p = this.players.get(socketId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) return;
    this.roundReady.add(socketId);
    this.emitRoundReadyState();
    if (this.allActiveReadyForRound()) {
      this.clearRoundReadyWait();
    }
  }

  private allActiveReadyForRound(): boolean {
    for (const [socketId, p] of this.players) {
      if (p.eliminated || p.hearts <= 0 || p.isSpectator) continue;
      if (!this.roundReady.has(socketId)) return false;
    }
    return true;
  }

  private emitRoundReadyState(): void {
    this.io.to(this.room).emit("round_ready_state", {
      roundToken: this.activeRoundToken,
      macroRound: this.macroRound,
      readySocketIds: [...this.roundReady],
      totalActive: this.countActive(),
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

  recordAnswer(socketId: string, questionId: number, choiceIndex: number): void {
    if (this.finished || this.roundClosed) return;
    if (this.currentQuestionId !== questionId) return;
    if (Date.now() > this.answerDeadline) return;
    if (this.skipSocketsForQuestion.has(socketId)) return;
    const p = this.players.get(socketId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) return;
    if (this.pendingAnswers.has(socketId)) return;
    this.pendingAnswers.set(socketId, choiceIndex);
    this.answerTimes.set(socketId, Date.now());
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

  handleDisconnect(socketId: string): void {
    const p = this.players.get(socketId);
    if (!p || p.eliminated) return;
    this.playerSessionToSocket.delete(p.playerSessionId);
    this.socketToPlayerSession.delete(socketId);
    this.revealRemainingBySocket.delete(socketId);
    this.revealMacroRoundBySocket.delete(socketId);
    p.hearts = 0;
    p.eliminated = true;
    p.isSpectator = false;
    this.io.to(this.room).emit("player_eliminated", {
      socketId,
      name: p.name,
      reason: "disconnect",
    });
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

    this.io.to(this.room).emit("study_phase", {
      cards,
      roundToken: this.activeRoundToken,
      startsAt: studyStartsAt,
      endsAt: studyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
      scope: "match_start",
    });

    this.io.to(this.room).emit("round_ready_window", {
      roundToken: this.activeRoundToken,
      startsAt: readyStartsAt,
      endsAt: readyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
    });
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
           FROM app_settings
           WHERE key IN (
             'game_max_study_rounds', 'game_study_round_size', 'game_study_phase_ms',
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
      const phaseMs = Number(map.get("game_study_phase_ms") ?? DEFAULT_STUDY_PHASE_MS);
      this.maxStudyRounds = Math.min(10, Math.max(1, Number.isFinite(maxRounds) ? maxRounds : DEFAULT_MAX_STUDY_ROUNDS));
      this.studyRoundSize = Math.min(30, Math.max(1, Number.isFinite(roundSize) ? roundSize : DEFAULT_STUDY_ROUND_SIZE));
      this.studyPhaseMs = Math.min(300_000, Math.max(5_000, Number.isFinite(phaseMs) ? phaseMs : DEFAULT_STUDY_PHASE_MS));

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
        this.questionMs = Math.min(120_000, Math.max(5_000, Math.floor(this.timeOverrides.questionMsOverride)));
      }
      if (this.timeOverrides?.studyPhaseMsOverride !== undefined) {
        this.studyPhaseMs = Math.min(300_000, Math.max(10_000, Math.floor(this.timeOverrides.studyPhaseMsOverride)));
      }
    } catch {
      this.maxStudyRounds = DEFAULT_MAX_STUDY_ROUNDS;
      this.studyRoundSize = DEFAULT_STUDY_ROUND_SIZE;
      this.studyPhaseMs = DEFAULT_STUDY_PHASE_MS;
      this.keysSmallStreakReward = 1;
      this.keysRevealQuestionsDirect = 4;
      this.keysRevealQuestionsStudy = 4;
      if (this.timeOverrides?.questionMsOverride !== undefined) {
        this.questionMs = Math.min(120_000, Math.max(5_000, Math.floor(this.timeOverrides.questionMsOverride)));
      }
      if (this.timeOverrides?.studyPhaseMsOverride !== undefined) {
        this.studyPhaseMs = Math.min(300_000, Math.max(10_000, Math.floor(this.timeOverrides.studyPhaseMsOverride)));
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
      subcategoryKey: this.studySubcategoryKey ?? undefined,
      difficultyMode: this.difficultyMode,
      players: this.snapshotPlayers(),
      revealKeysActive: false,
      keysAttacksEnabled: this.snapshotAbilityToggles().heartAttack,
      abilityCosts: this.snapshotAbilityCosts(),
      abilityToggles: this.snapshotAbilityToggles(),
    });
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
    const now = Date.now();
    const studyStartsAt = now;
    const studyEndsAt = now + phaseMs;

    this.io.to(this.room).emit("study_phase", {
      cards,
      roundToken: this.activeRoundToken,
      startsAt: studyStartsAt,
      endsAt: studyEndsAt,
      serverNow: now,
      macroRound: this.macroRound,
      scope: "lesson",
      ...sectionMeta,
    });

    await new Promise<void>((resolve) => {
      this.studyPhaseResolve = resolve;
      this.studyWaitTimer = setTimeout(() => {
        this.studyWaitTimer = null;
        this.studyPhaseResolve = null;
        resolve();
      }, Math.max(0, studyEndsAt - Date.now()));
    });
    this.clearStudyWait();

    this.io.to(this.room).emit("study_phase_end", {
      roundToken: this.activeRoundToken,
      macroRound: this.macroRound,
      startsAt: studyStartsAt,
      studyEndsAt: studyEndsAt,
      serverNow: Date.now(),
      ...sectionMeta,
    });
  }

  private async runLessonMatchLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    void pool;
    const playback = this.lessonPlayback;
    if (!playback || playback.steps.length === 0) {
      this.emitNoQuestions();
      return;
    }
    this.lessonAnswerHistory.clear();
    for (const sid of this.players.keys()) {
      this.lessonAnswerHistory.set(sid, []);
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
  }

  private emitNoQuestions(): void {
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

  private async playOneQuestion(
    pool: ReturnType<typeof getPool>,
    q: QuestionRow,
    answerMsOverride?: number,
  ): Promise<void> {
    void pool;
    this.clearQuestionTimers();
    this.usedQuestionIds.push(q.id);
    this.round++;
    this.roundClosed = false;
    this.skipSocketsForQuestion.clear();
    this.currentQuestionId = q.id;
    this.currentCorrectIndex = q.correct_index;
    this.currentOptionsCount = q.options.length;
    this.questionStartedAt = Date.now();
    const windowMs = Math.min(
      120_000,
      Math.max(5_000, answerMsOverride ?? this.questionMs),
    );
    this.answerDeadline = Date.now() + windowMs;
    this.pendingAnswers.clear();
    this.answerTimes.clear();

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
    for (const socketId of this.players.keys()) {
      this.io.to(socketId).emit("question", {
        ...baseQuestionPayload,
        revealKeysActive: this.hasRevealFor(socketId),
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

  private finishRound(): void {
    if (this.roundClosed || this.finished) return;
    this.roundClosed = true;
    this.clearQuestionTimers();

    const questionId = this.currentQuestionId;
    const correctIndex = this.currentCorrectIndex ?? 0;
    this.currentQuestionId = null;
    this.currentCorrectIndex = null;
    this.currentOptionsCount = null;

    const results: Array<{
      socketId: string;
      correct: boolean;
      skipped?: boolean;
      choiceIndex?: number | null;
      pointsAward: number;
      hearts: number;
      eliminated: boolean;
    }> = [];

    for (const [socketId, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;

      if (this.skipSocketsForQuestion.has(socketId)) {
        p.lastAward = 0;
        results.push({
          socketId,
          correct: false,
          skipped: true,
          choiceIndex: null,
          pointsAward: 0,
          hearts: p.hearts,
          eliminated: p.eliminated,
        });
        continue;
      }

      const choice = this.pendingAnswers.get(socketId);
      const answered = choice !== undefined;
      const choiceIndexForResult: number | null = answered ? choice! : null;
      const correct = answered && choice === correctIndex;
      let pointsAward = 0;

      if (correct) {
        p.correctStreak += 1;
        this.applyKeyGrants(p);
        const answeredAt = this.answerTimes.get(socketId) ?? this.answerDeadline;
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
        p.hearts = Math.max(0, p.hearts - 1);
        if (p.hearts === 0) {
          p.eliminated = true;
          p.isSpectator = true;
          this.io.to(this.room).emit("player_eliminated", {
            socketId,
            name: p.name,
            reason: "hearts",
          });
          this.io.to(socketId).emit("spectator_offer", {
            socketId,
            reason: "hearts",
          });
        }
        results.push({
          socketId,
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
        socketId,
        correct: true,
        choiceIndex: choiceIndexForResult,
        pointsAward,
        hearts: p.hearts,
        eliminated: p.eliminated,
      });
    }

    if (this.gameMode === "lesson" && questionId != null && this.lessonPlayback) {
      const step = this.lessonPlayback.steps.find((s) => s.questionId === questionId);
      if (step) {
        for (const r of results) {
          const list = this.lessonAnswerHistory.get(r.socketId);
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

    for (const [socketId, rem] of this.revealRemainingBySocket.entries()) {
      if (rem <= 0) continue;
      const next = rem - 1;
      if (next <= 0) {
        this.revealRemainingBySocket.delete(socketId);
        this.revealMacroRoundBySocket.delete(socketId);
      } else {
        this.revealRemainingBySocket.set(socketId, next);
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
    };
    for (const socketId of this.players.keys()) {
      this.io.to(socketId).emit("question_result", {
        ...baseResultPayload,
        revealKeysActive: this.hasRevealFor(socketId),
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
      for (const socketId of this.players.keys()) {
        this.io.to(socketId).emit("game_over", {
          ...payload,
          lessonReview: this.lessonAnswerHistory.get(socketId) ?? [],
        });
      }
      return;
    }
    this.io.to(this.room).emit("game_over", payload);
  }

  private declareWinner(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearStudyWait();
    this.clearQuestionTimers();

    const bySkillDesc = [...this.players.entries()]
      .map(([socketId, p]) => ({
        socketId,
        name: p.name,
        skillPoints: p.skillPoints,
        hearts: p.hearts,
        eliminated: p.eliminated,
      }))
      .sort((a, b) => b.skillPoints - a.skillPoints);

    const alivePlayers = bySkillDesc.filter((p) => !p.eliminated && p.hearts > 0);
    if (alivePlayers.length === 1) {
      const winner = {
        socketId: alivePlayers[0].socketId,
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
          socketId: row.socketId,
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
            .map((row) => ({ socketId: row.socketId, name: row.name }))
        : [];

    const winner = winners.length === 1 ? winners[0] : null;
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

  tryAbilitySkillBoost(socketId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("skill_boost")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(socketId);
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

  tryAbilitySkipQuestion(socketId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("skip")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(socketId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (!this.isAbilityWindowOpen()) return { ok: false, error: "question_closed" };
    if (this.pendingAnswers.has(socketId)) return { ok: false, error: "already_answered" };
    if (this.skipSocketsForQuestion.has(socketId)) return { ok: false, error: "already_skipped" };
    if (p.keys < 1) return { ok: false, error: "not_enough_keys" };
    p.keys -= 1;
    this.skipSocketsForQuestion.add(socketId);
    this.emitKeysRoomState();
    return { ok: true, keys: p.keys };
  }

  tryAbilityHeartAttack(attackerId: string, victimId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (!this.isAbilityEnabled("attack")) return { ok: false, error: "ability_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityWindowOpen()) return { ok: false, error: "question_closed" };
    if (attackerId === victimId) return { ok: false, error: "invalid_target" };
    const attacker = this.players.get(attackerId);
    const victim = this.players.get(victimId);
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
      this.damageHeart(victimId, victim);
    }

    this.io.to(this.room).emit("ability_heart_resolved", {
      attackerSocketId: attackerId,
      attackerName: attacker.name,
      victimSocketId: victimId,
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

  tryAbilityRevealKeys(socketId: string): AbilityAck {
    if (this.isSoloMatch) return { ok: false, error: "solo_abilities_disabled" };
    if (this.finished) return { ok: false, error: "match_finished" };
    if (!this.isAbilityEnabled("reveal")) return { ok: false, error: "ability_disabled" };
    const p = this.players.get(socketId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) {
      return { ok: false, error: "not_eligible" };
    }
    if (p.keys < this.keysRevealCost) return { ok: false, error: "not_enough_keys" };

    let revealQuestions = 0;
    if (this.gameMode === "study_then_quiz" || this.gameMode === "lesson") {
      if (this.macroRound <= 0) return { ok: false, error: "reveal_not_available" };
      if (this.keysRevealQuestionsStudy <= 0) return { ok: false, error: "reveal_not_available" };
      if (this.hasRevealFor(socketId) && this.revealMacroRoundBySocket.get(socketId) === this.macroRound) {
        return { ok: false, error: "reveal_already_active" };
      }
      p.keys -= this.keysRevealCost;
      revealQuestions = this.keysRevealQuestionsStudy;
      this.revealRemainingBySocket.set(socketId, revealQuestions);
      this.revealMacroRoundBySocket.set(socketId, this.macroRound);
    } else {
      if (this.keysRevealQuestionsDirect <= 0) {
        return { ok: false, error: "reveal_disabled_direct" };
      }
      if (this.hasRevealFor(socketId)) {
        return { ok: false, error: "reveal_already_active" };
      }
      p.keys -= this.keysRevealCost;
      revealQuestions = this.keysRevealQuestionsDirect;
      this.revealRemainingBySocket.set(socketId, revealQuestions);
      this.revealMacroRoundBySocket.set(socketId, null);
    }

    this.emitKeysRoomState();
    return { ok: true, keys: p.keys, revealQuestions };
  }
}
