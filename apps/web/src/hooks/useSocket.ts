'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import type { PuzzleSize, ServerEvents } from '@plus2/shared';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

export interface ChallengeInfo {
  code: string;
  puzzleSize: PuzzleSize;
}

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
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
    setRoundResult,
    setMatchComplete,
    reset,
  } = useGameStore();

  const [challenge, setChallenge] = useState<ChallengeInfo | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  // Connect socket
  useEffect(() => {
    if (!accessToken) return;

    const socket = io(`${SOCKET_URL}/game`, {
      auth: { token: accessToken },
      transports: ['websocket'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to game server');
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from game server');
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

    socket.on('round_start', (data: ServerEvents['round_start']) => {
      startRound(data.round, data.scramble, data.inspectionStartsAt);
    });

    socket.on('inspection_end', (data: ServerEvents['inspection_end']) => {
      startSolve(data.solveStartsAt);
    });

    socket.on('opponent_move', (data: ServerEvents['opponent_move']) => {
      addOpponentMove(data.move);
    });

    socket.on('opponent_started', (data: { startedAt: number }) => {
      setOpponentStarted(data.startedAt);
    });

    socket.on('opponent_done', (data: ServerEvents['opponent_done']) => {
      setOpponentDone(data.timeMs);
    });

    socket.on('solve_result', (data: ServerEvents['solve_result']) => {
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

    socket.on('opponent_disconnect', () => {
      console.log('Opponent disconnected');
    });

    // Challenge events
    socket.on('challenge_created', (data: { code: string; puzzleSize: PuzzleSize }) => {
      setChallenge({ code: data.code, puzzleSize: data.puzzleSize });
      setChallengeError(null);
    });

    socket.on('challenge_cancelled', () => {
      setChallenge(null);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [accessToken]);

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
      socketRef.current.emit('move', {
        seq,
        move,
        clientTs: Date.now(),
      });
    }
  }, []);

  const sendSolveComplete = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit('solve_complete', {});
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
