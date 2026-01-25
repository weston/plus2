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
}

// Scheduled move for deterministic replay
interface ScheduledMove {
  seq: number;
  move: string;
  tMs: number;
  targetPerfMs: number;
  timeoutId?: ReturnType<typeof setTimeout>;
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
  opponentTime: number | null;

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

  // Scheduled opponent moves for deterministic replay
  scheduledOpponentMoves: ScheduledMove[];
  opponentMoveLog: Array<{ seq: number; tMs: number; arrivalPerf: number; targetPerf: number; lateness: number }>;

  // Legacy fields (for backward compatibility during transition)
  opponentSolveClientTs: number | null;
  opponentSolveReceivedAt: number | null;
  opponentLastMoveClientTs: number | null;

  // Results
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
  startMatch: (matchId: string, opponent: Opponent) => void;
  startRound: (round: number, scramble: string, inspectionStartsAt: number, solveId?: string, inspectionStartServerMs?: number, inspectionEndServerMs?: number) => void;
  startSolve: (solveStartsAt: number) => void;
  addMyMove: (move: string) => void;
  addOpponentMove: (move: string) => void;
  setSolveComplete: (myTime: number | null) => void;
  setOpponentDone: (opponentTime: number) => void;
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
  scheduleOpponentMove: (solveId: string, seq: number, move: string, tMs: number, applyMoveCallback: (move: string) => void) => void;
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

  // Scheduled moves
  scheduledOpponentMoves: [] as ScheduledMove[],
  opponentMoveLog: [] as Array<{ seq: number; tMs: number; arrivalPerf: number; targetPerf: number; lateness: number }>,

  // Legacy fields
  opponentSolveClientTs: null as number | null,
  opponentSolveReceivedAt: null as number | null,
  opponentLastMoveClientTs: null as number | null,

  matchWinner: null as 'you' | 'opponent' | null,
  mmrDelta: 0,
  newMmr: 0,
  newLeague: null as LeagueTier | null,
};

export const useGameStore = create<GameState>((set, get) => ({
  ...initialState,

  setPuzzleSize: (puzzleSize) => set({ puzzleSize }),

  setPhase: (phase) => set({ phase }),

  joinQueue: () => set({ phase: 'queuing' }),

  leaveQueue: () => set({ phase: 'idle', queuePosition: 0, estimatedWait: 0 }),

  setQueueInfo: (queuePosition, estimatedWait) =>
    set({ queuePosition, estimatedWait }),

  startMatch: (matchId, opponent) =>
    set({
      phase: 'matched',
      matchId,
      opponent,
      currentRound: 0,
      myScore: 0,
      opponentScore: 0,
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
      // Deterministic timeline
      solveId: solveId || null,
      inspectionStartServerMs: inspectionStartServerMs || null,
      inspectionEndServerMs: inspectionEndServerMs || null,
      mySolveStartServerMs: null,
      myLocalSolveStartPerf: null,
      opponentSolveStartServerMs: null,
      opponentLocalSolveStartPerf: null,
      scheduledOpponentMoves: [],
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

  setOpponentDone: (opponentTime) =>
    set({ opponentTime }),

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
    set(initialState);
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

  // Schedule opponent move for deterministic replay
  scheduleOpponentMove: (solveId: string, seq: number, move: string, tMs: number, applyMoveCallback: (move: string) => void) => {
    const state = get();

    // Verify this is for the current solve
    if (state.solveId !== solveId) {
      console.warn(`[SYNC] Ignoring move for old solve: ${solveId} (current: ${state.solveId})`);
      return;
    }

    const arrivalPerf = performance.now();

    // If opponent solve start isn't set yet, apply immediately (shouldn't happen in normal flow)
    if (state.opponentLocalSolveStartPerf === null) {
      console.warn(`[SYNC] Opponent solve start not set, applying move immediately: seq=${seq}`);
      applyMoveCallback(move);
      return;
    }

    // Calculate target time for this move
    const targetPerf = state.opponentLocalSolveStartPerf + tMs;
    const delay = targetPerf - arrivalPerf;
    const lateness = arrivalPerf - targetPerf;

    // Log first 10 moves
    if (state.opponentMoveLog.length < 10) {
      set((s) => ({
        opponentMoveLog: [...s.opponentMoveLog, { seq, tMs, arrivalPerf, targetPerf, lateness }],
      }));
      console.log(`[SYNC] Move ${seq}: tMs=${tMs}, arrivalPerf=${arrivalPerf.toFixed(0)}, targetPerf=${targetPerf.toFixed(0)}, lateness=${lateness.toFixed(0)}ms`);
    }

    if (delay <= 0) {
      // Move is late, apply immediately
      if (lateness > 100) {
        console.warn(`[SYNC] Move ${seq} arrived ${lateness.toFixed(0)}ms late`);
      }
      applyMoveCallback(move);
    } else {
      // Schedule move for the future
      const timeoutId = setTimeout(() => {
        applyMoveCallback(move);
        // Remove from scheduled list
        set((s) => ({
          scheduledOpponentMoves: s.scheduledOpponentMoves.filter((m) => m.seq !== seq),
        }));
      }, delay);

      set((s) => ({
        scheduledOpponentMoves: [...s.scheduledOpponentMoves, { seq, move, tMs, targetPerfMs: targetPerf, timeoutId }],
      }));
    }
  },

  // Clear all scheduled moves (on round end or reset)
  clearScheduledMoves: () => {
    const state = get();
    state.scheduledOpponentMoves.forEach((m) => {
      if (m.timeoutId) clearTimeout(m.timeoutId);
    });
    set({ scheduledOpponentMoves: [], opponentMoveLog: [] });
  },
}));
