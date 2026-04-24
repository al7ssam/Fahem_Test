import type { Server } from "socket.io";
import { config } from "../config";
import { getPool } from "../db/pool";
import { getRandomQuestion, type QuestionRow } from "../db/questions";
import { getStudyCardsForQuestions } from "../db/studyCards";

const QUESTION_MS = 15_000;
const MAX_ROUNDS = 50;

export type GameMode = "direct" | "study_then_quiz";

export type MatchPlayerPublic = {
  socketId: string;
  name: string;
  hearts: number;
  eliminated: boolean;
};

export class Match {
  readonly room: string;
  private readonly players = new Map<
    string,
    { name: string; hearts: number; eliminated: boolean }
  >();
  private usedQuestionIds: number[] = [];
  private round = 0;
  private currentQuestionId: number | null = null;
  private currentCorrectIndex: number | null = null;
  private answerDeadline = 0;
  private pendingAnswers = new Map<string, number>();
  private questionTimer: ReturnType<typeof setTimeout> | null = null;
  private roundClosed = false;
  private resolveRound: (() => void) | null = null;
  private finished = false;
  private studyPhaseResolve: (() => void) | null = null;
  private studyWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private macroRound = 0;
  private questionQueue: QuestionRow[] = [];
  private queueIndex = 0;

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
      });
    }
  }

  private snapshotPlayers(): MatchPlayerPublic[] {
    return [...this.players.entries()].map(([socketId, p]) => ({
      socketId,
      name: p.name,
      hearts: p.hearts,
      eliminated: p.eliminated,
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

  private clearStudyWait(): void {
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
    if (!p || p.eliminated || p.hearts <= 0) return;
    if (this.pendingAnswers.has(socketId)) return;
    this.pendingAnswers.set(socketId, choiceIndex);
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
    cards: Array<{ id: number; body: string; order: number }>,
    endsAt: number,
  ): Promise<void> {
    this.io.to(this.room).emit("study_phase", {
      cards,
      endsAt,
      macroRound: this.macroRound,
      scope: "match_start",
    });
    const ms = Math.max(0, endsAt - Date.now());
    await new Promise<void>((resolve) => {
      this.studyPhaseResolve = resolve;
      this.studyWaitTimer = setTimeout(() => {
        this.studyWaitTimer = null;
        this.studyPhaseResolve = null;
        resolve();
      }, ms);
    });
    this.io.to(this.room).emit("study_phase_end", {
      macroRound: this.macroRound,
    });
  }

  async run(): Promise<void> {
    this.io.to(this.room).emit("game_started", {
      matchId: this.matchId,
      gameMode: this.gameMode,
      players: this.snapshotPlayers(),
    });

    const pool = getPool();

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
    const refillBatch = Math.max(1, config.studyQuizBlockSize);
    const maxCardsFull = config.maxStudyCardsMatchStart;

    this.questionQueue = [];
    this.queueIndex = 0;
    await this.fillQuestionQueue(pool, prefetch);
    if (this.questionQueue.length === 0) {
      this.emitNoQuestions();
      return;
    }

    this.macroRound = 1;
    const ids = this.questionQueue.map((q) => q.id);
    const cards = await getStudyCardsForQuestions(pool, ids, maxCardsFull);
    const endsAt = Date.now() + config.studyPhaseMs;
    if (cards.length > 0) {
      await this.runStudyPhase(cards, endsAt);
    }
    if (this.finished) return;

    while (!this.finished && this.countActive() > 1) {
      if (this.queueIndex >= this.questionQueue.length) {
        const lenBefore = this.questionQueue.length;
        await this.fillQuestionQueue(pool, refillBatch);
        if (this.queueIndex >= this.questionQueue.length) {
          if (this.questionQueue.length === lenBefore) {
            this.emitNoQuestions();
            return;
          }
        }
      }
      if (this.round >= MAX_ROUNDS) return;
      const q = this.questionQueue[this.queueIndex];
      this.queueIndex += 1;
      await this.playOneQuestion(pool, q);
      if (this.finished) return;
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
      const q = await getRandomQuestion(pool, [...exclude]);
      if (!q) break;
      exclude.add(q.id);
      this.questionQueue.push(q);
      added += 1;
    }
  }

  private emitNoQuestions(): void {
    this.io.to(this.room).emit("game_over", {
      reason: "no_questions",
      winner: null,
      players: this.snapshotPlayers(),
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
    this.answerDeadline = Date.now() + QUESTION_MS;
    this.pendingAnswers.clear();

    const waitRound = new Promise<void>((resolve) => {
      this.resolveRound = resolve;
    });

    this.io.to(this.room).emit("question", {
      questionId: q.id,
      prompt: q.prompt,
      options: q.options,
      endsAt: this.answerDeadline,
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
      hearts: number;
      eliminated: boolean;
    }> = [];

    for (const [socketId, p] of this.players) {
      if (p.eliminated || p.hearts <= 0) continue;
      const choice = this.pendingAnswers.get(socketId);
      const answered = choice !== undefined;
      const correct = answered && choice === correctIndex;
      if (!correct) {
        p.hearts = Math.max(0, p.hearts - 1);
        if (p.hearts === 0) {
          p.eliminated = true;
          this.io.to(this.room).emit("player_eliminated", {
            socketId,
            name: p.name,
            reason: "hearts",
          });
        }
      }
      results.push({
        socketId,
        correct,
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
    let winner: { socketId: string; name: string } | null = null;
    if (survivors.length === 1) {
      const [socketId, p] = survivors[0];
      winner = { socketId, name: p.name };
    }

    this.io.to(this.room).emit("game_over", {
      reason: "finished",
      winner,
      players: this.snapshotPlayers(),
    });
  }
}
