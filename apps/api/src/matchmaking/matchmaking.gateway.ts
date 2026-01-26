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
import { PuzzleSize, PUZZLE_SIZES, INSPECTION_DURATION_MS } from '@plus2/shared';

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
    for (const size of PUZZLE_SIZES) {
      const match = this.matchmakingService.findMatch(size);
      if (match) {
        await this.createMatch(match[0], match[1], size);
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
      for (const [matchId, matchState] of this.activeMatches.entries()) {
        if (matchState.player1Id === socket.userId || matchState.player2Id === socket.userId) {
          socket.matchId = matchId;
          socket.join(matchId);

          // Cancel abandon timeout for this player
          const isPlayer1 = matchState.player1Id === socket.userId;
          if (isPlayer1 && matchState.player1AbandonTimeout) {
            clearTimeout(matchState.player1AbandonTimeout);
            matchState.player1AbandonTimeout = undefined;
          } else if (!isPlayer1 && matchState.player2AbandonTimeout) {
            clearTimeout(matchState.player2AbandonTimeout);
            matchState.player2AbandonTimeout = undefined;
          }

          // Notify opponent that player reconnected
          const opponentId = isPlayer1 ? matchState.player2Id : matchState.player1Id;
          const opponentSocket = this.findSocketByUserId(opponentId);
          opponentSocket?.emit('opponent_reconnect', {});

          // Send current match state to the reconnected user
          const match = await this.matchesService.getMatch(matchId);
          if (match) {
            const isPlayer1 = matchState.player1Id === socket.userId;
            const opponentId = isPlayer1 ? matchState.player2Id : matchState.player1Id;
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
            });

            // If there's an active round, send round_start
            if (matchState.currentRound > 0 && match.solves?.length > 0) {
              const currentSolve = match.solves.find(s => s.roundNumber === matchState.currentRound);
              if (currentSolve) {
                socket.emit('round_start', {
                  round: matchState.currentRound,
                  scramble: currentSolve.scramble,
                  inspectionStartsAt: Date.now(), // Already in progress
                });
                // Also send inspection_end immediately since they're rejoining mid-round
                socket.emit('inspection_end', { solveStartsAt: Date.now() });
              }
            }
          }
          break;
        }
      }
    } catch (error) {
      socket.emit('error', { code: 'AUTH_INVALID', message: 'Invalid authentication' });
      socket.disconnect();
    }
  }

  handleDisconnect(socket: AuthenticatedSocket) {
    // Remove from queue and delete any pending challenges
    if (socket.userId) {
      this.matchmakingService.removeFromQueue(socket.userId);
      this.matchmakingService.deleteChallengeByCreator(socket.userId);
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

    // Handle match disconnect - notify opponent if they're still connected
    if (socket.matchId && socket.userId) {
      const match = this.activeMatches.get(socket.matchId);
      if (match) {
        const isPlayer1 = socket.userId === match.player1Id;
        const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
        const opponentSocket = this.findSocketByUserId(opponentId);
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
    const opponentSocket = this.findSocketByUserId(opponentId);
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

    // Record move in database (convert tMs to clientTs for backward compatibility)
    const clientTs = solveStartServerMs ? solveStartServerMs + data.tMs : serverTs;
    await this.matchesService.recordMove(
      socket.matchId,
      match.currentRound,
      socket.userId,
      { seq: data.seq, move: data.move, clientTs, serverTs },
    );

    // Relay to opponent with relative timestamp for deterministic replay
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findSocketByUserId(opponentId);

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

    // Client sends their already-calculated time - we just pass it through
    const result = await this.matchesService.recordSolveComplete(
      socket.matchId,
      match.currentRound,
      socket.userId,
      data?.timeMs, // Use client's time directly
    );

    if (!result) return;

    // Send the SAME time to BOTH players
    socket.emit('my_solve_time', { timeMs: result.timeMs });

    // Notify opponent of completion with the SAME time
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findSocketByUserId(opponentId);
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
      socketId: challenge.creatorSocketId,
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

    const result = await this.soloService.recordSolveComplete(
      socket.soloSessionId,
      session.currentRound,
      data?.isDnf ?? false,
      moves,
      data?.timeMs, // Pass client-calculated time
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
      const ghostData = data.opponentId
        ? await this.soloService.findGhostFromUser(socket.userId, data.opponentId, data.puzzleSize)
        : await this.soloService.findGhostToRace(socket.userId, data.puzzleSize);

      if (!ghostData) {
        const message = data.opponentId
          ? 'No available ghosts from this player. You may have already raced all their ghosts!'
          : 'No ghost opponents available. Try creating some ghost solves first!';
        socket.emit('error', { code: 'NO_GHOSTS', message });
        return;
      }

      const { ghostSession, ghostUser, isOldGhost } = ghostData;

      // Create race ID
      const raceId = `race_${Date.now()}_${socket.userId}`;
      socket.ghostRaceId = raceId;

      // Prepare ghost solve data with inspection and solve timing
      const ghostSolves = ghostSession.solves
        ?.sort((a, b) => a.roundNumber - b.roundNumber)
        .map(s => ({
          scramble: s.scramble,
          timeMs: s.timeMs,
          moves: s.moves || [],
          inspectionStartAt: s.inspectionStartAt?.getTime() || 0,
          solveStartAt: s.solveStartAt?.getTime() || 0,
        })) || [];

      this.activeGhostRaces.set(raceId, {
        oderId: socket.userId,
        puzzleSize: data.puzzleSize,
        ghostSessionId: ghostSession.id,
        ghostUserId: ghostUser.id,
        ghostUsername: ghostUser.username,
        ghostMmrAtRecording: ghostSession.mmrAtRecording || 1000,
        isOldGhost,
        currentRound: 0,
        totalRounds: ghostSolves.length,
        userTimes: [],
        ghostTimes: ghostSolves.map(s => s.timeMs),
        ghostSolves,
      });

      socket.emit('ghost_race_started', {
        raceId,
        puzzleSize: data.puzzleSize,
        totalRounds: ghostSolves.length,
        ghostUsername: ghostUser.username,
        ghostMmr: ghostSession.mmrAtRecording || 1000,
        isOldGhost,
        // Extended ghost info
        ghostCountry: ghostUser.country,
        ghostGamesPlayed: ghostUser.gamesPlayed,
        ghostGamesWon: ghostUser.gamesWon,
      });

      // Start first round after a short delay
      setTimeout(() => this.startGhostRaceRound(raceId), 2000);

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
  async handleGhostRaceComplete(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.ghostRaceId || !socket.userId || !this.soloService) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) return;

    // Clear solve timeout
    if (race.solveTimeout) {
      clearTimeout(race.solveTimeout);
      race.solveTimeout = undefined;
    }

    // Calculate user's time
    const userTime = race.solveStartedAt ? Date.now() - race.solveStartedAt : null;
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
    } else {
      // Start next round after delay (can be skipped by user)
      const raceId = socket.ghostRaceId;
      race.nextRoundTimer = setTimeout(() => this.startGhostRaceRound(raceId), 3000);
    }
  }

  @SubscribeMessage('ghost_race_skip')
  async handleGhostRaceSkip(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.ghostRaceId || !socket.userId) return;

    const race = this.activeGhostRaces.get(socket.ghostRaceId);
    if (!race) return;

    // Clear the next round timer and start immediately
    if (race.nextRoundTimer) {
      clearTimeout(race.nextRoundTimer);
      race.nextRoundTimer = undefined;

      if (race.currentRound < race.totalRounds) {
        this.startGhostRaceRound(socket.ghostRaceId);
      }
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

    // Save the ghost race to database (prevents replaying this ghost)
    await this.soloService.saveGhostRace({
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

    // Save the ghost race to database for history tracking
    await this.soloService.saveGhostRace({
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

    // Find sockets using socketId from queue entry
    // Cast sockets to Map since TypeScript types are incorrect for namespace
    const socketsMap = this.server?.sockets as unknown as Map<string, Socket>;
    const p1Socket = socketsMap?.get(player1.socketId) as AuthenticatedSocket;
    const p2Socket = socketsMap?.get(player2.socketId) as AuthenticatedSocket;

    if (!p1Socket || !p2Socket) {
      console.error('Could not find sockets for matched players', {
        p1SocketId: player1.socketId,
        p2SocketId: player2.socketId,
        serverExists: !!this.server,
        socketsExists: !!this.server?.sockets,
      });
      await this.matchesService.abandonMatch(match.id);
      return;
    }

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

    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

    console.log(`[SYNC] Round start: ${solveId}, inspectionStartServerMs=${matchState.inspectionStartServerMs}`);

    p1Socket?.emit('round_start', roundData);
    p2Socket?.emit('round_start', roundData);

    // Set timer for inspection end
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

    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

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
    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

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
    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

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

    // Clean up match state after delay
    setTimeout(() => {
      const p1 = this.findSocketByUserId(matchState.player1Id) as AuthenticatedSocket;
      const p2 = this.findSocketByUserId(matchState.player2Id) as AuthenticatedSocket;
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
    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

    const dnfPlayer = isPlayer1 ? 'p1' : 'p2';
    p1Socket?.emit('player_dnf', {
      player: dnfPlayer === 'p1' ? 'you' : 'opponent',
      reason: 'timeout',
    });
    p2Socket?.emit('player_dnf', {
      player: dnfPlayer === 'p2' ? 'you' : 'opponent',
      reason: 'timeout',
    });

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
    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

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

  private findSocketByUserId(userId: string): Socket | undefined {
    if (!this.server) return undefined;

    // When using a namespace, this.server.sockets is a Map<SocketId, Socket>
    const socketsMap = this.server.sockets as unknown as Map<string, Socket>;
    for (const [, socket] of socketsMap) {
      if ((socket as AuthenticatedSocket).userId === userId) {
        return socket;
      }
    }
    return undefined;
  }
}
