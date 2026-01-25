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
  opponentSolveStartedAt: number | null; // Server timestamp when opponent started solving

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
  startRound: (round: number, scramble: string, inspectionStartsAt: number) => void;
  startSolve: (solveStartsAt: number) => void;
  addMyMove: (move: string) => void;
  addOpponentMove: (move: string) => void;
  setSolveComplete: (myTime: number | null) => void;
  setOpponentDone: (opponentTime: number) => void;
  setOpponentStarted: (serverTimestamp: number) => void;
  setRoundResult: (winner: 'you' | 'opponent' | 'draw', scores: { you: number; opponent: number }) => void;
  setMatchComplete: (winner: 'you' | 'opponent', mmrDelta: number, newMmr: number, newLeague: LeagueTier) => void;
  reset: () => void;
}

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
  myMoves: [],
  opponentMoves: [],
  myTime: null,
  opponentTime: null,
  opponentSolveStartedAt: null,
  matchWinner: null,
  mmrDelta: 0,
  newMmr: 0,
  newLeague: null,
};

export const useGameStore = create<GameState>((set) => ({
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

  startRound: (currentRound, scramble, inspectionStartsAt) =>
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
      opponentSolveStartedAt: null,
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

  setOpponentStarted: (serverTimestamp) =>
    set({ opponentSolveStartedAt: serverTimestamp }),

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

  reset: () => set(initialState),
}));
