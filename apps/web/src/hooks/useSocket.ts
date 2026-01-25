'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import type { PuzzleSize, ServerEvents } from '@plus2/shared';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

// Clock sync interval (30 seconds)
const CLOCK_SYNC_INTERVAL_MS = 30000;

export interface ChallengeInfo {
  code: string;
  puzzleSize: PuzzleSize;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const clockSyncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { accessToken, updateUser } = useAuthStore();
  const {
    puzzleSize,
    setPhase,
    setQueueInfo,
    startMatch,
    startRound,
    startSolve,
    addOpponentMove,
    setOpponentDone,
    setOpponentStarted,
    setOpponentMoveTs,
    setRoundResult,
    setMatchComplete,
    reset,
    updateServerOffset,
    setOpponentSolveStart,
    scheduleOpponentMove,
    clearScheduledMoves,
  } = useGameStore();

  const [challenge, setChallenge] = useState<ChallengeInfo | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  // NTP-lite clock sync function
  const performClockSync = useCallback((socket: Socket) => {
    const clientSendPerfMs = performance.now();
    socket.emit('clock_sync', { clientSendPerfMs });
  }, []);

  // Connect socket
  useEffect(() => {
    if (!accessToken) return;

    const socket = io(`${SOCKET_URL}/game`, {
      auth: { token: accessToken },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      // Perform initial clock sync
      performClockSync(socket);

      // Set up periodic clock sync
      if (clockSyncIntervalRef.current) {
        clearInterval(clockSyncIntervalRef.current);
      }
      clockSyncIntervalRef.current = setInterval(() => {
        performClockSync(socket);
      }, CLOCK_SYNC_INTERVAL_MS);
    });

    socket.on('disconnect', () => {
      // Clear clock sync interval
      if (clockSyncIntervalRef.current) {
        clearInterval(clockSyncIntervalRef.current);
        clockSyncIntervalRef.current = null;
      }
    });

    // Handle clock sync response
    socket.on('clock_sync_response', (data: { clientSendPerfMs: number; serverNowMs: number }) => {
      const clientRecvPerfMs = performance.now();
      const rtt = clientRecvPerfMs - data.clientSendPerfMs;
      const oneWay = rtt / 2;
      // serverOffsetMs: Date.now() + serverOffsetMs ≈ server time
      const serverOffsetSample = data.serverNowMs - (Date.now() - oneWay);
      updateServerOffset(serverOffsetSample);
    });

    socket.on('error', (data: { code: string; message: string }) => {
      console.error('Socket error:', data);
      // Handle challenge-related errors
      if (data.code === 'CHALLENGE_NOT_FOUND' || data.code === 'CANNOT_JOIN_OWN' || data.code === 'CHALLENGE_ERROR') {
        setChallengeError(data.message);
      }
    });

    // Queue events
    socket.on('queue_joined', (data: ServerEvents['queue_joined']) => {
      setPhase('queuing');
      setQueueInfo(data.position, data.estimatedWait);
    });

    socket.on('queue_left', () => {
      setPhase('idle');
    });

    // Match events
    socket.on('match_found', (data: ServerEvents['match_found']) => {
      startMatch(data.matchId, data.opponent);
    });

    socket.on('round_start', (data: ServerEvents['round_start'] & {
      solveId?: string;
      inspectionStartServerMs?: number;
      inspectionEndServerMs?: number;
    }) => {
      // Clear any scheduled moves from previous round
      clearScheduledMoves();
      // Use local client time for timer display, but also track server timestamps
      startRound(
        data.round,
        data.scramble,
        Date.now(),
        data.solveId,
        data.inspectionStartServerMs,
        data.inspectionEndServerMs
      );
    });

    socket.on('inspection_end', (data: { solveStartsAt?: number; solveStartServerMs?: number; solveId?: string }) => {
      // When inspection ends, both players' solve phase starts
      // Start my timer and opponent's timer (if not already started)
      const now = Date.now();
      startSolve(now);
      // Also start opponent's timer if they haven't made a move yet
      // This ensures both timers start when inspection ends
      const state = useGameStore.getState();
      if (!state.opponentSolveReceivedAt && data.solveStartServerMs) {
        setOpponentSolveStart(data.solveStartServerMs);
      }
    });

    // Handle my own solve start (server-authoritative)
    socket.on('solve_start', (data: {
      solveId: string;
      solveStartServerMs: number;
      inspectionStartServerMs?: number;
      inspectionEndServerMs?: number;
    }) => {
      const { setMySolveStart } = useGameStore.getState();
      // Record server time and local perf time for my solve
      setMySolveStart(data.solveStartServerMs, performance.now());
    });

    // Handle opponent's solve start (for deterministic replay)
    socket.on('opponent_solve_start', (data: {
      solveId: string;
      solveStartServerMs: number;
      inspectionStartServerMs?: number;
      inspectionEndServerMs?: number;
    }) => {
      setOpponentSolveStart(data.solveStartServerMs);
    });

    socket.on('opponent_move', (data: { solveId?: string; seq: number; move: string; tMs?: number; clientTs?: number }) => {
      // Use deterministic scheduling if we have tMs (relative timestamp)
      if (data.solveId && data.tMs !== undefined) {
        scheduleOpponentMove(data.solveId, data.seq, data.move, data.tMs, (move) => {
          addOpponentMove(move);
        });
      } else {
        // Fallback: apply immediately (legacy behavior)
        addOpponentMove(data.move);
      }
      // Update legacy timestamp field
      if (data.clientTs) {
        setOpponentMoveTs(data.clientTs);
      }
    });

    socket.on('opponent_started', (data: { clientTs?: number; solveStartServerMs?: number }) => {
      // Only start opponent's timer if not already started (e.g., from inspection_end)
      const state = useGameStore.getState();
      if (!state.opponentSolveReceivedAt) {
        if (data.solveStartServerMs) {
          // New system: use server-authoritative time
          setOpponentSolveStart(data.solveStartServerMs);
        } else if (data.clientTs) {
          // Legacy fallback
          setOpponentStarted(data.clientTs);
        }
      }
    });

    socket.on('opponent_done', (data: ServerEvents['opponent_done']) => {
      const state = useGameStore.getState();
      // Log final time for sync debugging
      const opponentDisplayedFinalMs = state.opponentLocalSolveStartPerf !== null
        ? performance.now() - state.opponentLocalSolveStartPerf
        : null;
      console.log(`[SYNC] Opponent done: solveId=${state.solveId}, opponentFinalMs=${data.timeMs}, opponentDisplayedFinalMs=${opponentDisplayedFinalMs?.toFixed(0)}`);
      setOpponentDone(data.timeMs);
    });

    // Receive authoritative time for my own solve (so both players see the same value)
    socket.on('my_solve_time', (data: { timeMs: number }) => {
      const { setSolveComplete } = useGameStore.getState();
      setSolveComplete(data.timeMs);
    });

    socket.on('solve_result', (data: ServerEvents['solve_result']) => {
      // Use the authoritative times from solve_result for both players
      const { setSolveComplete, setOpponentDone } = useGameStore.getState();
      if (data.yourTime !== null) {
        setSolveComplete(data.yourTime);
      }
      if (data.opponentTime !== null) {
        setOpponentDone(data.opponentTime);
      }
      setRoundResult(data.winner as 'you' | 'opponent' | 'draw', data.scores);
    });

    socket.on('match_end', (data: ServerEvents['match_end']) => {
      setMatchComplete(
        data.winner,
        data.mmrDelta,
        data.newMmr,
        data.newLeague
      );
      // Update the auth store with new MMR and league
      updateUser({ mmr: data.newMmr, league: data.newLeague });
    });

    socket.on('opponent_disconnect', () => {});

    // Challenge events
    socket.on('challenge_created', (data: { code: string; puzzleSize: PuzzleSize }) => {
      setChallenge({ code: data.code, puzzleSize: data.puzzleSize });
      setChallengeError(null);
    });

    socket.on('challenge_cancelled', () => {
      setChallenge(null);
    });

    return () => {
      // Clean up clock sync interval
      if (clockSyncIntervalRef.current) {
        clearInterval(clockSyncIntervalRef.current);
        clockSyncIntervalRef.current = null;
      }
      // Clear scheduled moves
      clearScheduledMoves();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken, performClockSync, clearScheduledMoves, updateServerOffset]);

  // Actions
  const joinQueue = useCallback((size: PuzzleSize) => {
    if (socketRef.current) {
      socketRef.current.emit('queue_join', { puzzleSize: size });
    }
  }, []);

  const leaveQueue = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('queue_leave', {});
      setPhase('idle');
    }
  }, [setPhase]);

  const sendReady = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('ready', {});
    }
  }, []);

  const sendMove = useCallback((seq: number, move: string) => {
    if (socketRef.current) {
      const state = useGameStore.getState();
      // Calculate tMs relative to solve start (using performance.now() for precision)
      // If solve hasn't started yet (still in inspection), tMs will be negative for rotations
      const nowPerf = performance.now();
      const tMs = state.myLocalSolveStartPerf !== null
        ? nowPerf - state.myLocalSolveStartPerf
        : 0; // Default to 0 if not yet started (first non-rotation move will trigger solve start)

      socketRef.current.emit('move', {
        seq,
        move,
        tMs,
      });
    }
  }, []);

  const sendSolveComplete = useCallback((timeMs: number | null) => {
    if (socketRef.current) {
      // Send the already-calculated time - server will pass it through to both players
      socketRef.current.emit('solve_complete', { timeMs });
    }
  }, []);

  const sendRematch = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('rematch', {});
      reset();
    }
  }, [reset]);

  const sendRequeue = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('requeue', {});
      reset();
    }
  }, [reset]);

  // Challenge actions
  const createChallenge = useCallback((size: PuzzleSize) => {
    if (socketRef.current) {
      setChallengeError(null);
      socketRef.current.emit('challenge_create', { puzzleSize: size });
    }
  }, []);

  const cancelChallenge = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('challenge_cancel', {});
      setChallenge(null);
    }
  }, []);

  const joinChallenge = useCallback((code: string) => {
    if (socketRef.current) {
      setChallengeError(null);
      socketRef.current.emit('challenge_join', { code: code.toUpperCase() });
    }
  }, []);

  return {
    socket: socketRef.current,
    joinQueue,
    leaveQueue,
    sendReady,
    sendMove,
    sendSolveComplete,
    sendRematch,
    sendRequeue,
    // Challenge
    challenge,
    challengeError,
    createChallenge,
    cancelChallenge,
    joinChallenge,
  };
}
