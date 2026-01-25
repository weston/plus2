'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import type { PuzzleSize, ServerEvents } from '@plus2/shared';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

export function useSocket() {
  const socketRef = useRef<Socket | null>(null);
  const { accessToken } = useAuthStore();
  const {
    puzzleSize,
    setPhase,
    setQueueInfo,
    startMatch,
    startRound,
    startSolve,
    addOpponentMove,
    setOpponentDone,
    setRoundResult,
    setMatchComplete,
    reset,
  } = useGameStore();

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
    });

    socket.on('opponent_disconnect', () => {
      console.log('Opponent disconnected');
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

  return {
    socket: socketRef.current,
    joinQueue,
    leaveQueue,
    sendReady,
    sendMove,
    sendSolveComplete,
    sendRematch,
    sendRequeue,
  };
}
