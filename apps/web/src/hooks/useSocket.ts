'use client';

import { useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '@/stores/auth';
import { useGameStore } from '@/stores/game';
import { useChallengeStore } from '@/stores/challenge';
import { useChatStore, type ChatMsg } from '@/stores/chatroom';
import type { PuzzleSize, ServerEvents } from '@plus2/shared';

export type { ChallengeInfo } from '@/stores/challenge';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

// Clock sync interval (30 seconds)
const CLOCK_SYNC_INTERVAL_MS = 30000;

// ---------------------------------------------------------------------------
// Shared socket singleton
//
// One /game socket for the whole app, created on demand and kept across page
// navigation. Pages used to each mount their own socket, which forced a
// disconnect/reconnect for BOTH players right as a match started (the
// /challenge → /match and /dashboard → /match hops) and made match setup
// depend entirely on the server's rejoin resync. Handlers write to global
// zustand stores, so they're registered once per socket, independent of any
// component lifecycle.
// ---------------------------------------------------------------------------

interface SharedSocket {
  socket: Socket;
  userId: string | null; // JWT `sub` the socket was created for
  clockSyncInterval: ReturnType<typeof setInterval> | null;
}

// Stashed on globalThis so dev hot-reload reuses the connection instead of
// leaking a second one.
const g = globalThis as unknown as { __plus2GameSocket?: SharedSocket | null };

function decodeJwtSub(token: string): string | null {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64))?.sub ?? null;
  } catch {
    return null;
  }
}

function teardownSocket() {
  const shared = g.__plus2GameSocket;
  if (!shared) return;
  g.__plus2GameSocket = null;
  if (shared.clockSyncInterval) clearInterval(shared.clockSyncInterval);
  shared.socket.removeAllListeners();
  shared.socket.disconnect();
  useGameStore.getState().clearScheduledMoves();
}

/**
 * Get the shared socket for the current auth state, creating it if needed.
 * Logged out → tears the socket down and returns null. A token refresh for
 * the SAME user keeps the existing connection (the auth callback below hands
 * fresh credentials to any future reconnect attempt).
 */
function ensureSocket(): Socket | null {
  if (typeof window === 'undefined') return null;

  const token = useAuthStore.getState().accessToken;
  if (!token) {
    teardownSocket();
    return null;
  }

  const userId = decodeJwtSub(token);
  const existing = g.__plus2GameSocket;
  if (existing && existing.userId === userId) return existing.socket;

  teardownSocket();

  const socket = io(`${SOCKET_URL}/game`, {
    // Evaluated on every connection attempt, so reconnects after a token
    // refresh authenticate with the current token, not the creation-time one.
    auth: (cb) => cb({ token: useAuthStore.getState().accessToken }),
    transports: ['websocket'],
  });

  const shared: SharedSocket = { socket, userId, clockSyncInterval: null };
  g.__plus2GameSocket = shared;
  registerHandlers(socket, shared);
  return socket;
}

// NTP-lite clock sync
function performClockSync(socket: Socket) {
  socket.emit('clock_sync', { clientSendPerfMs: performance.now() });
}

function registerHandlers(socket: Socket, shared: SharedSocket) {
  socket.on('connect', () => {
    // Take a quick burst of clock-sync samples so the median offset settles
    // fast (a single bad first sample used to skew replay pacing), then keep
    // it fresh periodically.
    performClockSync(socket);
    setTimeout(() => socket.connected && performClockSync(socket), 400);
    setTimeout(() => socket.connected && performClockSync(socket), 1000);
    if (shared.clockSyncInterval) clearInterval(shared.clockSyncInterval);
    shared.clockSyncInterval = setInterval(() => {
      performClockSync(socket);
    }, CLOCK_SYNC_INTERVAL_MS);
  });

  socket.on('disconnect', () => {
    if (shared.clockSyncInterval) {
      clearInterval(shared.clockSyncInterval);
      shared.clockSyncInterval = null;
    }
    // Pending scheduled opponent moves are for a live round; drop them. On
    // reconnect the server resyncs the round (including a move replay).
    useGameStore.getState().clearScheduledMoves();
  });

  // Handle clock sync response
  socket.on('clock_sync_response', (data: { clientSendPerfMs: number; serverNowMs: number }) => {
    const clientRecvPerfMs = performance.now();
    const rtt = clientRecvPerfMs - data.clientSendPerfMs;
    const oneWay = rtt / 2;
    // serverOffsetMs: Date.now() + serverOffsetMs ≈ server time
    const serverOffsetSample = data.serverNowMs - (Date.now() - oneWay);
    useGameStore.getState().updateServerOffset(serverOffsetSample);
  });

  socket.on('error', (data: { code: string; message: string }) => {
    console.error('Socket error:', data);
    // Handle challenge-related errors
    if (data.code === 'CHALLENGE_NOT_FOUND' || data.code === 'CANNOT_JOIN_OWN' || data.code === 'CHALLENGE_ERROR') {
      useChallengeStore.getState().setError(data.message);
    }
  });

  // Queue events
  socket.on('queue_joined', (data: ServerEvents['queue_joined']) => {
    const game = useGameStore.getState();
    game.setPhase('queuing');
    game.setQueueInfo(data.position, data.estimatedWait);
  });

  socket.on('queue_left', () => {
    useGameStore.getState().setPhase('idle');
  });

  // Match events
  socket.on('match_found', (data: ServerEvents['match_found'] & {
    opponent: {
      id: string;
      username: string;
      mmr: number;
      league: string;
      country?: string | null;
      gamesPlayed?: number;
      gamesWon?: number;
      cubeColors?: Record<string, string> | null;
    };
    scores?: { you: number; opponent: number };
  }) => {
    // The pending challenge (if any) has been consumed by this match.
    const challengeStore = useChallengeStore.getState();
    challengeStore.setChallenge(null);
    challengeStore.setError(null);
    challengeStore.setIncoming(null);
    useChatStore.getState().resetMatchChat();

    useGameStore.getState().startMatch(
      data.matchId,
      {
        ...data.opponent,
        country: data.opponent.country || null,
        gamesPlayed: data.opponent.gamesPlayed || 0,
        gamesWon: data.opponent.gamesWon || 0,
        cubeColors: data.opponent.cubeColors ?? null,
      },
      data.scores,
    );
  });

  socket.on('round_start', (data: ServerEvents['round_start']) => {
    const game = useGameStore.getState();
    // Clear any scheduled moves from previous round
    game.clearScheduledMoves();
    // Timer display uses local client time. Live rounds start "now"; on a
    // mid-round rejoin the server's inspection start is well in the past —
    // map it to local time so the countdown shows the REAL remaining
    // inspection instead of restarting at 15s.
    let localInspectionStart = Date.now();
    if (data.inspectionStartServerMs) {
      const mapped = data.inspectionStartServerMs - game.serverOffsetMs;
      if (mapped < localInspectionStart - 1000) {
        localInspectionStart = mapped;
      }
    }
    game.startRound(
      data.round,
      data.scramble,
      localInspectionStart,
      data.solveId,
      data.inspectionStartServerMs,
      data.inspectionEndServerMs
    );
  });

  socket.on('inspection_end', (data: { solveStartsAt?: number; solveStartServerMs?: number; solveId?: string }) => {
    // When inspection ends, both players' solve phase starts
    // Start my timer and opponent's timer (if not already started)
    const game = useGameStore.getState();
    game.startSolve(Date.now());
    // Also start opponent's timer if they haven't made a move yet
    // This ensures both timers start when inspection ends
    if (!game.opponentSolveReceivedAt && data.solveStartServerMs) {
      game.setOpponentSolveStart(data.solveStartServerMs);
    }
  });

  // Handle my own solve start (server-authoritative)
  socket.on('solve_start', (data: ServerEvents['solve_start']) => {
    // Keep the FIRST local anchor (set when the first move was made): move
    // timestamps (tMs) are produced against it, and re-anchoring to this
    // event's arrival time makes tMs regress mid-burst, which scrambled the
    // opponent-side replay order. Only anchor here if no move set one yet
    // (e.g. the solve was started by inspection ending).
    const game = useGameStore.getState();
    if (game.myLocalSolveStartPerf === null) {
      game.setMySolveStart(data.solveStartServerMs, performance.now());
    }
  });

  // Handle opponent's solve start (for deterministic replay)
  socket.on('opponent_solve_start', (data: ServerEvents['opponent_solve_start']) => {
    useGameStore.getState().setOpponentSolveStart(data.solveStartServerMs);
  });

  socket.on('opponent_move', (data: { solveId?: string; seq: number; move: string; tMs?: number; clientTs?: number }) => {
    const game = useGameStore.getState();
    // Use deterministic scheduling if we have tMs (relative timestamp)
    if (data.solveId && data.tMs !== undefined) {
      game.scheduleOpponentMove(data.solveId, data.seq, data.move, data.tMs);
    } else {
      // Fallback: apply immediately (legacy behavior)
      game.addOpponentMove(data.move);
    }
    // Update legacy timestamp field
    if (data.clientTs) {
      game.setOpponentMoveTs(data.clientTs);
    }
  });

  socket.on('opponent_started', (data: { clientTs?: number; solveStartServerMs?: number }) => {
    // Only start opponent's timer if not already started (e.g., from inspection_end)
    const game = useGameStore.getState();
    if (!game.opponentSolveReceivedAt) {
      if (data.solveStartServerMs) {
        // New system: use server-authoritative time
        game.setOpponentSolveStart(data.solveStartServerMs);
      } else if (data.clientTs) {
        // Legacy fallback
        game.setOpponentStarted(data.clientTs);
      }
    }
  });

  socket.on('opponent_done', (data: ServerEvents['opponent_done']) => {
    const game = useGameStore.getState();
    // Log final time for sync debugging
    const opponentDisplayedFinalMs = game.opponentLocalSolveStartPerf !== null
      ? performance.now() - game.opponentLocalSolveStartPerf
      : null;
    console.log(`[SYNC] Opponent done: solveId=${game.solveId}, opponentFinalMs=${data.timeMs}, opponentDisplayedFinalMs=${opponentDisplayedFinalMs?.toFixed(0)}`);
    game.setOpponentDone(data.timeMs);
  });

  // Receive authoritative time for my own solve (so both players see the same
  // value). null = the solve was a DNF.
  socket.on('my_solve_time', (data: { timeMs: number | null }) => {
    useGameStore.getState().setSolveComplete(data.timeMs);
  });

  socket.on('solve_result', (data: ServerEvents['solve_result']) => {
    // Use the authoritative times from solve_result for both players.
    // null times are DNFs — still terminal, so set them unconditionally.
    const game = useGameStore.getState();
    game.setSolveComplete(data.yourTime);
    game.setOpponentDone(data.opponentTime);
    game.setRoundResult(data.winner as 'you' | 'opponent' | 'draw', data.scores);
  });

  socket.on('match_end', (data: ServerEvents['match_end']) => {
    useGameStore.getState().setMatchComplete(
      data.winner,
      data.mmrDelta,
      data.newMmr,
      data.newLeague
    );
    // Update the auth store with new MMR and league
    useAuthStore.getState().updateUser({ mmr: data.newMmr, league: data.newLeague });
  });

  socket.on('opponent_disconnect', () => {});

  // Another of this user's tabs took over the match — this tab's socket was
  // detached. Reset local match state so a stale /match page redirects away
  // instead of showing a frozen game.
  socket.on('match_detached', (data: { matchId: string }) => {
    const game = useGameStore.getState();
    if (game.matchId === data.matchId) {
      console.log('[SYNC] Match taken over by another tab — detaching this one');
      game.reset();
    }
  });

  // Challenge events
  socket.on('challenge_created', (data: { code: string; puzzleSize: PuzzleSize; targetUsername?: string | null }) => {
    useChallengeStore.getState().setChallenge({
      code: data.code,
      puzzleSize: data.puzzleSize,
      targetUsername: data.targetUsername ?? null,
    });
    useChallengeStore.getState().setDeclinedBy(null);
  });

  socket.on('challenge_cancelled', () => {
    useChallengeStore.getState().setChallenge(null);
  });

  // Direct challenges: someone knocked; they declined mine; they withdrew.
  socket.on('challenge_incoming', (data: ServerEvents['challenge_incoming']) => {
    useChallengeStore.getState().setIncoming(data);
  });

  socket.on('challenge_declined', (data: { username: string }) => {
    const store = useChallengeStore.getState();
    store.setDeclinedBy(data.username);
    store.setChallenge(null);
  });

  socket.on('challenge_revoked', (data: { code: string }) => {
    const store = useChallengeStore.getState();
    if (store.incoming?.code === data.code) store.setIncoming(null);
  });

  // Global chat (front page): joined confirmation carries recent history and
  // whether this account may send (WCA-verified only).
  socket.on('chat_joined', (data: { canSend: boolean; messages: ChatMsg[] }) => {
    useChatStore.getState().setJoined(data.canSend, data.messages || []);
  });

  socket.on('chat_message', (data: ChatMsg) => {
    useChatStore.getState().addMessage(data);
  });

  // In-match chat between the two live players.
  socket.on('match_chat', (data: ChatMsg) => {
    useChatStore.getState().addMatchMessage(data);
  });
}

// React to login/logout/user-switch even when no socket-using page is mounted
// (e.g. logging out from /settings drops the connection immediately).
if (typeof window !== 'undefined') {
  useAuthStore.subscribe((state, prevState) => {
    if (state.accessToken !== prevState.accessToken) {
      ensureSocket();
    }
  });
}

export function useSocket() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const challenge = useChallengeStore((s) => s.challenge);
  const challengeError = useChallengeStore((s) => s.error);

  // Make sure the shared socket exists (or is torn down) for the current auth
  // state. Intentionally NO cleanup on unmount: the socket outlives pages so
  // navigation between /dashboard, /challenge and /match can't drop a match.
  useEffect(() => {
    ensureSocket();
  }, [accessToken]);

  // Actions
  const joinQueue = useCallback((size: PuzzleSize) => {
    ensureSocket()?.emit('queue_join', { puzzleSize: size });
  }, []);

  const leaveQueue = useCallback(() => {
    ensureSocket()?.emit('queue_leave', {});
    useGameStore.getState().setPhase('idle');
  }, []);

  const sendReady = useCallback(() => {
    ensureSocket()?.emit('ready', {});
  }, []);

  // Attach to any live match (match page mount). On a shared socket this
  // replaces the old implicit "new page = new connection = rejoin" flow.
  // Always emitted — if the socket is still connecting, socket.io buffers the
  // emit until after the handshake. The server dedupes when this socket was
  // already attached (e.g. by the connection-time resync after a reload) and
  // otherwise takes over event routing from any other tab's socket.
  const sendMatchRejoin = useCallback(() => {
    ensureSocket()?.emit('match_rejoin', {});
  }, []);

  // Detach from the current match (match page unmount mid-match). The server
  // starts the same abandon grace period a disconnect would.
  const sendMatchLeave = useCallback(() => {
    ensureSocket()?.emit('match_leave', {});
  }, []);

  // Concede immediately (forfeit loss, match ends now).
  const sendResign = useCallback(() => {
    ensureSocket()?.emit('match_resign', {});
  }, []);

  const sendMove = useCallback((seq: number, move: string) => {
    const socket = ensureSocket();
    if (!socket) return;
    const state = useGameStore.getState();
    // Calculate tMs relative to solve start (using performance.now() for precision)
    // If solve hasn't started yet (still in inspection), tMs will be negative for rotations
    const nowPerf = performance.now();
    const tMs = state.myLocalSolveStartPerf !== null
      ? nowPerf - state.myLocalSolveStartPerf
      : 0; // Default to 0 if not yet started (first non-rotation move will trigger solve start)

    socket.emit('move', {
      seq,
      move,
      tMs,
    });
  }, []);

  const sendSolveComplete = useCallback((timeMs: number | null) => {
    // Send the already-calculated time - server will pass it through to both players
    ensureSocket()?.emit('solve_complete', { timeMs });
  }, []);

  const sendRematch = useCallback(() => {
    const socket = ensureSocket();
    if (socket) {
      socket.emit('rematch', {});
      useGameStore.getState().reset();
    }
  }, []);

  const sendRequeue = useCallback(() => {
    const socket = ensureSocket();
    if (socket) {
      socket.emit('requeue', {});
      useGameStore.getState().reset();
    }
  }, []);

  // Challenge actions
  const createChallenge = useCallback((size: PuzzleSize, targetUsername?: string) => {
    const store = useChallengeStore.getState();
    store.setError(null);
    store.setDeclinedBy(null);
    ensureSocket()?.emit('challenge_create', { puzzleSize: size, targetUsername });
  }, []);

  const declineChallenge = useCallback((code: string) => {
    ensureSocket()?.emit('challenge_decline', { code });
    useChallengeStore.getState().setIncoming(null);
  }, []);

  const cancelChallenge = useCallback(() => {
    ensureSocket()?.emit('challenge_cancel', {});
    useChallengeStore.getState().setChallenge(null);
  }, []);

  const joinChallenge = useCallback((code: string) => {
    useChallengeStore.getState().setError(null);
    ensureSocket()?.emit('challenge_join', { code: code.toUpperCase() });
  }, []);

  // Global chat
  const joinChat = useCallback(() => {
    ensureSocket()?.emit('chat_join', {});
  }, []);

  const leaveChat = useCallback(() => {
    ensureSocket()?.emit('chat_leave', {});
    useChatStore.getState().leave();
  }, []);

  const sendChat = useCallback((text: string) => {
    ensureSocket()?.emit('chat_send', { text });
  }, []);

  // In-match chat
  const sendMatchChat = useCallback((text: string) => {
    ensureSocket()?.emit('match_chat_send', { text });
  }, []);

  return {
    socket: typeof window === 'undefined' ? null : g.__plus2GameSocket?.socket ?? null,
    joinQueue,
    leaveQueue,
    sendReady,
    sendMatchRejoin,
    sendMatchLeave,
    sendResign,
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
    declineChallenge,
    // Chat
    joinChat,
    leaveChat,
    sendChat,
    sendMatchChat,
  };
}
