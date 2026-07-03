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
  ghostUserId: string | null;
  ghostSessionId: string | null;
  ghostUsername: string;
  ghostMmr: number;
  isOldGhost: boolean;
  ghostMoves: MoveRecord[];
  ghostTime: number | null;
  ghostInspectionStartAt: number; // Original inspection start timestamp for timing
  ghostSolveStartAt: number; // When ghost started solving (for calculating move timing)
  // Extended ghost info
  ghostCountry: string | null;
  ghostGamesPlayed: number;
  ghostGamesWon: number;
  ghostCubeColors: Record<string, string> | null;
  ghostCubeLogo: string | null;
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
  // No unseen ghosts near the player's rating: the ranked hierarchy says
  // record your own ao5 instead (the page routes there).
  noGhosts: boolean;
  // True while the socket is dropped mid-race so the page can show a
  // "reconnecting" state instead of hanging on 'solving' forever.
  connectionLost: boolean;
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
  ghostUserId: null,
  ghostSessionId: null,
  ghostUsername: '',
  ghostMmr: 0,
  isOldGhost: false,
  ghostMoves: [],
  ghostTime: null,
  ghostInspectionStartAt: 0,
  ghostSolveStartAt: 0,
  // Extended ghost info
  ghostCountry: null,
  ghostGamesPlayed: 0,
  ghostGamesWon: 0,
  ghostCubeColors: null,
  ghostCubeLogo: null,
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
  noGhosts: false,
  connectionLost: false,
};

export function useGhostRaceSocket() {
  const socketRef = useRef<Socket | null>(null);
  // Key the connect effect on whether we're authed at all — NOT on the token
  // string. A mid-session token refresh keeps us authed, so the live socket
  // must survive it; tearing it down would make the server record an abandon
  // (a ranked ghost-race loss).
  const isAuthed = useAuthStore((s) => !!s.accessToken);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [state, setState] = useState<GhostRaceState>(initialState);

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
      console.error('Ghost race socket error:', data);
      setState((prev) => ({ ...prev, error: data.message }));
    });

    // Ghost race events
    socket.on('ghost_race_started', (data: {
      raceId: string;
      puzzleSize: PuzzleSize;
      totalRounds: number;
      ghostUserId?: string;
      ghostSessionId?: string;
      ghostUsername: string;
      ghostMmr: number;
      isOldGhost: boolean;
      ghostCountry?: string | null;
      ghostGamesPlayed?: number;
      ghostGamesWon?: number;
      ghostCubeColors?: Record<string, string> | null;
      ghostCubeLogo?: string | null;
    }) => {
      setState((prev) => ({
        ...prev,
        phase: 'starting',
        raceId: data.raceId,
        puzzleSize: data.puzzleSize,
        totalRounds: data.totalRounds,
        ghostUserId: data.ghostUserId ?? null,
        ghostSessionId: data.ghostSessionId ?? null,
        ghostUsername: data.ghostUsername,
        ghostMmr: data.ghostMmr,
        isOldGhost: data.isOldGhost,
        ghostCountry: data.ghostCountry || null,
        ghostGamesPlayed: data.ghostGamesPlayed || 0,
        ghostGamesWon: data.ghostGamesWon || 0,
        ghostCubeColors: data.ghostCubeColors ?? null,
        ghostCubeLogo: data.ghostCubeLogo ?? null,
        userWins: 0,
        ghostWins: 0,
        error: null,
      }));
    });

    socket.on('ghost_race_round_start', (data: {
      round: number;
      totalRounds: number;
      scramble: string;
      ghostMoves: MoveRecord[];
      ghostTime: number | null;
      ghostInspectionStartAt: number;
      ghostSolveStartAt: number;
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
        ghostMoves: data.ghostMoves || [],
        ghostTime: data.ghostTime,
        ghostInspectionStartAt: data.ghostInspectionStartAt || 0,
        ghostSolveStartAt: data.ghostSolveStartAt || 0,
        lastUserTime: null,
        lastGhostTime: null,
        lastUserWonRound: null,
      }));
    });

    socket.on('ghost_race_inspection_end', () => {
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
        // The ghost only scores on a genuine loss for the user. On a tie
        // (userTime === ghostTime) the server gives NEITHER side a point, so
        // exclude equal times — otherwise we'd wrongly credit the ghost.
        ghostWins:
          prev.ghostWins +
          (!data.userWonRound && data.ghostTime !== null && data.userTime !== data.ghostTime ? 1 : 0),
      }));
    });

    socket.on('ghost_race_dnf', () => {});

    socket.on('ghost_race_end', (data: {
      userWins: number;
      ghostWins: number;
      userWon: boolean;
      mmrDelta: number;
      newMmr: number;
      newLeague: LeagueTier;
      ghostUsername: string;
      isOldGhost: boolean;
      abandoned?: boolean;
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

    // End of the ranked hierarchy: no human, no unseen ghost — the player
    // should record 5 solves (which become their ghost) instead.
    socket.on('ghost_race_unavailable', (data: { message: string }) => {
      setState((prev) => ({
        ...prev,
        phase: 'idle',
        noGhosts: true,
        error: data.message,
      }));
    });

    // Legacy handler - server now sends ghost_race_end with abandoned: true instead
    socket.on('ghost_race_abandoned', () => {
      setState(initialState);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthed, updateUser]);

  // Actions
  const startRace = useCallback((size: PuzzleSize, opponentId?: string) => {
    if (socketRef.current) {
      setState((prev) => ({ ...prev, error: null, noGhosts: false }));
      socketRef.current.emit('ghost_race_start', { puzzleSize: size, opponentId });
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

  const sendComplete = useCallback((isDnf: boolean, solvedMoveCount?: number) => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_complete', { isDnf, solvedMoveCount });
    }
  }, []);

  const abandonRace = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_abandon', {});
      setState(initialState);
    }
  }, []);

  const skipToNextRound = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('ghost_race_skip', {});
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
    skipToNextRound,
    reset,
  };
}
