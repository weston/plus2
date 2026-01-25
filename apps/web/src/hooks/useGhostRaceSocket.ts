'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import type { PuzzleSize, LeagueTier, MoveRecord } from '@plus2/shared';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

type GhostRacePhase =
  | 'idle'
  | 'starting'
  | 'inspecting'
  | 'solving'
  | 'round_complete'
  | 'race_complete';

export interface GhostRaceState {
  phase: GhostRacePhase;
  raceId: string | null;
  puzzleSize: PuzzleSize;
  currentRound: number;
  totalRounds: number;
  scramble: string;
  inspectionStartsAt: number;
  solveStartsAt: number;
  // Ghost info
  ghostUsername: string;
  ghostMmr: number;
  isOldGhost: boolean;
  ghostMoves: MoveRecord[];
  ghostTime: number | null;
  ghostInspectionStartAt: number; // Original inspection start timestamp for timing
  // Round results
  lastUserTime: number | null;
  lastGhostTime: number | null;
  lastUserWonRound: boolean | null;
  // Final results
  userWins: number;
  ghostWins: number;
  userWon: boolean | null;
  mmrDelta: number;
  newMmr: number;
  newLeague: LeagueTier | null;
  error: string | null;
}

const initialState: GhostRaceState = {
  phase: 'idle',
  raceId: null,
  puzzleSize: '3x3',
  currentRound: 0,
  totalRounds: 5,
  scramble: '',
  inspectionStartsAt: 0,
  solveStartsAt: 0,
  ghostUsername: '',
  ghostMmr: 0,
  isOldGhost: false,
  ghostMoves: [],
  ghostTime: null,
  ghostInspectionStartAt: 0,
  lastUserTime: null,
  lastGhostTime: null,
  lastUserWonRound: null,
  userWins: 0,
  ghostWins: 0,
  userWon: null,
  mmrDelta: 0,
  newMmr: 0,
  newLeague: null,
  error: null,
};

export function useGhostRaceSocket() {
  const socketRef = useRef<Socket | null>(null);
  const { accessToken, updateUser } = useAuthStore();

  const [state, setState] = useState<GhostRaceState>(initialState);

  // Connect socket
  useEffect(() => {
    if (!accessToken) return;

    const socket = io(`${SOCKET_URL}/game`, {
      auth: { token: accessToken },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Ghost race socket connected');
    });

    socket.on('disconnect', () => {
      console.log('Ghost race socket disconnected');
    });

    socket.on('error', (data: { code: string; message: string }) => {
      console.error('Ghost race socket error:', data);
      setState((prev) => ({ ...prev, error: data.message }));
    });

    // Ghost race events
    socket.on('ghost_race_started', (data: {
      raceId: string;
      puzzleSize: PuzzleSize;
      totalRounds: number;
      ghostUsername: string;
      ghostMmr: number;
      isOldGhost: boolean;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'starting',
        raceId: data.raceId,
        puzzleSize: data.puzzleSize,
        totalRounds: data.totalRounds,
        ghostUsername: data.ghostUsername,
        ghostMmr: data.ghostMmr,
        isOldGhost: data.isOldGhost,
        userWins: 0,
        ghostWins: 0,
        error: null,
      }));
    });

    socket.on('ghost_race_round_start', (data: {
      round: number;
      totalRounds: number;
      scramble: string;
      inspectionStartsAt: number;
      ghostMoves: MoveRecord[];
      ghostTime: number | null;
      ghostInspectionStartAt: number;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'inspecting',
        currentRound: data.round,
        totalRounds: data.totalRounds,
        scramble: data.scramble,
        inspectionStartsAt: data.inspectionStartsAt,
        solveStartsAt: 0,
        ghostMoves: data.ghostMoves || [],
        ghostTime: data.ghostTime,
        ghostInspectionStartAt: data.ghostInspectionStartAt || 0,
        lastUserTime: null,
        lastGhostTime: null,
        lastUserWonRound: null,
      }));
    });

    socket.on('ghost_race_inspection_end', (data: { solveStartsAt: number }) => {
      setState((prev) => ({
        ...prev,
        phase: 'solving',
        solveStartsAt: data.solveStartsAt,
      }));
    });

    socket.on('ghost_race_solve_result', (data: {
      round: number;
      userTime: number | null;
      ghostTime: number | null;
      userWonRound: boolean;
      completedRounds: number;
      totalRounds: number;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'round_complete',
        lastUserTime: data.userTime,
        lastGhostTime: data.ghostTime,
        lastUserWonRound: data.userWonRound,
        userWins: prev.userWins + (data.userWonRound ? 1 : 0),
        ghostWins: prev.ghostWins + (!data.userWonRound && data.ghostTime !== null ? 1 : 0),
      }));
    });

    socket.on('ghost_race_dnf', (data: { reason: string }) => {
      console.log('Ghost race DNF:', data.reason);
    });

    socket.on('ghost_race_end', (data: {
      userWins: number;
      ghostWins: number;
      userWon: boolean;
      mmrDelta: number;
      newMmr: number;
      newLeague: LeagueTier;
      ghostUsername: string;
      isOldGhost: boolean;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'race_complete',
        userWins: data.userWins,
        ghostWins: data.ghostWins,
        userWon: data.userWon,
        mmrDelta: data.mmrDelta,
        newMmr: data.newMmr,
        newLeague: data.newLeague,
      }));
      updateUser({ mmr: data.newMmr, league: data.newLeague });
    });

    socket.on('ghost_race_abandoned', () => {
      setState(initialState);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, updateUser]);

  // Actions
  const startRace = useCallback((size: PuzzleSize) => {
    if (socketRef.current) {
      setState((prev) => ({ ...prev, error: null }));
      socketRef.current.emit('ghost_race_start', { puzzleSize: size });
    }
  }, []);

  const sendMove = useCallback((seq: number, move: string) => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_move', {
        seq,
        move,
        clientTs: Date.now(),
      });
    }
  }, []);

  const sendComplete = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_complete', {});
    }
  }, []);

  const abandonRace = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_abandon', {});
      setState(initialState);
    }
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    startRace,
    sendMove,
    sendComplete,
    abandonRace,
    reset,
  };
}
