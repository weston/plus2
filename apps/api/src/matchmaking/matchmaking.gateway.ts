import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
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
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/game',
})
export class MatchmakingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // Map matchId -> { player1Socket, player2Socket, ... }
  private activeMatches: Map<
    string,
    {
      player1Socket: AuthenticatedSocket;
      player2Socket: AuthenticatedSocket;
      player1Ready: boolean;
      player2Ready: boolean;
      currentRound: number;
      inspectionTimer?: NodeJS.Timeout;
    }
  > = new Map();

  // Matchmaking interval
  private matchmakingInterval: NodeJS.Timeout | null = null;

  constructor(
    private jwtService: JwtService,
    private matchmakingService: MatchmakingService,
    @Inject(forwardRef(() => MatchesService))
    private matchesService: MatchesService,
  ) {
    // Start matchmaking loop
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

      console.log(`User ${socket.username} connected`);
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

    // Handle match disconnect
    if (socket.matchId) {
      const match = this.activeMatches.get(socket.matchId);
      if (match) {
        const opponentSocket =
          socket.playerNumber === 1 ? match.player2Socket : match.player1Socket;
        if (opponentSocket) {
          opponentSocket.emit('opponent_disconnect', {});
        }
        // Mark match as abandoned after timeout
        setTimeout(async () => {
          const currentMatch = this.activeMatches.get(socket.matchId!);
          if (currentMatch) {
            await this.matchesService.abandonMatch(socket.matchId!);
            this.activeMatches.delete(socket.matchId!);
          }
        }, 30000); // 30 second grace period
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
    if (!socket.matchId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;

    if (socket.playerNumber === 1) {
      match.player1Ready = true;
    } else {
      match.player2Ready = true;
    }

    // Notify opponent
    const opponentSocket =
      socket.playerNumber === 1 ? match.player2Socket : match.player1Socket;
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
    if (!socket.matchId || !socket.userId) return;

    const match = this.activeMatches.get(socket.matchId);
    if (!match) return;

    const serverTs = Date.now();

    // Record move in database
    await this.matchesService.recordMove(
      socket.matchId,
      match.currentRound,
      socket.userId,
      { seq: data.seq, move: data.move, clientTs: data.clientTs, serverTs },
    );

    // Relay to opponent
    const opponentSocket =
      socket.playerNumber === 1 ? match.player2Socket : match.player1Socket;

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
    const opponentSocket =
      socket.playerNumber === 1 ? match.player2Socket : match.player1Socket;
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

    // Find sockets
    const p1Socket = this.findSocketByUserId(player1.userId) as AuthenticatedSocket;
    const p2Socket = this.findSocketByUserId(player2.userId) as AuthenticatedSocket;

    if (!p1Socket || !p2Socket) {
      console.error('Could not find sockets for matched players');
      await this.matchesService.abandonMatch(match.id);
      return;
    }

    // Set up match state
    p1Socket.matchId = match.id;
    p1Socket.playerNumber = 1;
    p2Socket.matchId = match.id;
    p2Socket.playerNumber = 2;

    // Join match room
    p1Socket.join(match.id);
    p2Socket.join(match.id);

    this.activeMatches.set(match.id, {
      player1Socket: p1Socket,
      player2Socket: p2Socket,
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

    // Notify both players
    const roundData = {
      round: matchState.currentRound,
      scramble: solve.scramble,
      inspectionStartsAt,
    };

    matchState.player1Socket.emit('round_start', roundData);
    matchState.player2Socket.emit('round_start', roundData);

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

    matchState.player1Socket.emit('inspection_end', { solveStartsAt });
    matchState.player2Socket.emit('inspection_end', { solveStartsAt });
  }

  private async handleRoundComplete(
    matchId: string,
    matchState: {
      player1Socket: AuthenticatedSocket;
      player2Socket: AuthenticatedSocket;
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

    // Send results to both players
    matchState.player1Socket.emit('solve_result', {
      round: matchState.currentRound,
      yourTime: result.p1Time,
      opponentTime: result.p2Time,
      winner: result.winner === 'p1' ? 'you' : result.winner === 'p2' ? 'opponent' : result.winner,
      scores: { you: result.scores.p1, opponent: result.scores.p2 },
    });

    matchState.player2Socket.emit('solve_result', {
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

    const result = await this.matchesService.completeMatch(matchId);

    // Send final results
    matchState.player1Socket.emit('match_end', {
      winner: result.winnerId === matchState.player1Socket.userId ? 'you' : 'opponent',
      finalScores: { you: result.p1Score, opponent: result.p2Score },
      mmrDelta: result.p1MmrDelta,
      newMmr: result.p1NewMmr,
      newLeague: result.p1NewLeague,
    });

    matchState.player2Socket.emit('match_end', {
      winner: result.winnerId === matchState.player2Socket.userId ? 'you' : 'opponent',
      finalScores: { you: result.p2Score, opponent: result.p1Score },
      mmrDelta: result.p2MmrDelta,
      newMmr: result.p2NewMmr,
      newLeague: result.p2NewLeague,
    });

    // Clean up match state after delay
    setTimeout(() => {
      matchState.player1Socket.matchId = undefined;
      matchState.player1Socket.playerNumber = undefined;
      matchState.player2Socket.matchId = undefined;
      matchState.player2Socket.playerNumber = undefined;
      this.activeMatches.delete(matchId);
    }, 10000);
  }

  private findSocketByUserId(userId: string): Socket | undefined {
    const sockets = this.server.sockets.sockets;
    for (const [, socket] of sockets) {
      if ((socket as AuthenticatedSocket).userId === userId) {
        return socket;
      }
    }
    return undefined;
  }
}
