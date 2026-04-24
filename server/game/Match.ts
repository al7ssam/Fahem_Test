import type { Server } from "socket.io";
import { config } from "../config";
import { getPool } from "../db/pool";
import {
  getRandomQuestion,
  getStudyPhaseCardsFromQuestionIds,
  type QuestionRow,
} from "../db/questions";
import { getResultMessages, type ResultMessages } from "../db/resultCopy";

const QUESTION_MS = 15_000;
const MAX_ROUNDS = 50;
const DEFAULT_MAX_STUDY_ROUNDS = 3;
const DEFAULT_STUDY_ROUND_SIZE = 8;
const DEFAULT_STUDY_PHASE_MS = 60_000;
const DEFAULT_ROUND_READY_MS = 12_000;

export type GameMode = "direct" | "study_then_quiz";

export type MatchPlayerPublic = {
  socketId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator: boolean;
  skillPoints: number;
  lastAward: number;
};

type MatchPlayerState = {
  name: string;
  hearts: number;
  eliminated: boolean;
  isSpectator: boolean;
  skillPoints: number;
  lastAward: number;
};

export class Match {
  readonly room: string;
  private readonly players = new Map<string, MatchPlayerState>();
  private usedQuestionIds: number[] = [];
  private round = 0;
  private currentQuestionId: number | null = null;
  private currentCorrectIndex: number | null = null;
  private questionStartedAt = 0;
  private answerDeadline = 0;
  private pendingAnswers = new Map<string, number>();
  private answerTimes = new Map<string, number>();
  private questionTimer: ReturnType<typeof setTimeout> | null = null;
  private roundClosed = false;
  private resolveRound: (() => void) | null = null;
  private finished = false;
  private studyPhaseResolve: (() => void) | null = null;
  private studyWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private macroRound = 0;
  private questionQueue: QuestionRow[] = [];
  private queueIndex = 0;
  private resultMessages: ResultMessages | null = null;
  private maxStudyRounds = DEFAULT_MAX_STUDY_ROUNDS;
  private studyRoundSize = DEFAULT_STUDY_ROUND_SIZE;
  private studyPhaseMs = DEFAULT_STUDY_PHASE_MS;
  private roundReady = new Set<string>();
  private roundReadyResolve: (() => void) | null = null;
  private roundReadyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly io: Server,
    readonly matchId: string,
    entries: Array<{ socketId: string; name: string }>,
    readonly gameMode: GameMode,
  ) {
    this.room = `match_${matchId}`;
    for (const e of entries) {
      this.players.set(e.socketId, {
        name: e.name,
        hearts: 3,
        eliminated: false,
        isSpectator: false,
        skillPoints: 0,
        lastAward: 0,
      });
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
    }));
  }

  private countActive(): number {
    let n = 0;
    for (const p of this.players.values()) {
      if (!p.eliminated && p.hearts > 0) n++;
    }
    return n;
  }

  private allActiveAnswered(): boolean {
    for (const [id, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;
      if (!this.pendingAnswers.has(id)) return false;
    }
    return true;
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
    const p = this.players.get(socketId);
    if (!p || p.eliminated || p.hearts <= 0 || p.isSpectator) return;
    if (this.pendingAnswers.has(socketId)) return;
    this.pendingAnswers.set(socketId, choiceIndex);
    this.answerTimes.set(socketId, Date.now());
    if (this.allActiveAnswered()) {
      if (this.questionTimer) {
        clearTimeout(this.questionTimer);
        this.questionTimer = null;
      }
      this.finishRound();
    }
  }

  handleDisconnect(socketId: string): void {
    const p = this.players.get(socketId);
    if (!p || p.eliminated) return;
    p.hearts = 0;
    p.eliminated = true;
    p.isSpectator = false;
    this.io.to(this.room).emit("player_eliminated", {
      socketId,
      name: p.name,
      reason: "disconnect",
    });
    if (this.countActive() <= 1 && !this.finished) {
      if (this.questionTimer) {
        clearTimeout(this.questionTimer);
        this.questionTimer = null;
      }
      this.clearStudyWait();
      this.roundClosed = true;
      this.currentQuestionId = null;
      this.currentCorrectIndex = null;
      this.resolveRound?.();
      this.resolveRound = null;
      this.declareWinner();
    }
  }

  private async runStudyPhase(
    cards: Array<{ id: number; questionId: number; body: string; order: number }>,
  ): Promise<void> {
    this.roundReady.clear();
    this.clearRoundReadyWait();
    const readyWindowMs = Math.min(
      20_000,
      Math.max(3_000, Math.floor(this.studyPhaseMs * 0.2)),
    );
    const readyEndsAt = Date.now() + (readyWindowMs || DEFAULT_ROUND_READY_MS);
    const studyEndsAt = Date.now() + this.studyPhaseMs;

    this.io.to(this.room).emit("study_phase", {
      cards,
      endsAt: studyEndsAt,
      serverNow: Date.now(),
      macroRound: this.macroRound,
      scope: "match_start",
    });

    this.io.to(this.room).emit("round_ready_window", {
      endsAt: readyEndsAt,
      serverNow: Date.now(),
      macroRound: this.macroRound,
    });
    this.emitRoundReadyState();

    const waitReady = new Promise<void>((resolve) => {
      this.roundReadyResolve = resolve;
      this.roundReadyTimer = setTimeout(() => {
        this.roundReadyTimer = null;
        this.roundReadyResolve = null;
        resolve();
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
      macroRound: this.macroRound,
      studyEndsAt,
      serverNow: Date.now(),
    });
  }

  private async loadRuntimeSettings(): Promise<void> {
    try {
      const pool = getPool();
      const rows = await pool.query<{ key: string; value: string }>(
        `SELECT key, value
         FROM app_settings
         WHERE key IN ('game_max_study_rounds', 'game_study_round_size', 'game_study_phase_ms')`,
      );
      const map = new Map(rows.rows.map((r) => [r.key, r.value]));
      const maxRounds = Number(map.get("game_max_study_rounds") ?? DEFAULT_MAX_STUDY_ROUNDS);
      const roundSize = Number(map.get("game_study_round_size") ?? DEFAULT_STUDY_ROUND_SIZE);
      const phaseMs = Number(map.get("game_study_phase_ms") ?? DEFAULT_STUDY_PHASE_MS);
      this.maxStudyRounds = Math.min(10, Math.max(1, Number.isFinite(maxRounds) ? maxRounds : DEFAULT_MAX_STUDY_ROUNDS));
      this.studyRoundSize = Math.min(30, Math.max(1, Number.isFinite(roundSize) ? roundSize : DEFAULT_STUDY_ROUND_SIZE));
      this.studyPhaseMs = Math.min(300_000, Math.max(5_000, Number.isFinite(phaseMs) ? phaseMs : DEFAULT_STUDY_PHASE_MS));
    } catch {
      this.maxStudyRounds = DEFAULT_MAX_STUDY_ROUNDS;
      this.studyRoundSize = DEFAULT_STUDY_ROUND_SIZE;
      this.studyPhaseMs = DEFAULT_STUDY_PHASE_MS;
    }
  }

  async run(): Promise<void> {
    await this.loadRuntimeSettings();
    this.io.to(this.room).emit("game_started", {
      matchId: this.matchId,
      gameMode: this.gameMode,
      players: this.snapshotPlayers(),
    });

    const pool = getPool();
    this.resultMessages = await getResultMessages(pool);

    if (this.gameMode === "direct") {
      await this.runDirectQuestionLoop(pool);
    } else {
      await this.runStudyThenQuizLoop(pool);
    }

    if (!this.finished) {
      this.declareWinner();
    }
  }

  private async runDirectQuestionLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    while (!this.finished && this.countActive() > 1 && this.round < MAX_ROUNDS) {
      const q = await getRandomQuestion(pool, this.usedQuestionIds);
      if (!q) {
        this.emitNoQuestions();
        return;
      }
      await this.playOneQuestion(pool, q);
      if (this.finished) return;
    }
  }

  private async runStudyThenQuizLoop(pool: ReturnType<typeof getPool>): Promise<void> {
    const prefetch = Math.min(MAX_ROUNDS, config.studyMatchPrefetch);
    const blockSize = this.studyRoundSize;
    const maxCardsPerBlock = this.studyRoundSize;

    this.questionQueue = [];
    this.queueIndex = 0;
    await this.fillQuestionQueue(pool, prefetch);
    if (this.questionQueue.length === 0) {
      this.emitNoQuestions();
      return;
    }

    while (
      !this.finished &&
      this.countActive() > 1 &&
      this.macroRound < this.maxStudyRounds
    ) {
      const remaining = this.questionQueue.length - this.queueIndex;
      if (remaining < blockSize) {
        await this.fillQuestionQueue(pool, blockSize - remaining);
      }
      if (this.questionQueue.length - this.queueIndex < blockSize) {
        this.emitNoQuestions();
        return;
      }
      if (this.queueIndex >= this.questionQueue.length) {
        this.emitNoQuestions();
        return;
      }

      this.macroRound += 1;
      const block = this.questionQueue.slice(
        this.queueIndex,
        Math.min(this.questionQueue.length, this.queueIndex + blockSize),
      );
      const blockIds = block.map((q) => q.id);
      const cards = await getStudyPhaseCardsFromQuestionIds(
        pool,
        blockIds,
        Math.min(maxCardsPerBlock, blockIds.length),
      );
      if (cards.length !== blockSize) {
        this.emitNoQuestions();
        return;
      }
      await this.runStudyPhase(cards);
      if (this.finished) return;

      for (const q of block) {
        if (this.finished || this.countActive() <= 1 || this.round >= MAX_ROUNDS) {
          return;
        }
        this.queueIndex += 1;
        await this.playOneQuestion(pool, q);
      }
    }
  }

  private async fillQuestionQueue(
    pool: ReturnType<typeof getPool>,
    targetMore: number,
  ): Promise<void> {
    const exclude = new Set<number>(this.usedQuestionIds);
    for (const q of this.questionQueue) {
      exclude.add(q.id);
    }
    let added = 0;
    while (added < targetMore) {
      const q = await getRandomQuestion(pool, [...exclude], true);
      if (!q) break;
      exclude.add(q.id);
      this.questionQueue.push(q);
      added += 1;
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
      winner: null,
      players: this.snapshotPlayers(),
      resultMessages: rm,
    });
    this.finished = true;
  }

  private async playOneQuestion(
    pool: ReturnType<typeof getPool>,
    q: QuestionRow,
  ): Promise<void> {
    void pool;
    this.usedQuestionIds.push(q.id);
    this.round++;
    this.roundClosed = false;
    this.currentQuestionId = q.id;
    this.currentCorrectIndex = q.correct_index;
    this.questionStartedAt = Date.now();
    this.answerDeadline = Date.now() + QUESTION_MS;
    this.pendingAnswers.clear();
    this.answerTimes.clear();

    const waitRound = new Promise<void>((resolve) => {
      this.resolveRound = resolve;
    });

    this.io.to(this.room).emit("question", {
      questionId: q.id,
      prompt: q.prompt,
      options: q.options,
      endsAt: this.answerDeadline,
      serverNow: Date.now(),
      round: this.round,
    });

    this.questionTimer = setTimeout(() => this.finishRound(), QUESTION_MS);
    await waitRound;

    if (this.countActive() <= 1 && !this.finished) {
      this.declareWinner();
    }
  }

  private finishRound(): void {
    if (this.roundClosed || this.finished) return;
    this.roundClosed = true;
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }

    const questionId = this.currentQuestionId;
    const correctIndex = this.currentCorrectIndex ?? 0;
    this.currentQuestionId = null;
    this.currentCorrectIndex = null;

    const results: Array<{
      socketId: string;
      correct: boolean;
      pointsAward: number;
      hearts: number;
      eliminated: boolean;
    }> = [];

    for (const [socketId, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;
      const choice = this.pendingAnswers.get(socketId);
      const answered = choice !== undefined;
      const correct = answered && choice === correctIndex;
      let pointsAward = 0;
      if (correct) {
        const answeredAt = this.answerTimes.get(socketId) ?? this.answerDeadline;
        const totalWindow = Math.max(1, this.answerDeadline - this.questionStartedAt);
        const progress = Math.min(
          1,
          Math.max(0, (answeredAt - this.questionStartedAt) / totalWindow),
        );
        pointsAward = Math.round(100 - progress * 99);
        p.skillPoints += pointsAward;
      }
      p.lastAward = pointsAward;
      if (!correct) {
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
      }
      results.push({
        socketId,
        correct,
        pointsAward,
        hearts: p.hearts,
        eliminated: p.eliminated,
      });
    }

    this.io.to(this.room).emit("question_result", {
      questionId,
      correctIndex,
      results,
      players: this.snapshotPlayers(),
    });

    this.resolveRound?.();
    this.resolveRound = null;

    if (this.countActive() <= 1) {
      this.declareWinner();
    }
  }

  private declareWinner(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearStudyWait();
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }

    const survivors = [...this.players.entries()].filter(
      ([, p]) => !p.eliminated && p.hearts > 0,
    );
    let winnerId: string | null = null;
    if (survivors.length === 1) {
      winnerId = survivors[0][0];
    } else {
      const topBySkill = [...this.players.entries()].sort(
        (a, b) => b[1].skillPoints - a[1].skillPoints,
      )[0];
      winnerId = topBySkill?.[0] ?? null;
    }

    let winner: { socketId: string; name: string } | null = null;
    if (winnerId) {
      const wp = this.players.get(winnerId);
      if (wp) {
        const bonus = Math.max(0, wp.hearts) * 100;
        wp.skillPoints += bonus;
        wp.lastAward = bonus;
        winner = { socketId: winnerId, name: wp.name };
      }
    }

    const leaderboard = [...this.players.entries()]
      .map(([socketId, p]) => ({
        socketId,
        name: p.name,
        skillPoints: p.skillPoints,
      }))
      .sort((a, b) => b.skillPoints - a.skillPoints)
      .map((row, idx) => ({
        ...row,
        rank: idx + 1,
        medal: idx === 0 ? "gold" : idx === 1 ? "silver" : idx === 2 ? "bronze" : null,
      }));

    const rm = this.resultMessages ?? {
      winner: "",
      loser: "",
      tie: "",
    };
    this.io.to(this.room).emit("game_over", {
      reason: "finished",
      winner,
      players: this.snapshotPlayers(),
      resultMessages: rm,
      leaderboard,
    });
  }
}
