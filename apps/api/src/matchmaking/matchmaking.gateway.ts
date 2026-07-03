import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { forwardRef, Inject, Optional } from '@nestjs/common';
import { MatchmakingService, QueueEntry, Challenge } from './matchmaking.service';
import { MatchesService } from '../matches/matches.service';
import { SoloService } from '../solo/solo.service';
import { PuzzleSize, PUZZLE_SIZES, INSPECTION_DURATION_MS, RANKED_HUMAN_WAIT_MS } from '@plus2/shared';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
  matchId?: string;
  playerNumber?: 1 | 2;
  soloSessionId?: string;
  ghostRaceId?: string;
}

// Unique ID for each solve in a match (matchId:round)
type SolveId = string;

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/game',
  transports: ['websocket', 'polling'],
})
export class MatchmakingGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Rotation moves don't start the solve timer
  private readonly ROTATION_MOVES = ['x', "x'", 'x2', 'y', "y'", 'y2', 'z', "z'", 'z2'];

  // 10 minute solve timeout
  private readonly SOLVE_TIMEOUT_MS = 10 * 60 * 1000;

  // The ranked ghost fallback is currently orchestrated client-side (the queue
  // page leaves the queue and starts a ghost race after the human-wait window),
  // which avoids reconnection edge cases. This server-side fallback is kept,
  // gated off, for a future fully-server-driven unification.
  private readonly SERVER_GHOST_FALLBACK = false;

  // Map matchId -> match state (stores userIds, not socket refs which can become stale)
  private activeMatches: Map<
    string,
    {
      player1Id: string;
      player2Id: string;
      player1Ready: boolean;
      player2Ready: boolean;
      currentRound: number;
      inspectionTimer?: NodeJS.Timeout;
      player1AbandonTimeout?: NodeJS.Timeout;
      player2AbandonTimeout?: NodeJS.Timeout;
      player1SolveStartedAt?: number;
      player2SolveStartedAt?: number;
      player1SolveTimeout?: NodeJS.Timeout;
      player2SolveTimeout?: NodeJS.Timeout;
      // Set when a player deliberately left the match page (match_leave):
      // a bare reconnect must NOT re-attach them / cancel their forfeit
      // timer — only an explicit match_rejoin does.
      player1Left?: boolean;
      player2Left?: boolean;
      // Server-authoritative solve timeline (for deterministic replay)
      inspectionStartServerMs?: number;
      inspectionEndServerMs?: number;
      player1SolveStartServerMs?: number;
      player2SolveStartServerMs?: number;
    }
  > = new Map();

  // Matchmaking interval
  private matchmakingInterval: NodeJS.Timeout | null = null;

  // Active solo recording sessions (sessionId -> session state)
  private activeSoloSessions: Map<
    string,
    {
      userId: string;
      currentRound: number;
      totalRounds: number;
      inspectionTimer?: NodeJS.Timeout;
      solveTimeout?: NodeJS.Timeout;
      solveStartedAt?: number;
    }
  > = new Map();

  // Active ghost races (raceId -> race state)
  private activeGhostRaces: Map<
    string,
    {
      oderId: string;
      puzzleSize: PuzzleSize;
      ghostSessionId: string;
      ghostUserId: string;
      ghostUsername: string;
      ghostMmrAtRecording: number;
      isOldGhost: boolean;
      isSeed?: boolean; // synthetic seed ghost — don't persist a GhostRace row
      currentRound: number;
      totalRounds: number;
      userTimes: (number | null)[];
      ghostTimes: (number | null)[];
      ghostSolves: Array<{
        scramble: string;
        timeMs: number | null;
        moves: Array<{ move: string; serverTs?: number; tMs?: number }>;
        inspectionStartAt: number;
        solveStartAt: number;
      }>;
      inspectionTimer?: NodeJS.Timeout;
      solveTimeout?: NodeJS.Timeout;
      solveStartedAt?: number;
      nextRoundTimer?: NodeJS.Timeout;
    }
  > = new Map();

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService,
    @Inject(forwardRef(() => MatchesService))
    private matchesService: MatchesService,
    @Optional()
    @Inject(forwardRef(() => SoloService))
    private soloService: SoloService,
  ) {}

  afterInit() {
    this.startMatchmakingLoop();
  }

  private startMatchmakingLoop() {
    if (this.matchmakingInterval) return;

    this.matchmakingInterval = setInterval(() => {
      this.processQueues();
    }, 1000); // Check every second
  }

  private async processQueues() {
    const socketsMap = this.server?.sockets as unknown as Map<string, Socket>;
    for (const size of PUZZLE_SIZES) {
      // 1. Pair two humans if we can.
      const match = this.matchmakingService.findMatch(size);
      if (match) {
        await this.createMatch(match[0], match[1], size);
        continue;
      }

      // 2. Ghost fallback: anyone who's waited past the human window gets a
      //    ghost (real, else synthetic seed) so there's always an opponent.
      if (!this.SERVER_GHOST_FALLBACK || !this.soloService) continue;
      const stale = this.matchmakingService.getStaleEntries(size, RANKED_HUMAN_WAIT_MS);
      for (const entry of stale) {
        const socket = socketsMap?.get(entry.socketId) as AuthenticatedSocket | undefined;
        // Take them out of the queue regardless; skip if the socket is gone/busy.
        this.matchmakingService.removeFromQueue(entry.userId);
        if (!socket || socket.matchId || socket.ghostRaceId || socket.soloSessionId) continue;
        await this.startGhostFallback(socket, entry, size);
      }
    }
  }

  async handleConnection(socket: AuthenticatedSocket) {
    try {
      // Extract JWT from query or auth header
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        socket.emit('error', { code: 'AUTH_REQUIRED', message: 'Authentication required' });
        socket.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      socket.userId = payload.sub;
      socket.username = payload.username;

      // Check if user has an active match and rejoin them
      await this.attachAndResyncMatch(socket);
    } catch (error) {
      socket.emit('error', { code: 'AUTH_INVALID', message: 'Invalid authentication' });
      socket.disconnect();
    }
  }

  /**
   * Attach this socket to the user's active match (if any) and send the full
   * match/round state. Used on every new connection and on explicit
   * `match_rejoin` requests (the match page re-attaching after navigation on
   * the app's shared socket).
   *
   * The resync frame must mirror what the live startRound/move path sends —
   * in particular it MUST carry solveId, because the client drops any
   * opponent_move whose solveId doesn't match its own. An older partial frame
   * here left rejoining players with solveId=null and a permanently frozen
   * opponent cube.
   */
  private async attachAndResyncMatch(
    socket: AuthenticatedSocket,
    opts: { takeover?: boolean } = {},
  ): Promise<boolean> {
    if (!socket.userId) return false;

    for (const [matchId, matchState] of this.activeMatches.entries()) {
      if (matchState.player1Id !== socket.userId && matchState.player2Id !== socket.userId) {
        continue;
      }

      const isPlayer1 = matchState.player1Id === socket.userId;

      if (!opts.takeover) {
        // A plain reconnect (new tab, second device, background tab waking
        // up) must NOT steal the match's event routing from a socket that is
        // already attached — only an explicit match_rejoin (the match page
        // mounting) takes over.
        if (this.findOtherAttachedSocket(matchId, socket.userId, socket.id)) {
          return false;
        }
        // A player who deliberately LEFT the match page stays detached on a
        // bare reconnect (e.g. a network blip while on the dashboard) so the
        // forfeit grace period keeps counting. Returning to the match page
        // (match_rejoin, takeover=true) re-attaches and clears the flag.
        if (isPlayer1 ? matchState.player1Left : matchState.player2Left) {
          return false;
        }
      }

      socket.matchId = matchId;
      socket.join(matchId);
      if (isPlayer1) {
        matchState.player1Left = undefined;
      } else {
        matchState.player2Left = undefined;
      }

      // Enforce at most one attached socket per player per match: event
      // routing follows the attachment, so clear any stale attachment held
      // by the user's other sockets and tell those tabs the match moved.
      const socketsMap = this.server?.sockets as unknown as Map<string, Socket>;
      if (socketsMap) {
        for (const [, other] of socketsMap) {
          const o = other as AuthenticatedSocket;
          if (o.userId === socket.userId && o.id !== socket.id && o.matchId === matchId) {
            o.matchId = undefined;
            other.leave(matchId);
            other.emit('match_detached', { matchId });
          }
        }
      }

      // Cancel abandon timeout for this player
      if (isPlayer1 && matchState.player1AbandonTimeout) {
        clearTimeout(matchState.player1AbandonTimeout);
        matchState.player1AbandonTimeout = undefined;
      } else if (!isPlayer1 && matchState.player2AbandonTimeout) {
        clearTimeout(matchState.player2AbandonTimeout);
        matchState.player2AbandonTimeout = undefined;
      }

      // Notify opponent that player is (back) in the match
      const opponentId = isPlayer1 ? matchState.player2Id : matchState.player1Id;
      const opponentSocket = this.findMatchSocket(opponentId, matchId);
      opponentSocket?.emit('opponent_reconnect', {});

      // Send current match state to the (re)joining user
      const match = await this.matchesService.getMatch(matchId);
      if (match) {
        const opponentUser = match.player1.id === opponentId ? match.player1 : match.player2;

        socket.emit('match_found', {
          matchId,
          opponent: {
            id: opponentId,
            username: opponentUser.username,
            mmr: opponentUser.mmr,
            league: opponentUser.league,
          },
          puzzleSize: match.puzzleSize,
          // Current score from this player's perspective so a mid-match
          // rejoin doesn't reset the displayed score to 0-0.
          scores: {
            you: isPlayer1 ? match.player1Score : match.player2Score,
            opponent: isPlayer1 ? match.player2Score : match.player1Score,
          },
        });

        // If there's an active round, resync the full round state.
        if (matchState.currentRound > 0 && match.solves?.length > 0) {
          const currentSolve = match.solves.find(s => s.roundNumber === matchState.currentRound);
          if (currentSolve) {
            const solveId: SolveId = `${matchId}:${matchState.currentRound}`;
            socket.emit('round_start', {
              round: matchState.currentRound,
              scramble: currentSolve.scramble,
              inspectionStartsAt: matchState.inspectionStartServerMs ?? Date.now(),
              inspectionStartServerMs: matchState.inspectionStartServerMs,
              inspectionEndServerMs: matchState.inspectionEndServerMs,
              solveId,
            });

            const mySolveStartServerMs = isPlayer1
              ? matchState.player1SolveStartServerMs
              : matchState.player2SolveStartServerMs;
            const opponentSolveStartServerMs = isPlayer1
              ? matchState.player2SolveStartServerMs
              : matchState.player1SolveStartServerMs;

            // Only flip the client into the solve phase if inspection has
            // actually ended — an unconditional inspection_end would cut a
            // rejoining player's inspection short. If inspection is still
            // running, the match's inspectionTimer will notify this socket
            // when it fires (it looks sockets up dynamically by userId).
            if (
              matchState.inspectionEndServerMs &&
              Date.now() >= matchState.inspectionEndServerMs
            ) {
              socket.emit('inspection_end', {
                solveStartsAt: matchState.inspectionEndServerMs,
                solveStartServerMs: matchState.inspectionEndServerMs,
                solveId,
              });
            }

            if (mySolveStartServerMs) {
              socket.emit('solve_start', {
                solveId,
                solveStartServerMs: mySolveStartServerMs,
                inspectionStartServerMs: matchState.inspectionStartServerMs,
                inspectionEndServerMs: matchState.inspectionEndServerMs,
              });
            }

            if (opponentSolveStartServerMs) {
              socket.emit('opponent_solve_start', {
                solveId,
                solveStartServerMs: opponentSolveStartServerMs,
                inspectionStartServerMs: matchState.inspectionStartServerMs,
                inspectionEndServerMs: matchState.inspectionEndServerMs,
              });
            }

            // Replay the opponent's moves made so far this round so their
            // cube isn't blank for the rejoining player. clientTs was
            // stored as solveStart + tMs, so invert it to recover tMs;
            // past-due moves apply immediately on the client, in order.
            const opponentMoves = (isPlayer1 ? currentSolve.p2Moves : currentSolve.p1Moves) || [];
            for (const m of opponentMoves) {
              socket.emit('opponent_move', {
                solveId,
                seq: m.seq,
                move: m.move,
                tMs: opponentSolveStartServerMs ? m.clientTs - opponentSolveStartServerMs : 0,
              });
            }

            // If the opponent already finished this round, send their time.
            const opponentStatus = isPlayer1 ? currentSolve.p2Status : currentSolve.p1Status;
            const opponentTimeMs = isPlayer1 ? currentSolve.p2TimeMs : currentSolve.p1TimeMs;
            if (opponentStatus === 'completed' && opponentTimeMs != null) {
              socket.emit('opponent_done', { timeMs: opponentTimeMs });
            }

            console.log(
              `[SYNC] Rejoin resync: ${solveId}, user=${socket.userId}, replayedOpponentMoves=${opponentMoves.length}`,
            );
          }
        }
      }
      return true;
    }
    return false;
  }

  handleDisconnect(socket: AuthenticatedSocket) {
    // Each page mounts its own socket, so navigation (e.g. /challenge → /match)
    // disconnects the old socket and connects a new one. If the new socket's
    // connection was processed first, this disconnect is for a STALE socket of
    // a user who is still here — skip the destructive cleanup (challenge
    // deletion and the match abandon timer, which would otherwise forfeit a
    // still-connected player 30s later with nothing left to cancel it).
    const hasOtherLiveSocket = socket.userId
      ? !!this.findOtherSocketByUserId(socket.userId, socket.id)
      : false;

    // Remove from queue and delete any pending challenges
    if (socket.userId) {
      this.matchmakingService.removeFromQueue(socket.userId);
      if (!hasOtherLiveSocket) {
        this.matchmakingService.deleteChallengeByCreator(socket.userId);
      }
    }

    // Handle ghost race disconnect - treat as abandon (forfeit)
    if (socket.ghostRaceId && socket.userId) {
      // Call abandon handler to properly record the loss
      this.handleGhostRaceAbandon(socket);
    }

    // Handle solo session disconnect - just abandon (no MMR impact)
    if (socket.soloSessionId && socket.userId && this.soloService) {
      this.handleSoloAbandon(socket);
    }

    // Handle match disconnect - notify opponent if they're still connected.
    // Only the socket ATTACHED to the match manages its lifecycle (a user's
    // other tabs carry no matchId and skip this naturally). If another live
    // socket of theirs is already attached — a takeover happened before this
    // disconnect was processed — that socket owns the match now.
    if (
      socket.matchId &&
      socket.userId &&
      !this.findOtherAttachedSocket(socket.matchId, socket.userId, socket.id)
    ) {
      const match = this.activeMatches.get(socket.matchId);
      if (match) {
        const isPlayer1 = socket.userId === match.player1Id;
        const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
        const opponentSocket = this.findMatchSocket(opponentId, socket.matchId);
        if (opponentSocket) {
          opponentSocket.emit('opponent_disconnect', {});
        }

        // Store the abandon timeout so it can be cancelled on reconnect
        const matchId = socket.matchId;
        const forfeitingUserId = socket.userId;
        const abandonTimeout = setTimeout(async () => {
          const currentMatch = this.activeMatches.get(matchId);
          if (currentMatch) {
            await this.handleForfeit(matchId, forfeitingUserId);
          }
        }, 30000); // 30 second grace period

        // Store timeout on the appropriate player
        if (isPlayer1) {
          match.player1AbandonTimeout = abandonTimeout;
        } else {
          match.player2AbandonTimeout = abandonTimeout;
        }
      }
    }
  }

  // ==========================================================================
  // NTP-LITE CLOCK SYNCHRONIZATION
  // ==========================================================================

  /**
   * NTP-lite ping handler for clock synchronization.
   * Client sends { clientSendPerfMs } and we respond immediately with server time.
   * Client uses this to calculate serverOffsetMs for deterministic replay.
   */
  @SubscribeMessage('clock_sync')
  handleClockSync(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { clientSendPerfMs: number },
  ) {
    // Respond immediately with server time
    socket.emit('clock_sync_response', {
      clientSendPerfMs: data.clientSendPerfMs,
      serverNowMs: Date.now(),
    });
  }

  @SubscribeMessage('queue_join')
  async handleQueueJoin(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { puzzleSize: PuzzleSize },
  ) {
    if (!socket.userId) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
      return;
    }

    if (!PUZZLE_SIZES.includes(data.puzzleSize)) {
      socket.emit('error', { code: 'INVALID_PUZZLE', message: 'Invalid puzzle size' });
      return;
    }

    // Check if already in a match
    if (socket.matchId) {
      socket.emit('error', { code: 'IN_MATCH', message: 'Already in a match' });
      return;
    }

    try {
      const { position } = await this.matchmakingService.addToQueue(
        socket.userId,
        socket.id,
        data.puzzleSize,
      );

      socket.emit('queue_joined', {
        position,
        estimatedWait: this.matchmakingService.getEstimatedWait(data.puzzleSize),
      });
    } catch (error) {
      socket.emit('error', { code: 'QUEUE_ERROR', message: 'Failed to join queue' });
    }
  }

  @SubscribeMessage('queue_leave')
  handleQueueLeave(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (socket.userId) {
      this.matchmakingService.removeFromQueue(socket.userId);
      socket.emit('queue_left', {});
    }
  }

  /**
   * The match page attaches itself to any live match on mount. With the
   * client's shared socket, returning to /match is no longer a fresh
   * connection, so this replaces the connection-time rejoin in that flow.
   */
  @SubscribeMessage('match_rejoin')
  async handleMatchRejoin(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.userId) return;
    // Already attached — either the live match flow set matchId on this
    // socket, or the connection handler just resynced it (page reload). Skip
    // so a mount-time rejoin can't duplicate the resync frame.
    if (socket.matchId && this.activeMatches.has(socket.matchId)) return;
    // Explicit rejoin from the match page: take over event routing even if
    // one of the user's other sockets (another tab) is currently attached.
    await this.attachAndResyncMatch(socket, { takeover: true });
  }

  /**
   * The match page detaches when it unmounts mid-match (user navigated away).
   * Mirrors the disconnect path: notify the opponent and start the abandon
   * grace period — cancelled if the player returns (match_rejoin) before it
   * fires, otherwise the match is forfeited.
   */
  @SubscribeMessage('match_leave')
  handleMatchLeave(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.matchId || !socket.userId) return;

    const matchId = socket.matchId;
    const match = this.activeMatches.get(matchId);

    // Detach the socket from the match regardless of state.
    socket.leave(matchId);
    socket.matchId = undefined;
    socket.playerNumber = undefined;

    if (!match) return;

    const isPlayer1 = socket.userId === match.player1Id;
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    this.findMatchSocket(opponentId, matchId)?.emit('opponent_disconnect', {});

    const forfeitingUserId = socket.userId;
    const abandonTimeout = setTimeout(async () => {
      if (this.activeMatches.get(matchId)) {
        await this.handleForfeit(matchId, forfeitingUserId);
      }
    }, 30000); // Same 30 second grace period as a disconnect

    if (isPlayer1) {
      if (match.player1AbandonTimeout) clearTimeout(match.player1AbandonTimeout);
      match.player1AbandonTimeout = abandonTimeout;
      match.player1Left = true;
    } else {
      if (match.player2AbandonTimeout) clearTimeout(match.player2AbandonTimeout);
      match.player2AbandonTimeout = abandonTimeout;
      match.player2Left = true;
    }
  }

  @SubscribeMessage('ready')
  async handleReady(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.matchId || !socket.userId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;

    const isPlayer1 = socket.userId === match.player1Id;
    if (isPlayer1) {
      match.player1Ready = true;
    } else {
      match.player2Ready = true;
    }

    // Notify opponent
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findMatchSocket(opponentId, socket.matchId);
    opponentSocket?.emit('opponent_ready', {});

    // If both ready, start next round
    if (match.player1Ready && match.player2Ready) {
      await this.startRound(socket.matchId);
    }
  }

  @SubscribeMessage('move')
  async handleMove(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { seq: number; move: string; tMs: number },
  ) {
    if (!socket.matchId || !socket.userId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;
    const serverTs = Date.now();

    const isPlayer1 = socket.userId === match.player1Id;
    const isRotation = this.ROTATION_MOVES.includes(data.move);

    // Check if this is the first non-rotation move (starts the solve)
    const playerSolveStartServerMs = isPlayer1 ? match.player1SolveStartServerMs : match.player2SolveStartServerMs;
    let solveJustStarted = false;
    let solveStartServerMs = playerSolveStartServerMs;

    if (!isRotation && !playerSolveStartServerMs) {
      // This is the first non-rotation move - player started solving
      // SERVER decides the authoritative solve start time
      solveStartServerMs = serverTs;

      const matchIdForTimeout = socket.matchId;
      const userIdForTimeout = socket.userId;
      if (isPlayer1) {
        match.player1SolveStartedAt = serverTs;
        match.player1SolveStartServerMs = serverTs;
        match.player1SolveTimeout = setTimeout(
          () => this.handleSolveTimeout(matchIdForTimeout, userIdForTimeout),
          this.SOLVE_TIMEOUT_MS,
        );
      } else {
        match.player2SolveStartedAt = serverTs;
        match.player2SolveStartServerMs = serverTs;
        match.player2SolveTimeout = setTimeout(
          () => this.handleSolveTimeout(matchIdForTimeout, userIdForTimeout),
          this.SOLVE_TIMEOUT_MS,
        );
      }
      solveJustStarted = true;
    }

    // Generate solveId for this solve
    const solveId: SolveId = `${socket.matchId}:${match.currentRound}`;

    // Record move in database (convert tMs to clientTs for backward
    // compatibility) WITHOUT blocking the relay — a database round-trip per
    // move (RDS in production) must not sit in the opponent's latency path.
    // recordMove's per-(match,round,player) lock keeps writes ordered, and
    // this handler's synchronous section keeps the relays ordered.
    const clientTs = solveStartServerMs ? solveStartServerMs + data.tMs : serverTs;
    this.matchesService
      .recordMove(socket.matchId, match.currentRound, socket.userId, {
        seq: data.seq,
        move: data.move,
        clientTs,
        serverTs,
      })
      .catch((e) => console.error('recordMove failed:', e));

    // Relay to opponent with relative timestamp for deterministic replay.
    // Route to the socket attached to this match — the opponent may have
    // other tabs/devices connected that must not swallow the moves.
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findMatchSocket(opponentId, socket.matchId);

    // If solve just started, emit solve_start event to BOTH players
    if (solveJustStarted) {
      const solveStartData = {
        solveId,
        solveStartServerMs,
        inspectionStartServerMs: match.inspectionStartServerMs,
        inspectionEndServerMs: match.inspectionEndServerMs,
      };

      // Send to the solver (so they have the authoritative start time)
      socket.emit('solve_start', solveStartData);

      // Send to opponent
      if (opponentSocket) {
        opponentSocket.emit('opponent_solve_start', solveStartData);
      }

      // Log solve start (temporary debugging)
      console.log(`[SYNC] Solve started: ${solveId}, solveStartServerMs=${solveStartServerMs}`);
    }

    // Relay move to opponent with tMs for deterministic replay
    opponentSocket?.emit('opponent_move', {
      solveId,
      seq: data.seq,
      move: data.move,
      tMs: data.tMs, // Relative timestamp from solve start
    });
  }

  @SubscribeMessage('solve_complete')
  async handleSolveComplete(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { timeMs: number | null },
  ) {
    if (!socket.matchId || !socket.userId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;

    // Clear solve timeout for this player
    const isPlayer1 = socket.userId === match.player1Id;
    if (isPlayer1 && match.player1SolveTimeout) {
      clearTimeout(match.player1SolveTimeout);
      match.player1SolveTimeout = undefined;
    } else if (!isPlayer1 && match.player2SolveTimeout) {
      clearTimeout(match.player2SolveTimeout);
      match.player2SolveTimeout = undefined;
    }

    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findMatchSocket(opponentId, socket.matchId);

    // A null time means the cube was NOT solved when the timer stopped — that
    // is a DNF, not a completed solve. (Previously the server "helpfully"
    // computed a time and marked it completed, so stopping on an unsolved
    // cube could win rounds.)
    if (data?.timeMs == null) {
      const result = await this.matchesService.recordDNF(
        socket.matchId,
        match.currentRound,
        socket.userId,
      );
      if (!result) return;

      socket.emit('my_solve_time', { timeMs: null });
      opponentSocket?.emit('opponent_done', { timeMs: null });

      if (result.roundComplete) {
        await this.handleRoundComplete(socket.matchId, match, result);
      }
      return;
    }

    // Validate the client-reported time against the server-observed solve
    // window (solve start is server-authoritative, stamped at the first
    // non-rotation move). A client can't be meaningfully FASTER than the
    // server's own observation — clamp gross spoofs; leave slower times
    // alone (network delay only ever inflates the server window).
    let timeMs = data.timeMs;
    const solveStartServerMs = isPlayer1
      ? match.player1SolveStartServerMs
      : match.player2SolveStartServerMs;
    if (solveStartServerMs) {
      const serverElapsedMs = Date.now() - solveStartServerMs;
      if (timeMs < serverElapsedMs - 5000) {
        console.warn(
          `[ANTICHEAT] ${socket.userId} reported ${timeMs}ms but the server observed ~${serverElapsedMs}ms — clamping`,
        );
        timeMs = serverElapsedMs;
      }
    }

    const result = await this.matchesService.recordSolveComplete(
      socket.matchId,
      match.currentRound,
      socket.userId,
      timeMs,
    );

    if (!result) return;

    // Send the SAME time to BOTH players
    socket.emit('my_solve_time', { timeMs: result.timeMs });

    // Notify opponent of completion with the SAME time
    opponentSocket?.emit('opponent_done', { timeMs: result.timeMs });

    // Check if round is complete
    if (result.roundComplete) {
      await this.handleRoundComplete(socket.matchId, match, result);
    }
  }

  @SubscribeMessage('rematch')
  async handleRematch(@ConnectedSocket() socket: AuthenticatedSocket) {
    // For MVP, just requeue both players
    if (socket.matchId) {
      const match = this.activeMatches.get(socket.matchId);
      if (match) {
        // Clean up old match
        this.activeMatches.delete(socket.matchId);

        // Get puzzle size from the old match
        const oldMatch = await this.matchesService.getMatch(socket.matchId);
        if (oldMatch) {
          // Re-queue the player
          socket.matchId = undefined;
          socket.playerNumber = undefined;

          await this.handleQueueJoin(socket, { puzzleSize: oldMatch.puzzleSize });
        }
      }
    }
  }

  @SubscribeMessage('requeue')
  async handleRequeue(@ConnectedSocket() socket: AuthenticatedSocket) {
    return this.handleRematch(socket);
  }

  @SubscribeMessage('challenge_create')
  async handleChallengeCreate(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { puzzleSize: PuzzleSize },
  ) {
    if (!socket.userId) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
      return;
    }

    if (socket.matchId) {
      socket.emit('error', { code: 'IN_MATCH', message: 'Already in a match' });
      return;
    }

    try {
      const challenge = await this.matchmakingService.createChallenge(
        socket.userId,
        socket.id,
        data.puzzleSize,
      );

      socket.emit('challenge_created', {
        code: challenge.code,
        puzzleSize: challenge.puzzleSize,
      });

          } catch (error) {
      socket.emit('error', { code: 'CHALLENGE_ERROR', message: 'Failed to create challenge' });
    }
  }

  @SubscribeMessage('challenge_cancel')
  handleChallengeCancel(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (socket.userId) {
      this.matchmakingService.deleteChallengeByCreator(socket.userId);
      socket.emit('challenge_cancelled', {});
    }
  }

  @SubscribeMessage('challenge_join')
  async handleChallengeJoin(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { code: string },
  ) {
    if (!socket.userId) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
      return;
    }

    if (socket.matchId) {
      socket.emit('error', { code: 'IN_MATCH', message: 'Already in a match' });
      return;
    }

    const challenge = this.matchmakingService.getChallenge(data.code);
    if (!challenge) {
      socket.emit('error', { code: 'CHALLENGE_NOT_FOUND', message: 'Challenge not found or expired' });
      return;
    }

    if (challenge.creatorId === socket.userId) {
      socket.emit('error', { code: 'CANNOT_JOIN_OWN', message: 'Cannot join your own challenge' });
      return;
    }

    // Resolve the creator's socket: prefer the exact socket that created the
    // challenge (the tab sitting on the challenge page) — the creator may
    // have OTHER live sockets (background tabs, another device) that must not
    // receive the match. Fall back to their newest socket if the creating
    // socket reconnected while waiting.
    const socketsMapForCreator = this.server?.sockets as unknown as Map<string, Socket>;
    const creatorSocket = (socketsMapForCreator?.get(challenge.creatorSocketId) ??
      this.findSocketByUserId(challenge.creatorId)) as AuthenticatedSocket | undefined;
    if (!creatorSocket) {
      this.matchmakingService.deleteChallenge(data.code);
      socket.emit('error', {
        code: 'CHALLENGE_NOT_FOUND',
        message: 'Challenge creator is no longer online',
      });
      return;
    }
    if (creatorSocket.matchId) {
      socket.emit('error', {
        code: 'CHALLENGE_NOT_FOUND',
        message: 'Challenge creator is currently in another match',
      });
      return;
    }

    // Get joiner's info
    const joinerStats = await this.matchmakingService.addToQueue(
      socket.userId,
      socket.id,
      challenge.puzzleSize,
    );

    // Remove from queue immediately (we're creating a direct match)
    this.matchmakingService.removeFromQueue(socket.userId);

    // Delete the challenge
    this.matchmakingService.deleteChallenge(data.code);

    // Create the match
    const creatorEntry: QueueEntry = {
      userId: challenge.creatorId,
      socketId: creatorSocket.id,
      puzzleSize: challenge.puzzleSize,
      mmr: challenge.creatorMmr,
      searchRange: 0,
      joinedAt: challenge.createdAt,
      username: challenge.creatorUsername,
      league: challenge.creatorLeague,
      // Extended opponent info
      country: challenge.creatorCountry,
      gamesPlayed: challenge.creatorGamesPlayed,
      gamesWon: challenge.creatorGamesWon,
    };

    await this.createMatch(creatorEntry, joinerStats.entry, challenge.puzzleSize);
  }

  // ==========================================================================
  // SOLO MODE HANDLERS
  // ==========================================================================

  @SubscribeMessage('solo_start')
  async handleSoloStart(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { puzzleSize: PuzzleSize },
  ) {
    if (!socket.userId) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
      return;
    }

    if (socket.matchId || socket.soloSessionId) {
      socket.emit('error', { code: 'IN_MATCH', message: 'Already in a match or solo session' });
      return;
    }

    if (!this.soloService) {
      socket.emit('error', { code: 'SOLO_NOT_AVAILABLE', message: 'Solo mode is not available' });
      return;
    }

    try {
      const session = await this.soloService.createSession(socket.userId, data.puzzleSize);
      socket.soloSessionId = session.id;

      this.activeSoloSessions.set(session.id, {
        userId: socket.userId,
        currentRound: 0,
        totalRounds: session.totalRounds,
      });

      socket.emit('solo_started', {
        sessionId: session.id,
        puzzleSize: session.puzzleSize,
        totalRounds: session.totalRounds,
      });

      // Start first round after a short delay
      setTimeout(() => this.startSoloRound(session.id), 2000);

          } catch (error) {
      socket.emit('error', { code: 'SOLO_ERROR', message: 'Failed to start solo session' });
    }
  }

  @SubscribeMessage('solo_move')
  async handleSoloMove(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { seq: number; move: string; clientTs: number },
  ) {
    if (!socket.soloSessionId || !socket.userId || !this.soloService) return;

    const session = this.activeSoloSessions.get(socket.soloSessionId);
    if (!session) return;

    const serverTs = Date.now();
    const isRotation = this.ROTATION_MOVES.includes(data.move);

    // Check if this is the first non-rotation move
    if (!isRotation && !session.solveStartedAt) {
      session.solveStartedAt = serverTs;
      // Set 10-minute timeout
      const sessionId = socket.soloSessionId;
      session.solveTimeout = setTimeout(
        () => this.handleSoloSolveTimeout(sessionId),
        this.SOLVE_TIMEOUT_MS,
      );
    }

    await this.soloService.recordMove(
      socket.soloSessionId,
      session.currentRound,
      { seq: data.seq, move: data.move, clientTs: data.clientTs, serverTs },
    );
  }

  @SubscribeMessage('solo_complete')
  async handleSoloComplete(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data?: { moves?: Array<{ seq: number; move: string; tMs: number }>; isDnf?: boolean; timeMs?: number },
  ) {
    if (!socket.soloSessionId || !socket.userId || !this.soloService) return;

    const session = this.activeSoloSessions.get(socket.soloSessionId);
    if (!session) return;

    // Clear solve timeout
    if (session.solveTimeout) {
      clearTimeout(session.solveTimeout);
      session.solveTimeout = undefined;
    }

    // Clear the round's inspection timer: the user can complete a solve while
    // inspection is still pending (early start + fast solve), and the orphaned
    // timer would fire a bogus inspection_end into the results screen or the
    // NEXT round — flipping the client into "solving" with a running timer
    // and, on the results screen, the just-solved cube still displayed.
    if (session.inspectionTimer) {
      clearTimeout(session.inspectionTimer);
      session.inspectionTimer = undefined;
    }

    // Sort moves by timestamp to ensure correct order
    // Store tMs (relative timestamp) for replay timing
    const moves = data?.moves
      ? [...data.moves].sort((a, b) => a.tMs - b.tMs).map(m => ({
          seq: m.seq,
          move: m.move,
          clientTs: session.solveStartedAt ? session.solveStartedAt + m.tMs : m.tMs,
          serverTs: Date.now(),
          tMs: m.tMs, // Keep relative timestamp for ghost replay
        }))
      : [];

    // Validate the client-reported time against the server-observed solve
    // window — these times feed the ghost MMR economy, so gross spoofs are
    // clamped to what the server actually saw.
    let clientTimeMs = data?.timeMs;
    if (clientTimeMs != null && session.solveStartedAt) {
      const serverElapsedMs = Date.now() - session.solveStartedAt;
      if (clientTimeMs < serverElapsedMs - 5000) {
        console.warn(
          `[ANTICHEAT] solo ${socket.userId} reported ${clientTimeMs}ms but the server observed ~${serverElapsedMs}ms — clamping`,
        );
        clientTimeMs = serverElapsedMs;
      }
    }

    const result = await this.soloService.recordSolveComplete(
      socket.soloSessionId,
      session.currentRound,
      data?.isDnf ?? false,
      moves,
      clientTimeMs,
    );

    if (!result) return;

    socket.emit('solo_solve_result', {
      round: session.currentRound,
      timeMs: result.timeMs,
      completedRounds: session.currentRound,
      totalRounds: session.totalRounds,
    });

    if (result.isSessionComplete) {
      await this.handleSoloSessionComplete(socket.soloSessionId);
    } else {
      // Start next round after delay
      const sessionId = socket.soloSessionId;
      setTimeout(() => this.startSoloRound(sessionId), 3000);
    }
  }

  @SubscribeMessage('solo_abandon')
  async handleSoloAbandon(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.soloSessionId || !this.soloService) return;

    const session = this.activeSoloSessions.get(socket.soloSessionId);
    if (session) {
      if (session.inspectionTimer) clearTimeout(session.inspectionTimer);
      if (session.solveTimeout) clearTimeout(session.solveTimeout);
    }

    await this.soloService.abandonSession(socket.soloSessionId);
    this.activeSoloSessions.delete(socket.soloSessionId);
    socket.soloSessionId = undefined;

    socket.emit('solo_abandoned', {});
  }

  private async startSoloRound(sessionId: string) {
    const session = this.activeSoloSessions.get(sessionId);
    if (!session || !this.soloService) return;

    session.currentRound += 1;
    session.solveStartedAt = undefined;

    // Clear any existing timeout
    if (session.solveTimeout) {
      clearTimeout(session.solveTimeout);
      session.solveTimeout = undefined;
    }
    // Never leave the previous round's inspection timer armed — overwriting
    // the reference below would orphan it and it would fire a bogus
    // inspection_end into this round.
    if (session.inspectionTimer) {
      clearTimeout(session.inspectionTimer);
      session.inspectionTimer = undefined;
    }

    const solve = await this.soloService.startRound(sessionId, session.currentRound);
    const inspectionStartsAt = Date.now() + 500;

    // Find the socket for this session
    const socket = this.findSocketBySoloSession(sessionId);
    if (!socket) return;

    socket.emit('solo_round_start', {
      round: session.currentRound,
      totalRounds: session.totalRounds,
      scramble: solve.scramble,
      inspectionStartsAt,
    });

    // Set inspection end timer
    session.inspectionTimer = setTimeout(
      () => this.handleSoloInspectionEnd(sessionId),
      INSPECTION_DURATION_MS + 500,
    );
  }

  private handleSoloInspectionEnd(sessionId: string) {
    const session = this.activeSoloSessions.get(sessionId);
    if (!session) return;

    const socket = this.findSocketBySoloSession(sessionId);
    if (!socket) return;

    socket.emit('solo_inspection_end', { solveStartsAt: Date.now() });
  }

  private async handleSoloSolveTimeout(sessionId: string) {
    const session = this.activeSoloSessions.get(sessionId);
    if (!session || !this.soloService) return;

    session.solveTimeout = undefined;

    // Record DNF for timeout (no moves to record)
    const result = await this.soloService.recordSolveComplete(
      sessionId,
      session.currentRound,
      true, // isDnf
      [], // No moves for DNF timeout
    );
    if (!result) return;

    const socket = this.findSocketBySoloSession(sessionId);
    if (!socket) return;

    socket.emit('solo_dnf', { reason: 'timeout' });
    socket.emit('solo_solve_result', {
      round: session.currentRound,
      timeMs: null,
      completedRounds: session.currentRound,
      totalRounds: session.totalRounds,
    });

    if (result.isSessionComplete) {
      await this.handleSoloSessionComplete(sessionId);
    } else {
      setTimeout(() => this.startSoloRound(sessionId), 3000);
    }
  }

  private async handleSoloSessionComplete(sessionId: string) {
    const session = this.activeSoloSessions.get(sessionId);
    if (!session || !this.soloService) return;

    // Clear timers
    if (session.inspectionTimer) clearTimeout(session.inspectionTimer);
    if (session.solveTimeout) clearTimeout(session.solveTimeout);

    const result = await this.soloService.completeSession(sessionId);

    const socket = this.findSocketBySoloSession(sessionId);
    if (socket) {
      socket.emit('solo_end', {
        solves: result.solves,
        averageTime: result.averageTime,
      });
      (socket as AuthenticatedSocket).soloSessionId = undefined;
    }

    this.activeSoloSessions.delete(sessionId);
  }

  private findSocketBySoloSession(sessionId: string): Socket | undefined {
    if (!this.server) return undefined;

    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    for (const [, socket] of socketsMap) {
      if ((socket as AuthenticatedSocket).soloSessionId === sessionId) {
        return socket;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // GHOST RACE HANDLERS
  // ==========================================================================

  @SubscribeMessage('ghost_race_start')
  async handleGhostRaceStart(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { puzzleSize: PuzzleSize; opponentId?: string },
  ) {
    if (!socket.userId) {
      socket.emit('error', { code: 'NOT_AUTHENTICATED', message: 'Not authenticated' });
      return;
    }

    if (socket.matchId || socket.soloSessionId || socket.ghostRaceId) {
      socket.emit('error', { code: 'IN_MATCH', message: 'Already in a match or session' });
      return;
    }

    if (!this.soloService) {
      socket.emit('error', { code: 'GHOST_NOT_AVAILABLE', message: 'Ghost mode is not available' });
      return;
    }

    try {
      // Find a ghost to race against (from specific user if opponentId provided)
      let ghostData: any = data.opponentId
        ? await this.soloService.findGhostFromUser(socket.userId, data.opponentId, data.puzzleSize)
        : await this.soloService.findGhostToRace(socket.userId, data.puzzleSize);

      // General ranked ghost requests ALWAYS get an opponent: fall back to a
      // synthetic seed when no real ghost is available. (A request targeting a
      // specific player's ghost still errors if they have none.)
      if (!ghostData && !data.opponentId) {
        ghostData = await this.soloService.buildSeedGhostForUser(socket.userId, data.puzzleSize);
      }

      if (!ghostData) {
        const message = data.opponentId
          ? 'No available ghosts from this player. You may have already raced all their ghosts!'
          : 'No ghost opponents available. Try creating some ghost solves first!';
        socket.emit('error', { code: 'NO_GHOSTS', message });
        return;
      }

      this.beginGhostRace(socket, data.puzzleSize, ghostData);
          } catch (error) {
      console.error('Ghost race start error:', error);
      socket.emit('error', { code: 'GHOST_ERROR', message: 'Failed to start ghost race' });
    }
  }

  @SubscribeMessage('ghost_race_move')
  async handleGhostRaceMove(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data: { seq: number; move: string; clientTs: number },
  ) {
    if (!socket.ghostRaceId || !socket.userId) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) return;

    const isRotation = this.ROTATION_MOVES.includes(data.move);

    // Check if this is the first non-rotation move
    if (!isRotation && !race.solveStartedAt) {
      race.solveStartedAt = Date.now();
      // Set 10-minute timeout
      const raceId = socket.ghostRaceId;
      race.solveTimeout = setTimeout(
        () => this.handleGhostRaceSolveTimeout(raceId),
        this.SOLVE_TIMEOUT_MS,
      );
    }
  }

  @SubscribeMessage('ghost_race_complete')
  async handleGhostRaceComplete(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() data?: { isDnf?: boolean },
  ) {
    if (!socket.ghostRaceId || !socket.userId || !this.soloService) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) return;

    // Clear solve timeout
    if (race.solveTimeout) {
      clearTimeout(race.solveTimeout);
      race.solveTimeout = undefined;
    }

    // Clear the round's inspection timer — completing during inspection would
    // otherwise leave it armed to fire a bogus inspection_end into the results
    // screen or the next round (phantom running timer on a solved cube).
    if (race.inspectionTimer) {
      clearTimeout(race.inspectionTimer);
      race.inspectionTimer = undefined;
    }

    // Calculate user's time (server-observed). Stopping on an UNSOLVED cube
    // is a DNF — otherwise instantly stopping the timer would beat the ghost.
    const userTime =
      data?.isDnf || !race.solveStartedAt ? null : Date.now() - race.solveStartedAt;
    race.userTimes.push(userTime);

    const ghostTime = race.ghostTimes[race.currentRound - 1];
    const userWonRound = userTime !== null && (ghostTime === null || userTime < ghostTime);

    socket.emit('ghost_race_solve_result', {
      round: race.currentRound,
      userTime,
      ghostTime,
      userWonRound,
      completedRounds: race.currentRound,
      totalRounds: race.totalRounds,
    });

    if (race.currentRound >= race.totalRounds) {
      await this.finishGhostRace(socket.ghostRaceId);
    }
    // Don't auto-start next round - wait for client to request it
    // (after ghost replay finishes or user skips)
  }

  @SubscribeMessage('ghost_race_skip')
  async handleGhostRaceSkip(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.ghostRaceId || !socket.userId) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) return;

    // Clear any pending timer
    if (race.nextRoundTimer) {
      clearTimeout(race.nextRoundTimer);
      race.nextRoundTimer = undefined;
    }

    // Start next round if not finished
    if (race.currentRound < race.totalRounds) {
      this.startGhostRaceRound(socket.ghostRaceId);
    }
  }

  @SubscribeMessage('ghost_race_abandon')
  async handleGhostRaceAbandon(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.ghostRaceId || !this.soloService) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) {
      socket.ghostRaceId = undefined;
      socket.emit('ghost_race_abandoned', {});
      return;
    }

    // Clear timers
    if (race.inspectionTimer) clearTimeout(race.inspectionTimer);
    if (race.solveTimeout) clearTimeout(race.solveTimeout);
    if (race.nextRoundTimer) clearTimeout(race.nextRoundTimer);

    // DNF all remaining rounds (user loses them all)
    const completedRounds = race.userTimes.length;
    for (let i = completedRounds; i < race.totalRounds; i++) {
      race.userTimes.push(null); // DNF for each remaining round
    }

    // Calculate result as a loss (ghost wins all DNF'd rounds)
    const result = await this.soloService.calculateGhostRaceResult(
      race.oderId,
      race.puzzleSize,
      race.userTimes,
      race.ghostTimes,
      race.ghostMmrAtRecording,
      race.ghostUserId,
      race.isOldGhost,
    );

    // Save the ghost race to database (prevents replaying this ghost).
    // Skip synthetic seed ghosts — they have no real session/owner to reference.
    if (!race.isSeed) await this.soloService.saveGhostRace({
      racerId: race.oderId,
      ghostSessionId: race.ghostSessionId,
      ghostUserId: race.ghostUserId,
      puzzleSize: race.puzzleSize,
      racerScore: result.userWins,
      ghostScore: result.ghostWins,
      racerWon: result.userWon,
      racerMmrBefore: result.mmrBefore,
      racerMmrAfter: result.newMmr,
      racerLeagueAfter: result.newLeague as any,
      ghostMmrAtRecording: race.ghostMmrAtRecording,
      isOldGhost: race.isOldGhost,
      racerTimes: race.userTimes,
      ghostTimes: race.ghostTimes,
    });

    this.activeGhostRaces.delete(socket.ghostRaceId);
    socket.ghostRaceId = undefined;

    // Send the result to the user so they see the MMR change
    socket.emit('ghost_race_end', {
      userWins: result.userWins,
      ghostWins: result.ghostWins,
      userWon: result.userWon,
      mmrDelta: result.mmrDelta,
      newMmr: result.newMmr,
      newLeague: result.newLeague,
      ghostUsername: race.ghostUsername,
      isOldGhost: race.isOldGhost,
      abandoned: true,
    });
  }

  // Set up and kick off a ghost race for a socket. Used both by the explicit
  // ghost_race_start handler and by the ranked matchmaker's ghost fallback.
  private beginGhostRace(
    socket: AuthenticatedSocket,
    puzzleSize: PuzzleSize,
    ghostData: {
      ghostSession: {
        id: string;
        mmrAtRecording?: number;
        solves?: Array<{
          roundNumber: number;
          scramble: string;
          timeMs: number | null;
          moves?: any[];
          inspectionStartAt?: Date;
          solveStartAt?: Date;
        }>;
      };
      ghostUser: { id: string; username: string; country: string | null; gamesPlayed: number; gamesWon: number };
      isOldGhost: boolean;
      isSeed?: boolean;
    },
  ) {
    if (!socket.userId) return;
    const { ghostSession, ghostUser, isOldGhost } = ghostData;

    const raceId = `race_${Date.now()}_${socket.userId}`;
    socket.ghostRaceId = raceId;

    const ghostSolves = (ghostSession.solves || [])
      .slice()
      .sort((a, b) => a.roundNumber - b.roundNumber)
      .map((s) => ({
        scramble: s.scramble,
        timeMs: s.timeMs,
        moves: s.moves || [],
        inspectionStartAt: s.inspectionStartAt?.getTime() || 0,
        solveStartAt: s.solveStartAt?.getTime() || 0,
      }));

    this.activeGhostRaces.set(raceId, {
      oderId: socket.userId,
      puzzleSize,
      ghostSessionId: ghostSession.id,
      ghostUserId: ghostUser.id,
      ghostUsername: ghostUser.username,
      ghostMmrAtRecording: ghostSession.mmrAtRecording || 1000,
      isOldGhost,
      isSeed: ghostData.isSeed,
      currentRound: 0,
      totalRounds: ghostSolves.length,
      userTimes: [],
      ghostTimes: ghostSolves.map((s) => s.timeMs),
      ghostSolves,
    });

    socket.emit('ghost_race_started', {
      raceId,
      puzzleSize,
      totalRounds: ghostSolves.length,
      ghostUsername: ghostUser.username,
      ghostMmr: ghostSession.mmrAtRecording || 1000,
      isOldGhost,
      isSeed: !!ghostData.isSeed,
      ghostCountry: ghostUser.country,
      ghostGamesPlayed: ghostUser.gamesPlayed,
      ghostGamesWon: ghostUser.gamesWon,
    });

    setTimeout(() => this.startGhostRaceRound(raceId), 2000);
  }

  // Ranked ghost fallback: prefer a real ghost near the player's MMR, else a
  // synthetic seed so there is always an opponent.
  private async startGhostFallback(socket: AuthenticatedSocket, entry: QueueEntry, size: PuzzleSize) {
    if (!this.soloService || !socket.userId) return;
    try {
      let ghostData:
        | {
            ghostSession: any;
            ghostUser: { id: string; username: string; country: string | null; gamesPlayed: number; gamesWon: number };
            isOldGhost: boolean;
            isSeed?: boolean;
          }
        | null = await this.soloService.findGhostToRace(entry.userId, size);
      if (!ghostData) {
        ghostData = this.soloService.buildSeedGhost(size, entry.mmr);
      }
      this.beginGhostRace(socket, size, ghostData);
    } catch (e) {
      console.error('Ghost fallback error:', e);
      socket.emit('error', { code: 'QUEUE_ERROR', message: 'Failed to start race' });
    }
  }

  private async startGhostRaceRound(raceId: string) {
    const race = this.activeGhostRaces.get(raceId);
    if (!race || !this.soloService) return;

    race.currentRound += 1;
    race.solveStartedAt = undefined;

    // Clear any existing timeout
    if (race.solveTimeout) {
      clearTimeout(race.solveTimeout);
      race.solveTimeout = undefined;
    }
    // Never leave the previous round's inspection timer armed — overwriting
    // the reference below would orphan it and it would fire a bogus
    // inspection_end into this round.
    if (race.inspectionTimer) {
      clearTimeout(race.inspectionTimer);
      race.inspectionTimer = undefined;
    }

    const ghostSolve = race.ghostSolves[race.currentRound - 1];
    if (!ghostSolve) return;

    const inspectionStartsAt = Date.now() + 500;

    // Find the socket for this race
    const socket = this.findSocketByGhostRace(raceId);
    if (!socket) return;

    socket.emit('ghost_race_round_start', {
      round: race.currentRound,
      totalRounds: race.totalRounds,
      scramble: ghostSolve.scramble,
      inspectionStartsAt,
      ghostMoves: ghostSolve.moves, // Send ghost moves for replay
      ghostTime: ghostSolve.timeMs,
      ghostInspectionStartAt: ghostSolve.inspectionStartAt, // Original inspection start for timing
      ghostSolveStartAt: ghostSolve.solveStartAt, // When ghost started solving
    });

    // Set inspection end timer
    race.inspectionTimer = setTimeout(
      () => this.handleGhostRaceInspectionEnd(raceId),
      INSPECTION_DURATION_MS + 500,
    );
  }

  private handleGhostRaceInspectionEnd(raceId: string) {
    const race = this.activeGhostRaces.get(raceId);
    if (!race) return;

    const socket = this.findSocketByGhostRace(raceId);
    if (!socket) return;

    socket.emit('ghost_race_inspection_end', { solveStartsAt: Date.now() });
  }

  private async handleGhostRaceSolveTimeout(raceId: string) {
    const race = this.activeGhostRaces.get(raceId);
    if (!race || !this.soloService) return;

    race.solveTimeout = undefined;
    race.userTimes.push(null); // DNF

    const ghostTime = race.ghostTimes[race.currentRound - 1];

    const socket = this.findSocketByGhostRace(raceId);
    if (!socket) return;

    socket.emit('ghost_race_dnf', { reason: 'timeout' });
    socket.emit('ghost_race_solve_result', {
      round: race.currentRound,
      userTime: null,
      ghostTime,
      userWonRound: false,
      completedRounds: race.currentRound,
      totalRounds: race.totalRounds,
    });

    if (race.currentRound >= race.totalRounds) {
      await this.finishGhostRace(raceId);
    } else {
      race.nextRoundTimer = setTimeout(() => this.startGhostRaceRound(raceId), 3000);
    }
  }

  private async finishGhostRace(raceId: string) {
    const race = this.activeGhostRaces.get(raceId);
    if (!race || !this.soloService) return;

    // Clear timers
    if (race.inspectionTimer) clearTimeout(race.inspectionTimer);
    if (race.nextRoundTimer) clearTimeout(race.nextRoundTimer);
    if (race.solveTimeout) clearTimeout(race.solveTimeout);

    const result = await this.soloService.calculateGhostRaceResult(
      race.oderId,
      race.puzzleSize,
      race.userTimes,
      race.ghostTimes,
      race.ghostMmrAtRecording,
      race.ghostUserId,
      race.isOldGhost,
    );

    // Save to history. Skip synthetic seed ghosts (no real session/owner FK).
    if (!race.isSeed) await this.soloService.saveGhostRace({
      racerId: race.oderId,
      ghostSessionId: race.ghostSessionId,
      ghostUserId: race.ghostUserId,
      puzzleSize: race.puzzleSize,
      racerScore: result.userWins,
      ghostScore: result.ghostWins,
      racerWon: result.userWon,
      racerMmrBefore: result.mmrBefore,
      racerMmrAfter: result.newMmr,
      racerLeagueAfter: result.newLeague as any,
      ghostMmrAtRecording: race.ghostMmrAtRecording,
      isOldGhost: race.isOldGhost,
      racerTimes: race.userTimes,
      ghostTimes: race.ghostTimes,
    });

    const socket = this.findSocketByGhostRace(raceId);
    if (socket) {
      socket.emit('ghost_race_end', {
        userWins: result.userWins,
        ghostWins: result.ghostWins,
        userWon: result.userWon,
        mmrDelta: result.mmrDelta,
        newMmr: result.newMmr,
        newLeague: result.newLeague,
        ghostUsername: race.ghostUsername,
        isOldGhost: race.isOldGhost,
      });
      (socket as AuthenticatedSocket).ghostRaceId = undefined;
    }

    this.activeGhostRaces.delete(raceId);
  }

  private findSocketByGhostRace(raceId: string): Socket | undefined {
    if (!this.server) return undefined;

    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    for (const [, socket] of socketsMap) {
      if ((socket as AuthenticatedSocket).ghostRaceId === raceId) {
        return socket;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // PVP MATCH METHODS
  // ==========================================================================

  private async createMatch(player1: QueueEntry, player2: QueueEntry, puzzleSize: PuzzleSize) {
    // Create match in database
    const match = await this.matchesService.createMatch(
      player1.userId,
      player2.userId,
      puzzleSize,
    );

    // Find sockets using socketId from queue entry, falling back to a lookup
    // by userId — the recorded socketId goes stale if that player's page
    // reconnected (e.g. navigation) after joining the queue / creating the
    // challenge, but the user may well still be connected on a new socket.
    // Cast sockets to Map since TypeScript types are incorrect for namespace
    const socketsMap = this.server?.sockets as unknown as Map<string, Socket>;
    const p1Socket = (socketsMap?.get(player1.socketId) ??
      this.findSocketByUserId(player1.userId)) as AuthenticatedSocket;
    const p2Socket = (socketsMap?.get(player2.socketId) ??
      this.findSocketByUserId(player2.userId)) as AuthenticatedSocket;

    if (!p1Socket || !p2Socket) {
      console.error('Could not find sockets for matched players', {
        p1SocketId: player1.socketId,
        p2SocketId: player2.socketId,
        serverExists: !!this.server,
        socketsExists: !!this.server?.sockets,
      });
      await this.matchesService.abandonMatch(match.id);

      // findMatch already removed both players from the queue. Re-queue whichever
      // player is still connected so they aren't silently dropped from matchmaking.
      for (const [sock, entry] of [
        [p1Socket, player1],
        [p2Socket, player2],
      ] as const) {
        if (sock) {
          try {
            const { position } = await this.matchmakingService.addToQueue(
              entry.userId,
              sock.id,
              puzzleSize,
            );
            sock.emit('queue_joined', {
              position,
              estimatedWait: this.matchmakingService.getEstimatedWait(puzzleSize),
            });
          } catch {
            sock.emit('error', {
              code: 'QUEUE_ERROR',
              message: 'Failed to rejoin queue',
            });
          }
        }
      }
      return;
    }

    // Both players are now committed to this match — remove them from every queue
    // (including other puzzle sizes) so they can't be matched into a second match.
    this.matchmakingService.removeFromQueue(player1.userId);
    this.matchmakingService.removeFromQueue(player2.userId);

    // Set up match state on sockets
    p1Socket.matchId = match.id;
    p2Socket.matchId = match.id;

    // Join match room (for reconnection support)
    p1Socket.join(match.id);
    p2Socket.join(match.id);

    // Store userIds, not socket refs (sockets can reconnect with new IDs)
    this.activeMatches.set(match.id, {
      player1Id: player1.userId,
      player2Id: player2.userId,
      player1Ready: false,
      player2Ready: false,
      currentRound: 0,
    });

    // Notify players with extended opponent info
    p1Socket.emit('match_found', {
      matchId: match.id,
      opponent: {
        id: player2.userId,
        username: player2.username,
        mmr: player2.mmr,
        league: player2.league,
        country: player2.country,
        gamesPlayed: player2.gamesPlayed,
        gamesWon: player2.gamesWon,
      },
      puzzleSize,
    });

    p2Socket.emit('match_found', {
      matchId: match.id,
      opponent: {
        id: player1.userId,
        username: player1.username,
        mmr: player1.mmr,
        league: player1.league,
        country: player1.country,
        gamesPlayed: player1.gamesPlayed,
        gamesWon: player1.gamesWon,
      },
      puzzleSize,
    });

    // Auto-ready both players and start first round immediately
    this.activeMatches.get(match.id)!.player1Ready = true;
    this.activeMatches.get(match.id)!.player2Ready = true;

    // Small delay before starting first round
    setTimeout(() => this.startRound(match.id), 2000);
  }

  private async startRound(matchId: string) {
    const matchState = this.activeMatches.get(matchId);
    if (!matchState) return;

    matchState.currentRound += 1;
    matchState.player1Ready = false;
    matchState.player2Ready = false;
    // Reset solve start times for the new round
    matchState.player1SolveStartedAt = undefined;
    matchState.player2SolveStartedAt = undefined;
    matchState.player1SolveStartServerMs = undefined;
    matchState.player2SolveStartServerMs = undefined;
    // Clear any existing solve timeouts
    if (matchState.player1SolveTimeout) {
      clearTimeout(matchState.player1SolveTimeout);
      matchState.player1SolveTimeout = undefined;
    }
    if (matchState.player2SolveTimeout) {
      clearTimeout(matchState.player2SolveTimeout);
      matchState.player2SolveTimeout = undefined;
    }

    // Create solve record with scramble
    const solve = await this.matchesService.startRound(matchId, matchState.currentRound);

    const serverNow = Date.now();
    const inspectionStartsAt = serverNow + 500; // 500ms buffer for network latency

    // Track server-authoritative times for this solve
    matchState.inspectionStartServerMs = inspectionStartsAt;
    matchState.inspectionEndServerMs = inspectionStartsAt + INSPECTION_DURATION_MS;

    // Generate solveId for logging
    const solveId: SolveId = `${matchId}:${matchState.currentRound}`;

    // Notify both players (look up sockets dynamically)
    const roundData = {
      round: matchState.currentRound,
      scramble: solve.scramble,
      inspectionStartsAt,
      // Include server-authoritative times for deterministic replay
      inspectionStartServerMs: matchState.inspectionStartServerMs,
      inspectionEndServerMs: matchState.inspectionEndServerMs,
      solveId,
    };

    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    console.log(`[SYNC] Round start: ${solveId}, inspectionStartServerMs=${matchState.inspectionStartServerMs}`);

    p1Socket?.emit('round_start', roundData);
    p2Socket?.emit('round_start', roundData);

    // Set timer for inspection end (clearing any leftover one first so an
    // orphaned timer can't fire a bogus inspection_end into this round)
    if (matchState.inspectionTimer) {
      clearTimeout(matchState.inspectionTimer);
    }
    matchState.inspectionTimer = setTimeout(
      () => this.handleInspectionEnd(matchId),
      INSPECTION_DURATION_MS + 500, // Account for initial buffer
    );
  }

  private handleInspectionEnd(matchId: string) {
    const matchState = this.activeMatches.get(matchId);
    if (!matchState) return;

    const solveStartsAt = Date.now();
    const solveId: SolveId = `${matchId}:${matchState.currentRound}`;

    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    // For any player who hasn't started yet, set their solve start to inspection end
    // This ensures both players have a deterministic solve start time
    const inspectionEndData = {
      solveStartsAt,
      solveStartServerMs: solveStartsAt,
      solveId,
    };

    // If player 1 hasn't started yet, set their solve start now
    if (!matchState.player1SolveStartServerMs) {
      matchState.player1SolveStartServerMs = solveStartsAt;
      matchState.player1SolveStartedAt = solveStartsAt;
      p1Socket?.emit('solve_start', {
        solveId,
        solveStartServerMs: solveStartsAt,
        inspectionStartServerMs: matchState.inspectionStartServerMs,
        inspectionEndServerMs: matchState.inspectionEndServerMs,
      });
      // Notify opponent that p1 started (at inspection end)
      p2Socket?.emit('opponent_solve_start', {
        solveId,
        solveStartServerMs: solveStartsAt,
        inspectionStartServerMs: matchState.inspectionStartServerMs,
        inspectionEndServerMs: matchState.inspectionEndServerMs,
      });
      console.log(`[SYNC] P1 solve started at inspection end: ${solveId}, solveStartServerMs=${solveStartsAt}`);
    }

    // If player 2 hasn't started yet, set their solve start now
    if (!matchState.player2SolveStartServerMs) {
      matchState.player2SolveStartServerMs = solveStartsAt;
      matchState.player2SolveStartedAt = solveStartsAt;
      p2Socket?.emit('solve_start', {
        solveId,
        solveStartServerMs: solveStartsAt,
        inspectionStartServerMs: matchState.inspectionStartServerMs,
        inspectionEndServerMs: matchState.inspectionEndServerMs,
      });
      // Notify opponent that p2 started (at inspection end)
      p1Socket?.emit('opponent_solve_start', {
        solveId,
        solveStartServerMs: solveStartsAt,
        inspectionStartServerMs: matchState.inspectionStartServerMs,
        inspectionEndServerMs: matchState.inspectionEndServerMs,
      });
      console.log(`[SYNC] P2 solve started at inspection end: ${solveId}, solveStartServerMs=${solveStartsAt}`);
    }

    p1Socket?.emit('inspection_end', inspectionEndData);
    p2Socket?.emit('inspection_end', inspectionEndData);
  }

  private async handleRoundComplete(
    matchId: string,
    matchState: {
      player1Id: string;
      player2Id: string;
      currentRound: number;
    },
    result: {
      p1Time: number | null;
      p2Time: number | null;
      winner: 'p1' | 'p2' | 'draw' | null;
      scores: { p1: number; p2: number };
      matchComplete: boolean;
    },
  ) {
    // Clear inspection timer
    const state = this.activeMatches.get(matchId);
    if (state?.inspectionTimer) {
      clearTimeout(state.inspectionTimer);
    }

    // Look up sockets dynamically
    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    // Send results to both players
    p1Socket?.emit('solve_result', {
      round: matchState.currentRound,
      yourTime: result.p1Time,
      opponentTime: result.p2Time,
      winner: result.winner === 'p1' ? 'you' : result.winner === 'p2' ? 'opponent' : result.winner,
      scores: { you: result.scores.p1, opponent: result.scores.p2 },
    });

    p2Socket?.emit('solve_result', {
      round: matchState.currentRound,
      yourTime: result.p2Time,
      opponentTime: result.p1Time,
      winner: result.winner === 'p2' ? 'you' : result.winner === 'p1' ? 'opponent' : result.winner,
      scores: { you: result.scores.p2, opponent: result.scores.p1 },
    });

    if (result.matchComplete) {
      await this.handleMatchComplete(matchId);
    } else {
      // Reset ready states for next round
      const matchStateRef = this.activeMatches.get(matchId);
      if (matchStateRef) {
        matchStateRef.player1Ready = false;
        matchStateRef.player2Ready = false;

        // Auto-ready for next round after delay
        setTimeout(() => {
          if (this.activeMatches.has(matchId)) {
            const ms = this.activeMatches.get(matchId)!;
            ms.player1Ready = true;
            ms.player2Ready = true;
            this.startRound(matchId);
          }
        }, 3000);
      }
    }
  }

  private async handleMatchComplete(matchId: string) {
    const matchState = this.activeMatches.get(matchId);
    if (!matchState) return;

    // Clear all pending timeouts
    if (matchState.player1AbandonTimeout) {
      clearTimeout(matchState.player1AbandonTimeout);
    }
    if (matchState.player2AbandonTimeout) {
      clearTimeout(matchState.player2AbandonTimeout);
    }
    if (matchState.player1SolveTimeout) {
      clearTimeout(matchState.player1SolveTimeout);
    }
    if (matchState.player2SolveTimeout) {
      clearTimeout(matchState.player2SolveTimeout);
    }
    if (matchState.inspectionTimer) {
      clearTimeout(matchState.inspectionTimer);
    }

    const result = await this.matchesService.completeMatch(matchId);

    // Look up sockets dynamically
    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    // Send final results
    p1Socket?.emit('match_end', {
      winner: result.winnerId === matchState.player1Id ? 'you' : 'opponent',
      finalScores: { you: result.p1Score, opponent: result.p2Score },
      mmrDelta: result.p1MmrDelta,
      newMmr: result.p1NewMmr,
      newLeague: result.p1NewLeague,
    });

    p2Socket?.emit('match_end', {
      winner: result.winnerId === matchState.player2Id ? 'you' : 'opponent',
      finalScores: { you: result.p2Score, opponent: result.p1Score },
      mmrDelta: result.p2MmrDelta,
      newMmr: result.p2NewMmr,
      newLeague: result.p2NewLeague,
    });

    // Snapshot each player's solves into the ghost pool (grows liquidity;
    // respects per-user opt-out). Uses post-match MMR as the ghost's rating.
    if (this.soloService) {
      try {
        const full = await this.matchesService.getMatchWithSolves(matchId);
        const solves = (full.solves || []).slice().sort((a, b) => a.roundNumber - b.roundNumber);
        await this.soloService.recordGhost(
          matchState.player1Id,
          full.puzzleSize,
          result.p1NewMmr,
          solves.map((s) => ({
            roundNumber: s.roundNumber,
            scramble: s.scramble,
            timeMs: s.p1TimeMs,
            moves: (s.p1Moves as any) || [],
            inspectionStartAt: s.p1InspectionStartAt,
            solveStartAt: s.p1SolveStartAt,
          })),
        );
        await this.soloService.recordGhost(
          matchState.player2Id,
          full.puzzleSize,
          result.p2NewMmr,
          solves.map((s) => ({
            roundNumber: s.roundNumber,
            scramble: s.scramble,
            timeMs: s.p2TimeMs,
            moves: (s.p2Moves as any) || [],
            inspectionStartAt: s.p2InspectionStartAt,
            solveStartAt: s.p2SolveStartAt,
          })),
        );
      } catch (e) {
        console.error('Ghost snapshot error:', e);
      }
    }

    // Clean up match state after delay
    setTimeout(() => {
      const p1 = this.findMatchSocket(matchState.player1Id, matchId) as AuthenticatedSocket;
      const p2 = this.findMatchSocket(matchState.player2Id, matchId) as AuthenticatedSocket;
      if (p1) p1.matchId = undefined;
      if (p2) p2.matchId = undefined;
      this.activeMatches.delete(matchId);
    }, 10000);
  }

  /**
   * Handle solve timeout (10 minutes) - mark the solve as DNF
   */
  private async handleSolveTimeout(matchId: string, userId: string) {
    const matchState = this.activeMatches.get(matchId);
    if (!matchState) return;

    
    const isPlayer1 = userId === matchState.player1Id;

    // Clear the timeout reference
    if (isPlayer1) {
      matchState.player1SolveTimeout = undefined;
    } else {
      matchState.player2SolveTimeout = undefined;
    }

    // Record DNF for this player
    const result = await this.matchesService.recordDNF(
      matchId,
      matchState.currentRound,
      userId,
    );

    if (!result) return;

    // Notify both players of the DNF
    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    const dnfPlayer = isPlayer1 ? 'p1' : 'p2';
    p1Socket?.emit('player_dnf', {
      player: dnfPlayer === 'p1' ? 'you' : 'opponent',
      reason: 'timeout',
    });
    p2Socket?.emit('player_dnf', {
      player: dnfPlayer === 'p2' ? 'you' : 'opponent',
      reason: 'timeout',
    });

    // Same events a normal completion sends, so both clients settle their
    // timers/status ("DNF") instead of waiting on a phantom solve.
    const dnfSocket = isPlayer1 ? p1Socket : p2Socket;
    const otherSocket = isPlayer1 ? p2Socket : p1Socket;
    dnfSocket?.emit('my_solve_time', { timeMs: null });
    otherSocket?.emit('opponent_done', { timeMs: null });

    // Check if round is complete
    if (result.roundComplete) {
      await this.handleRoundComplete(matchId, matchState, result);
    }
  }

  /**
   * Handle match forfeit (disconnect or abandon)
   */
  private async handleForfeit(matchId: string, forfeitingUserId: string) {
    const matchState = this.activeMatches.get(matchId);
    if (!matchState) return;

    
    // Clear all timers
    if (matchState.inspectionTimer) {
      clearTimeout(matchState.inspectionTimer);
    }
    if (matchState.player1SolveTimeout) {
      clearTimeout(matchState.player1SolveTimeout);
    }
    if (matchState.player2SolveTimeout) {
      clearTimeout(matchState.player2SolveTimeout);
    }
    if (matchState.player1AbandonTimeout) {
      clearTimeout(matchState.player1AbandonTimeout);
    }
    if (matchState.player2AbandonTimeout) {
      clearTimeout(matchState.player2AbandonTimeout);
    }

    // Forfeit the match
    const result = await this.matchesService.forfeitMatch(matchId, forfeitingUserId);

    if (!result) {
      // Match was already completed or doesn't exist
      this.activeMatches.delete(matchId);
      return;
    }

    // Notify both players
    const p1Socket = this.findMatchSocket(matchState.player1Id, matchId);
    const p2Socket = this.findMatchSocket(matchState.player2Id, matchId);

    const isPlayer1Forfeiting = forfeitingUserId === matchState.player1Id;

    // Send forfeit notification to winner (the one who didn't forfeit)
    if (isPlayer1Forfeiting) {
      p2Socket?.emit('opponent_forfeit', {});
      p2Socket?.emit('match_end', {
        winner: 'you',
        finalScores: { you: result.p2Score, opponent: result.p1Score },
        mmrDelta: result.p2MmrDelta,
        newMmr: result.p2NewMmr,
        newLeague: result.p2NewLeague,
        forfeit: true,
      });
      p1Socket?.emit('match_end', {
        winner: 'opponent',
        finalScores: { you: result.p1Score, opponent: result.p2Score },
        mmrDelta: result.p1MmrDelta,
        newMmr: result.p1NewMmr,
        newLeague: result.p1NewLeague,
        forfeit: true,
      });
    } else {
      p1Socket?.emit('opponent_forfeit', {});
      p1Socket?.emit('match_end', {
        winner: 'you',
        finalScores: { you: result.p1Score, opponent: result.p2Score },
        mmrDelta: result.p1MmrDelta,
        newMmr: result.p1NewMmr,
        newLeague: result.p1NewLeague,
        forfeit: true,
      });
      p2Socket?.emit('match_end', {
        winner: 'opponent',
        finalScores: { you: result.p2Score, opponent: result.p1Score },
        mmrDelta: result.p2MmrDelta,
        newMmr: result.p2NewMmr,
        newLeague: result.p2NewLeague,
        forfeit: true,
      });
    }

    // Clean up match state
    const p1 = p1Socket as AuthenticatedSocket;
    const p2 = p2Socket as AuthenticatedSocket;
    if (p1) p1.matchId = undefined;
    if (p2) p2.matchId = undefined;
    this.activeMatches.delete(matchId);
  }

  // A user can hold several live sockets at once (background tabs, a second
  // device) — return the NEWEST one, which is most likely the tab they're
  // actively using. Match-scoped events must use findMatchSocket instead.
  private findSocketByUserId(userId: string): Socket | undefined {
    if (!this.server) return undefined;

    // When using a namespace, this.server.sockets is a Map<SocketId, Socket>
    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    let newest: Socket | undefined;
    for (const [, socket] of socketsMap) {
      if ((socket as AuthenticatedSocket).userId === userId) {
        newest = socket;
      }
    }
    return newest;
  }

  // The socket that should receive this match's events for this player: the
  // one explicitly ATTACHED to the match (matchId set). Routing by "any
  // socket of this user" mis-delivers to whichever tab/device connected
  // first — the production frozen/blank-cube bug. Falls back to the user's
  // newest socket for legacy clients that never attach explicitly.
  private findMatchSocket(userId: string, matchId: string): Socket | undefined {
    if (!this.server) return undefined;

    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    let newest: Socket | undefined;
    for (const [, socket] of socketsMap) {
      const s = socket as AuthenticatedSocket;
      if (s.userId !== userId) continue;
      if (s.matchId === matchId && socket.connected) return socket;
      newest = socket;
    }
    return newest;
  }

  // A LIVE socket of this user attached to this match, other than the given
  // one. Used to decide whether a connect/disconnect owns the match lifecycle.
  private findOtherAttachedSocket(
    matchId: string,
    userId: string,
    excludeSocketId: string,
  ): Socket | undefined {
    if (!this.server) return undefined;

    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    for (const [, socket] of socketsMap) {
      const s = socket as AuthenticatedSocket;
      if (
        s.userId === userId &&
        s.matchId === matchId &&
        socket.id !== excludeSocketId &&
        socket.connected
      ) {
        return socket;
      }
    }
    return undefined;
  }

  // Find a LIVE socket for this user other than the given one. Used to detect
  // that a disconnecting socket is stale (the user already reconnected).
  private findOtherSocketByUserId(userId: string, excludeSocketId: string): Socket | undefined {
    if (!this.server) return undefined;

    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    for (const [, socket] of socketsMap) {
      if (
        (socket as AuthenticatedSocket).userId === userId &&
        socket.id !== excludeSocketId &&
        socket.connected
      ) {
        return socket;
      }
    }
    return undefined;
  }
}
