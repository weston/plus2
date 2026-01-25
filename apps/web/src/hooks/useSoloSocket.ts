'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import type { PuzzleSize } from '@plus2/shared';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

type SoloPhase =
  | 'idle'
  | 'starting'
  | 'inspecting'
  | 'solving'
  | 'round_complete'
  | 'session_complete';

export interface SolveResult {
  round: number;
  timeMs: number | null;
  moveCount: number;
}

export interface SoloState {
  phase: SoloPhase;
  sessionId: string | null;
  puzzleSize: PuzzleSize;
  currentRound: number;
  totalRounds: number;
  scramble: string;
  inspectionStartsAt: number;
  solveStartsAt: number;
  lastSolveTime: number | null;
  solves: SolveResult[];
  averageTime: number | null;
}

const initialState: SoloState = {
  phase: 'idle',
  sessionId: null,
  puzzleSize: '3x3',
  currentRound: 0,
  totalRounds: 5,
  scramble: '',
  inspectionStartsAt: 0,
  solveStartsAt: 0,
  lastSolveTime: null,
  solves: [],
  averageTime: null,
};

export function useSoloSocket() {
  const socketRef = useRef<Socket | null>(null);
  const { accessToken } = useAuthStore();

  const [state, setState] = useState<SoloState>(initialState);

  // Connect socket
  useEffect(() => {
    if (!accessToken) return;

    const socket = io(`${SOCKET_URL}/game`, {
      auth: { token: accessToken },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {});

    socket.on('disconnect', () => {});

    socket.on('error', (data: { code: string; message: string }) => {
      console.error('Solo socket error:', data);
    });

    // Solo recording events
    socket.on('solo_started', (data: {
      sessionId: string;
      puzzleSize: PuzzleSize;
      totalRounds: number;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'starting',
        sessionId: data.sessionId,
        puzzleSize: data.puzzleSize,
        totalRounds: data.totalRounds,
        solves: [],
        averageTime: null,
      }));
    });

    socket.on('solo_round_start', (data: {
      round: number;
      totalRounds: number;
      scramble: string;
    }) => {
      // Use local client time for timer display (server calculates final time)
      setState((prev) => ({
        ...prev,
        phase: 'inspecting',
        currentRound: data.round,
        totalRounds: data.totalRounds,
        scramble: data.scramble,
        inspectionStartsAt: Date.now(),
        solveStartsAt: 0,
        lastSolveTime: null,
      }));
    });

    socket.on('solo_inspection_end', () => {
      // Use local client time for timer display (server calculates final time)
      setState((prev) => ({
        ...prev,
        phase: 'solving',
        solveStartsAt: Date.now(),
      }));
    });

    socket.on('solo_solve_result', (data: {
      round: number;
      timeMs: number | null;
      completedRounds: number;
      totalRounds: number;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'round_complete',
        lastSolveTime: data.timeMs,
      }));
    });

    socket.on('solo_dnf', () => {});

    socket.on('solo_end', (data: {
      solves: Array<{ round: number; timeMs: number | null; moveCount: number }>;
      averageTime: number | null;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'session_complete',
        solves: data.solves,
        averageTime: data.averageTime,
      }));
    });

    socket.on('solo_abandoned', () => {
      setState(initialState);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken]);

  // Actions
  const startSolo = useCallback((size: PuzzleSize) => {
    if (socketRef.current) {
      socketRef.current.emit('solo_start', { puzzleSize: size });
    }
  }, []);

  const sendMove = useCallback((seq: number, move: string) => {
    if (socketRef.current) {
      socketRef.current.emit('solo_move', {
        seq,
        move,
        clientTs: Date.now(),
      });
    }
  }, []);

  const sendComplete = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('solo_complete', {});
    }
  }, []);

  const abandonSolo = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('solo_abandon', {});
      setState(initialState);
    }
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    startSolo,
    sendMove,
    sendComplete,
    abandonSolo,
    reset,
  };
}
