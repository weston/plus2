'use client';

import { create } from 'zustand';
import type { PuzzleSize, LeagueTier } from '@plus2/shared';

type GamePhase =
  | 'idle'
  | 'queuing'
  | 'matched'
  | 'inspecting'
  | 'solving'
  | 'waiting_opponent'
  | 'round_complete'
  | 'match_complete';

interface Opponent {
  id: string;
  username: string;
  mmr: number;
  league: LeagueTier;
  // Extended info
  country: string | null;
  gamesPlayed: number;
  gamesWon: number;
  // The opponent's cube color scheme — their cube renders in THEIR colors.
  cubeColors?: Record<string, string> | null;
  // The opponent's cube logo (white-center sticker image).
  cubeLogo?: string | null;
}

// Queued opponent move for deterministic replay. Moves apply strictly in
// arrival (seq) order via a single FIFO queue — independent per-move timers
// could fire out of order when a move's relative timestamp regressed or
// timers got throttled, and one transposition leaves the opponent's cube
// permanently wrong.
interface QueuedOpponentMove {
  seq: number;
  move: string;
  targetPerfMs: number;
}

interface GameState {
  // Queue state
  phase: GamePhase;
  puzzleSize: PuzzleSize;
  queuePosition: number;
  estimatedWait: number;

  // Match state
  matchId: string | null;
  opponent: Opponent | null;
  currentRound: number;
  myScore: number;
  opponentScore: number;

  // Solve state
  scramble: string;
  inspectionStartsAt: number;
  solveStartsAt: number;
  myMoves: string[];
  opponentMoves: string[];
  myTime: number | null;
  opponentTime: number | null; // null = still solving, or a DNF once opponentDone
  opponentDone: boolean;

  // Clock synchronization (NTP-lite)
  serverOffsetMs: number; // Date.now() + serverOffsetMs ≈ server time
  serverOffsetSamples: number[];
  lastClockSyncAt: number;

  // Deterministic solve timeline
  solveId: string | null;
  inspectionStartServerMs: number | null;
  inspectionEndServerMs: number | null;
  mySolveStartServerMs: number | null;
  myLocalSolveStartPerf: number | null; // performance.now() when MY solve started
  opponentSolveStartServerMs: number | null;
  opponentLocalSolveStartPerf: number | null; // computed local perf time for opponent's solve start

  // Ordered opponent move queue for deterministic replay
  opponentMoveQueue: QueuedOpponentMove[];
  opponentQueueTimer: ReturnType<typeof setTimeout> | null;
  opponentMoveLog: Array<{ seq: number; tMs: number; arrivalPerf: number; targetPerf: number; lateness: number }>;

  // Legacy fields (for backward compatibility during transition)
  opponentSolveClientTs: number | null;
  opponentSolveReceivedAt: number | null;
  opponentLastMoveClientTs: number | null;

  // Results
  roundWinner: 'you' | 'opponent' | 'draw' | null;
  matchWinner: 'you' | 'opponent' | null;
  mmrDelta: number;
  newMmr: number;
  newLeague: LeagueTier | null;

  // Actions
  setPuzzleSize: (size: PuzzleSize) => void;
  setPhase: (phase: GamePhase) => void;
  joinQueue: () => void;
  leaveQueue: () => void;
  setQueueInfo: (position: number, estimatedWait: number) => void;
  startMatch: (matchId: string, opponent: Opponent, scores?: { you: number; opponent: number }) => void;
  startRound: (round: number, scramble: string, inspectionStartsAt: number, solveId?: string, inspectionStartServerMs?: number, inspectionEndServerMs?: number) => void;
  startSolve: (solveStartsAt: number) => void;
  addMyMove: (move: string) => void;
  addOpponentMove: (move: string) => void;
  setSolveComplete: (myTime: number | null) => void;
  trimMyMoves: (count: number) => void;
  setOpponentDone: (opponentTime: number | null, moveCount?: number | null) => void;
  setOpponentStarted: (clientTs: number) => void;
  setOpponentMoveTs: (clientTs: number) => void;
  setRoundResult: (winner: 'you' | 'opponent' | 'draw', scores: { you: number; opponent: number }) => void;
  setMatchComplete: (winner: 'you' | 'opponent', mmrDelta: number, newMmr: number, newLeague: LeagueTier) => void;
  reset: () => void;

  // Clock sync actions
  updateServerOffset: (sample: number) => void;

  // Deterministic replay actions
  setMySolveStart: (solveStartServerMs: number, localPerfMs: number) => void;
  setOpponentSolveStart: (solveStartServerMs: number) => void;
  scheduleOpponentMove: (solveId: string, seq: number, move: string, tMs: number) => void;
  clearScheduledMoves: () => void;
}

// Jitter buffer for opponent replay (ms)
const REPLAY_BUFFER_MS = 80;

const initialState = {
  phase: 'idle' as GamePhase,
  puzzleSize: '3x3' as PuzzleSize,
  queuePosition: 0,
  estimatedWait: 0,
  matchId: null,
  opponent: null,
  currentRound: 0,
  myScore: 0,
  opponentScore: 0,
  scramble: '',
  inspectionStartsAt: 0,
  solveStartsAt: 0,
  myMoves: [] as string[],
  opponentMoves: [] as string[],
  myTime: null as number | null,
  opponentTime: null as number | null,
  opponentDone: false,

  // Clock sync
  serverOffsetMs: 0,
  serverOffsetSamples: [] as number[],
  lastClockSyncAt: 0,

  // Deterministic solve timeline
  solveId: null as string | null,
  inspectionStartServerMs: null as number | null,
  inspectionEndServerMs: null as number | null,
  mySolveStartServerMs: null as number | null,
  myLocalSolveStartPerf: null as number | null,
  opponentSolveStartServerMs: null as number | null,
  opponentLocalSolveStartPerf: null as number | null,

  // Ordered opponent move queue
  opponentMoveQueue: [] as QueuedOpponentMove[],
  opponentQueueTimer: null as ReturnType<typeof setTimeout> | null,
  opponentMoveLog: [] as Array<{ seq: number; tMs: number; arrivalPerf: number; targetPerf: number; lateness: number }>,

  // Legacy fields
  opponentSolveClientTs: null as number | null,
  opponentSolveReceivedAt: null as number | null,
  opponentLastMoveClientTs: null as number | null,

  roundWinner: null as 'you' | 'opponent' | 'draw' | null,
  matchWinner: null as 'you' | 'opponent' | null,
  mmrDelta: 0,
  newMmr: 0,
  newLeague: null as LeagueTier | null,
};

export const useGameStore = create<GameState>((set, get) => {
  // Apply queued opponent moves strictly head-first: the head applies once
  // its target time passes; everything behind it waits. Arrival order (which
  // matches the solver's seq order — one ordered socket) can never be
  // violated by timer scheduling.
  const drainOpponentQueue = () => {
    if (get().opponentQueueTimer) return; // head already scheduled

    const queue = [...get().opponentMoveQueue];
    const applied: string[] = [];
    const now = performance.now();
    while (queue.length && queue[0].targetPerfMs <= now) {
      const m = queue.shift()!;
      applied.push(m.move);
      console.log(`[SYNC] Applied opponent move ${m.seq}: ${m.move}`);
    }

    if (applied.length) {
      set((s) => ({
        opponentMoves: [...s.opponentMoves, ...applied],
        opponentMoveQueue: queue,
      }));
    }

    if (queue.length) {
      const delay = Math.max(0, queue[0].targetPerfMs - performance.now());
      const timer = setTimeout(() => {
        set({ opponentQueueTimer: null });
        drainOpponentQueue();
      }, delay);
      set({ opponentQueueTimer: timer });
    }
  };

  return {
  ...initialState,

  setPuzzleSize: (puzzleSize) => set({ puzzleSize }),

  setPhase: (phase) => set({ phase }),

  joinQueue: () => set({ phase: 'queuing' }),

  leaveQueue: () => set({ phase: 'idle', queuePosition: 0, estimatedWait: 0 }),

  setQueueInfo: (queuePosition, estimatedWait) =>
    set({ queuePosition, estimatedWait }),

  startMatch: (matchId, opponent, scores) =>
    set({
      phase: 'matched',
      matchId,
      opponent,
      currentRound: 0,
      // A reconnect mid-match re-emits match_found with the current score —
      // restore it instead of resetting the scoreboard to 0-0.
      myScore: scores?.you ?? 0,
      opponentScore: scores?.opponent ?? 0,
    }),

  startRound: (currentRound, scramble, inspectionStartsAt, solveId, inspectionStartServerMs, inspectionEndServerMs) =>
    set({
      phase: 'inspecting',
      currentRound,
      scramble,
      inspectionStartsAt,
      solveStartsAt: 0,
      myMoves: [],
      opponentMoves: [],
      myTime: null,
      opponentTime: null,
      opponentDone: false,
      // Deterministic timeline
      solveId: solveId || null,
      inspectionStartServerMs: inspectionStartServerMs || null,
      inspectionEndServerMs: inspectionEndServerMs || null,
      mySolveStartServerMs: null,
      myLocalSolveStartPerf: null,
      opponentSolveStartServerMs: null,
      opponentLocalSolveStartPerf: null,
      opponentMoveQueue: [],
      opponentMoveLog: [],
      // Legacy
      opponentSolveClientTs: null,
      opponentSolveReceivedAt: null,
      opponentLastMoveClientTs: null,
    }),

  startSolve: (solveStartsAt) =>
    set({ phase: 'solving', solveStartsAt }),

  addMyMove: (move) =>
    set((state) => ({ myMoves: [...state.myMoves, move] })),

  addOpponentMove: (move) =>
    set((state) => ({ opponentMoves: [...state.opponentMoves, move] })),

  setSolveComplete: (myTime) =>
    set({ phase: 'waiting_opponent', myTime }),

  // opponentTime === null with opponentDone means the opponent DNF'd.
  trimMyMoves: (count) =>
    set((s) => (count < s.myMoves.length ? { myMoves: s.myMoves.slice(0, count) } : {})),

  // moveCount: the opponent's true solving-move count — trailing accidental
  // inputs beyond it are dropped so their cube displays the finished state.
  // The trim must be authoritative: moves still sitting in the 80ms jitter
  // buffer (opponentMoveQueue) would otherwise drain afterward and re-append
  // the trailing moves. So cancel the queue timer, apply exactly enough queued
  // moves to reach moveCount, and drop the rest — leaving the applied set at
  // precisely moveCount.
  setOpponentDone: (opponentTime, moveCount) =>
    set((s) => {
      if (typeof moveCount !== 'number') {
        return { opponentTime, opponentDone: true };
      }
      if (s.opponentQueueTimer) clearTimeout(s.opponentQueueTimer);
      let opponentMoves = s.opponentMoves;
      if (moveCount < opponentMoves.length) {
        // Already applied past the real finish (trailing inputs) — trim back.
        opponentMoves = opponentMoves.slice(0, moveCount);
      } else if (moveCount > opponentMoves.length && s.opponentMoveQueue.length) {
        // Some real solving moves are still queued — apply just enough.
        const needed = moveCount - opponentMoves.length;
        opponentMoves = [
          ...opponentMoves,
          ...s.opponentMoveQueue.slice(0, needed).map((m) => m.move),
        ];
      }
      return {
        opponentTime,
        opponentDone: true,
        opponentMoves,
        opponentMoveQueue: [],
        opponentQueueTimer: null,
      };
    }),

  setOpponentStarted: (clientTs) =>
    set({
      opponentSolveClientTs: clientTs,
      opponentSolveReceivedAt: Date.now(),
      opponentLastMoveClientTs: clientTs,
    }),

  setOpponentMoveTs: (clientTs) =>
    set({ opponentLastMoveClientTs: clientTs }),

  setRoundResult: (winner, scores) =>
    set({
      phase: 'round_complete',
      roundWinner: winner,
      myScore: scores.you,
      opponentScore: scores.opponent,
    }),

  setMatchComplete: (matchWinner, mmrDelta, newMmr, newLeague) =>
    set({
      phase: 'match_complete',
      matchWinner,
      mmrDelta,
      newMmr,
      newLeague,
    }),

  reset: () => {
    // Clear any scheduled moves before resetting
    const state = get();
    state.clearScheduledMoves();
    // Preserve the NTP clock-sync offset across resets — it's a property of the
    // live connection, not the match. Wiping it to 0 made the first rematch
    // round pace the opponent off a bogus zero offset until sync re-settled.
    set({
      ...initialState,
      serverOffsetMs: state.serverOffsetMs,
      serverOffsetSamples: state.serverOffsetSamples,
      lastClockSyncAt: state.lastClockSyncAt,
    });
  },

  // Clock synchronization
  updateServerOffset: (sample: number) => {
    const state = get();
    const samples = [...state.serverOffsetSamples, sample].slice(-5); // Keep last 5 samples
    // Use median for smoothing
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    set({
      serverOffsetMs: median,
      serverOffsetSamples: samples,
      lastClockSyncAt: Date.now(),
    });
  },

  // Deterministic replay: set MY solve start
  setMySolveStart: (solveStartServerMs: number, localPerfMs: number) => {
    set({
      mySolveStartServerMs: solveStartServerMs,
      myLocalSolveStartPerf: localPerfMs,
    });
    // Log for debugging
    const state = get();
    console.log(`[SYNC] My solve start: solveId=${state.solveId}, solveStartServerMs=${solveStartServerMs}, localPerfMs=${localPerfMs}, serverOffsetMs=${state.serverOffsetMs}`);
  },

  // Deterministic replay: set OPPONENT's solve start
  setOpponentSolveStart: (solveStartServerMs: number) => {
    const state = get();
    // Compute estimated server time now
    const estimatedServerNowMs = Date.now() + state.serverOffsetMs;
    // Compute local perf time when opponent's solve started
    // localSolveStartPerf = performance.now() + (solveStartServerMs - estimatedServerNowMs) + bufferMs
    const opponentLocalSolveStartPerf =
      performance.now() + (solveStartServerMs - estimatedServerNowMs) + REPLAY_BUFFER_MS;

    set({
      opponentSolveStartServerMs: solveStartServerMs,
      opponentLocalSolveStartPerf,
      // Also set legacy fields for backward compatibility
      opponentSolveReceivedAt: Date.now(),
    });

    // Log for debugging
    console.log(`[SYNC] Opponent solve start: solveId=${state.solveId}, solveStartServerMs=${solveStartServerMs}, opponentLocalSolveStartPerf=${opponentLocalSolveStartPerf}, serverOffsetMs=${state.serverOffsetMs}`);
  },

  // Enqueue an opponent move for deterministic replay (applied in strict
  // arrival order, paced by its relative timestamp)
  scheduleOpponentMove: (solveId: string, seq: number, move: string, tMs: number) => {
    const state = get();

    // Verify this is for the current solve. Only drop on a true mismatch:
    // when we don't know our own solveId (a round_start that lacked it, e.g.
    // an older server or a partial reconnect frame), apply the move anyway —
    // dropping it would silently freeze the opponent's cube for the round.
    if (state.solveId !== null && state.solveId !== solveId) {
      console.warn(`[SYNC] Ignoring move for old solve: ${solveId} (current: ${state.solveId})`);
      return;
    }

    const arrivalPerf = performance.now();

    // Without an anchor yet the timeline is unknown — apply as it arrives
    // (target 0 = immediately, still in order behind anything queued).
    const computedTarget =
      state.opponentLocalSolveStartPerf === null ? 0 : state.opponentLocalSolveStartPerf + tMs;

    // Never target earlier than the move already queued behind — tMs can
    // regress (e.g. produced against a re-anchored clock), and the queue must
    // drain strictly in order.
    const lastQueued = state.opponentMoveQueue[state.opponentMoveQueue.length - 1];
    const targetPerf = Math.max(computedTarget, lastQueued ? lastQueued.targetPerfMs : 0);
    const lateness = arrivalPerf - targetPerf;

    // Log first 10 moves
    if (state.opponentMoveLog.length < 10) {
      set((s) => ({
        opponentMoveLog: [...s.opponentMoveLog, { seq, tMs, arrivalPerf, targetPerf, lateness }],
      }));
      console.log(`[SYNC] Move ${seq}: tMs=${tMs}, arrivalPerf=${arrivalPerf.toFixed(0)}, targetPerf=${targetPerf.toFixed(0)}, lateness=${lateness.toFixed(0)}ms`);
    }

    set((s) => ({
      opponentMoveQueue: [...s.opponentMoveQueue, { seq, move, targetPerfMs: targetPerf }],
    }));
    drainOpponentQueue();
  },

  // Clear the pending opponent move queue (on round end or reset)
  clearScheduledMoves: () => {
    const timer = get().opponentQueueTimer;
    if (timer) clearTimeout(timer);
    set({ opponentMoveQueue: [], opponentQueueTimer: null, opponentMoveLog: [] });
  },
  };
});
