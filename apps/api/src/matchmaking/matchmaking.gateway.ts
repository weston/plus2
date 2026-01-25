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
import { forwardRef, Inject } from '@nestjs/common';
import { MatchmakingService, QueueEntry } from './matchmaking.service';
import { MatchesService } from '../matches/matches.service';
import { PuzzleSize, PUZZLE_SIZES, INSPECTION_DURATION_MS } from '@plus2/shared';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  username?: string;
  matchId?: string;
  playerNumber?: 1 | 2;
}

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
    }
  > = new Map();

  // Matchmaking interval
  private matchmakingInterval: NodeJS.Timeout | null = null;

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService,
    @Inject(forwardRef(() => MatchesService))
    private matchesService: MatchesService,
  ) {}

  afterInit() {
    console.log('MatchmakingGateway initialized, starting matchmaking loop');
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

      console.log(`User ${socket.username} connected (userId: ${socket.userId})`);

      // Check if user has an active match and rejoin them
      console.log(`Active matches: ${this.activeMatches.size}`);
      for (const [matchId, matchState] of this.activeMatches.entries()) {
        console.log(`Checking match ${matchId}: p1=${matchState.player1Id}, p2=${matchState.player2Id}`);
        if (matchState.player1Id === socket.userId || matchState.player2Id === socket.userId) {
          socket.matchId = matchId;
          socket.join(matchId);

          // Cancel abandon timeout for this player
          const isPlayer1 = matchState.player1Id === socket.userId;
          if (isPlayer1 && matchState.player1AbandonTimeout) {
            clearTimeout(matchState.player1AbandonTimeout);
            matchState.player1AbandonTimeout = undefined;
            console.log(`Cancelled abandon timeout for player1 (${socket.username})`);
          } else if (!isPlayer1 && matchState.player2AbandonTimeout) {
            clearTimeout(matchState.player2AbandonTimeout);
            matchState.player2AbandonTimeout = undefined;
            console.log(`Cancelled abandon timeout for player2 (${socket.username})`);
          }

          // Notify opponent that player reconnected
          const opponentId = isPlayer1 ? matchState.player2Id : matchState.player1Id;
          const opponentSocket = this.findSocketByUserId(opponentId);
          opponentSocket?.emit('opponent_reconnect', {});

          console.log(`User ${socket.username} rejoined match ${matchId}`);

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
    console.log(`User ${socket.username || socket.id} disconnected`);

    // Remove from queue
    if (socket.userId) {
      this.matchmakingService.removeFromQueue(socket.userId);
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
        const abandonTimeout = setTimeout(async () => {
          const currentMatch = this.activeMatches.get(matchId);
          if (currentMatch) {
            console.log(`Abandoning match ${matchId} due to disconnect timeout`);
            await this.matchesService.abandonMatch(matchId);
            this.activeMatches.delete(matchId);
          }
        }, 30000); // 30 second grace period

        // Store timeout on the appropriate player
        if (isPlayer1) {
          match.player1AbandonTimeout = abandonTimeout;
        } else {
          match.player2AbandonTimeout = abandonTimeout;
        }
        console.log(`Set abandon timeout for ${isPlayer1 ? 'player1' : 'player2'} (${socket.username}) on match ${matchId}`);
      }
    }
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
    @MessageBody() data: { seq: number; move: string; clientTs: number },
  ) {
    if (!socket.matchId || !socket.userId) {
      console.log('Move rejected - no matchId or userId', { matchId: socket.matchId, userId: socket.userId });
      return;
    }

    const match = this.activeMatches.get(socket.matchId);
    if (!match) {
      console.log('Move rejected - match not found', { matchId: socket.matchId });
      return;
    }

    console.log(`Move from ${socket.username}: ${data.move} (seq: ${data.seq})`);
    const serverTs = Date.now();

    // Record move in database
    await this.matchesService.recordMove(
      socket.matchId,
      match.currentRound,
      socket.userId,
      { seq: data.seq, move: data.move, clientTs: data.clientTs, serverTs },
    );

    // Relay to opponent
    const isPlayer1 = socket.userId === match.player1Id;
    const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
    const opponentSocket = this.findSocketByUserId(opponentId);

    if (opponentSocket) {
      console.log(`Relaying move to opponent: ${data.move}`);
    } else {
      console.log(`Could not find opponent socket for userId: ${opponentId}`);
    }

    opponentSocket?.emit('opponent_move', {
      seq: data.seq,
      move: data.move,
      serverTs,
    });
  }

  @SubscribeMessage('solve_complete')
  async handleSolveComplete(@ConnectedSocket() socket: AuthenticatedSocket) {
    if (!socket.matchId || !socket.userId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;

    const result = await this.matchesService.recordSolveComplete(
      socket.matchId,
      match.currentRound,
      socket.userId,
    );

    if (!result) return;

    // Notify opponent of completion
    const isPlayer1 = socket.userId === match.player1Id;
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

    // Notify players
    p1Socket.emit('match_found', {
      matchId: match.id,
      opponent: {
        id: player2.userId,
        username: player2.username,
        mmr: player2.mmr,
        league: player2.league,
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

    // Create solve record with scramble
    const solve = await this.matchesService.startRound(matchId, matchState.currentRound);

    const inspectionStartsAt = Date.now() + 500; // 500ms buffer for network latency

    // Notify both players (look up sockets dynamically)
    const roundData = {
      round: matchState.currentRound,
      scramble: solve.scramble,
      inspectionStartsAt,
    };

    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

    console.log('Starting round', { matchId, round: matchState.currentRound, p1Found: !!p1Socket, p2Found: !!p2Socket });

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

    const p1Socket = this.findSocketByUserId(matchState.player1Id);
    const p2Socket = this.findSocketByUserId(matchState.player2Id);

    p1Socket?.emit('inspection_end', { solveStartsAt });
    p2Socket?.emit('inspection_end', { solveStartsAt });
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

    // Clear any pending abandon timeouts
    if (matchState.player1AbandonTimeout) {
      clearTimeout(matchState.player1AbandonTimeout);
    }
    if (matchState.player2AbandonTimeout) {
      clearTimeout(matchState.player2AbandonTimeout);
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
