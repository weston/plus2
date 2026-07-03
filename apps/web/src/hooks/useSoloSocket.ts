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
  // True while the socket is dropped mid-session so the page can show a
  // "reconnecting" state instead of hanging on 'solving' forever.
  connectionLost: boolean;
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
  connectionLost: false,
};

export function useSoloSocket() {
  const socketRef = useRef<Socket | null>(null);
  // Key the connect effect on whether we're authed at all — NOT on the token
  // string. A mid-session token refresh keeps us authed, so the live socket
  // must survive it; tearing it down would make the server record an abandon.
  const isAuthed = useAuthStore((s) => !!s.accessToken);

  const [state, setState] = useState<SoloState>(initialState);

  // Connect socket
  useEffect(() => {
    if (!isAuthed) return;

    const socket = io(`${SOCKET_URL}/game`, {
      // Read the current token on every (re)connect so a refresh mid-session
      // reconnects with the fresh token, not the stale creation-time one.
      auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      // Back online — let the page drop any "reconnecting" UI.
      setState((prev) => (prev.connectionLost ? { ...prev, connectionLost: false } : prev));
    });

    socket.on('disconnect', (reason) => {
      // Our own teardown (unmount / manual disconnect) — nothing to surface.
      if (reason === 'io client disconnect') return;
      // Surface a recoverable dropped-session state; socket.io auto-reconnects
      // transient blips, and a server-initiated close is kicked below.
      setState((prev) => (prev.connectionLost ? prev : { ...prev, connectionLost: true }));
      if (reason === 'io server disconnect') socket.connect();
    });

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
      // Use local client time for timer display (server calculates final time).
      // Only valid while inspecting — a stray/orphaned inspection_end (e.g.
      // from a round completed early) must not flip a results screen or the
      // next round into "solving" with a phantom running timer.
      setState((prev) => {
        if (prev.phase !== 'inspecting') return prev;
        return {
          ...prev,
          phase: 'solving',
          solveStartsAt: Date.now(),
        };
      });
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
  }, [isAuthed]);

  // Actions
  const startSolo = useCallback((size: PuzzleSize) => {
    if (socketRef.current) {
      socketRef.current.emit('solo_start', { puzzleSize: size });
    }
  }, []);

  // Moves are now collected locally and sent with complete
  // This avoids race conditions and reduces network traffic
  const sendComplete = useCallback((moves: Array<{ seq: number; move: string; tMs: number }>, isDnf: boolean = false, timeMs?: number) => {
    if (socketRef.current) {
      // Sort by timestamp to ensure correct order, then send all at once
      const sortedMoves = [...moves].sort((a, b) => a.tMs - b.tMs);
      socketRef.current.emit('solo_complete', { moves: sortedMoves, isDnf, timeMs });
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
    sendComplete,
    abandonSolo,
    reset,
  };
}
