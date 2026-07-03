import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';
import {
  PuzzleSize,
  MATCHMAKING_INITIAL_RANGE,
  MATCHMAKING_RANGE_EXPANSION,
  MATCHMAKING_EXPAND_INTERVAL_MS,
  MATCHMAKING_MAX_RANGE,
} from '@plus2/shared';

export interface QueueEntry {
  userId: string;
  socketId: string;
  puzzleSize: PuzzleSize;
  mmr: number;
  searchRange: number;
  joinedAt: number;
  username: string;
  league: string;
  // Extended opponent info
  country: string | null;
  gamesPlayed: number;
  gamesWon: number;
}

export interface Challenge {
  code: string;
  creatorId: string;
  creatorSocketId: string;
  puzzleSize: PuzzleSize;
  createdAt: number;
  creatorUsername: string;
  creatorMmr: number;
  creatorLeague: string;
  // Extended opponent info
  creatorCountry: string | null;
  creatorGamesPlayed: number;
  creatorGamesWon: number;
  // Direct challenge: when set, only this user may join.
  targetUserId?: string | null;
  targetUsername?: string | null;
}

@Injectable()
export class MatchmakingService {
  // In-memory queue (could be Redis for horizontal scaling)
  private queues: Map<PuzzleSize, Map<string, QueueEntry>> = new Map([
    ['2x2', new Map()],
    ['3x3', new Map()],
    ['4x4', new Map()],
    ['5x5', new Map()],
  ]);

  // Challenge links - code -> Challenge
  private challenges: Map<string, Challenge> = new Map();

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserPuzzleStats)
    private statsRepository: Repository<UserPuzzleStats>,
  ) {}

  async addToQueue(
    userId: string,
    socketId: string,
    puzzleSize: PuzzleSize,
  ): Promise<{ entry: QueueEntry; position: number }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const stats = await this.statsRepository.findOne({
      where: { userId, puzzleSize },
    });

    const queue = this.queues.get(puzzleSize)!;

    // Remove if already in queue
    queue.delete(userId);

    const entry: QueueEntry = {
      userId,
      socketId,
      puzzleSize,
      mmr: stats?.mmr || 1000,
      searchRange: MATCHMAKING_INITIAL_RANGE,
      joinedAt: Date.now(),
      username: user.username,
      league: user.league,
      // Extended opponent info
      country: user.country || null,
      gamesPlayed: stats?.gamesPlayed || 0,
      gamesWon: stats?.gamesWon || 0,
    };

    queue.set(userId, entry);

    return {
      entry,
      position: queue.size,
    };
  }

  removeFromQueue(userId: string, puzzleSize?: PuzzleSize): void {
    if (puzzleSize) {
      this.queues.get(puzzleSize)?.delete(userId);
    } else {
      // Remove from all queues
      for (const queue of this.queues.values()) {
        queue.delete(userId);
      }
    }
  }

  removeBySocketId(socketId: string): void {
    for (const queue of this.queues.values()) {
      for (const [userId, entry] of queue.entries()) {
        if (entry.socketId === socketId) {
          queue.delete(userId);
        }
      }
    }
  }

  findMatch(puzzleSize: PuzzleSize): [QueueEntry, QueueEntry] | null {
    const queue = this.queues.get(puzzleSize)!;
    const entries = Array.from(queue.values());

    if (entries.length < 2) return null;

    // Expand search ranges for entries that have been waiting
    const now = Date.now();
    for (const entry of entries) {
      const waitTime = now - entry.joinedAt;
      const expansions = Math.floor(waitTime / MATCHMAKING_EXPAND_INTERVAL_MS);
      entry.searchRange = Math.min(
        MATCHMAKING_INITIAL_RANGE + expansions * MATCHMAKING_RANGE_EXPANSION,
        MATCHMAKING_MAX_RANGE,
      );
    }

    // Sort by join time (FIFO priority)
    entries.sort((a, b) => a.joinedAt - b.joinedAt);

    // Scan in FIFO order and pair the first two mutually-compatible entries.
    // Seeding only from entries[0] head-of-line blocks: if the oldest waiter is
    // out of MMR range of everyone, mutually-compatible players behind them
    // would never pair this tick. We still form only one pairing per call and
    // prefer the oldest possible pair.
    for (let i = 0; i < entries.length; i++) {
      const player1 = entries[i];

      for (let j = i + 1; j < entries.length; j++) {
        const player2 = entries[j];
        const mmrDiff = Math.abs(player1.mmr - player2.mmr);

        // Check if within both players' search ranges
        if (mmrDiff <= player1.searchRange && mmrDiff <= player2.searchRange) {
          // Remove both from queue
          queue.delete(player1.userId);
          queue.delete(player2.userId);
          return [player1, player2];
        }
      }
    }

    return null;
  }

  // Entries that have waited at least `olderThanMs` with no human match —
  // candidates for a ghost fallback so there's always an opponent.
  getStaleEntries(puzzleSize: PuzzleSize, olderThanMs: number): QueueEntry[] {
    const queue = this.queues.get(puzzleSize);
    if (!queue) return [];
    const now = Date.now();
    return Array.from(queue.values()).filter((e) => now - e.joinedAt >= olderThanMs);
  }

  getQueueSize(puzzleSize: PuzzleSize): number {
    return this.queues.get(puzzleSize)?.size || 0;
  }

  getEstimatedWait(puzzleSize: PuzzleSize): number {
    const size = this.getQueueSize(puzzleSize);
    // Rough estimate: 30 seconds per person in queue
    return Math.max(10, size * 30);
  }

  isInQueue(userId: string): PuzzleSize | null {
    for (const [size, queue] of this.queues.entries()) {
      if (queue.has(userId)) {
        return size;
      }
    }
    return null;
  }

  // Challenge link methods
  private generateChallengeCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async createChallenge(
    userId: string,
    socketId: string,
    puzzleSize: PuzzleSize,
    target?: { userId: string; username: string } | null,
  ): Promise<Challenge> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    const stats = await this.statsRepository.findOne({
      where: { userId, puzzleSize },
    });

    // Generate unique code
    let code: string;
    do {
      code = this.generateChallengeCode();
    } while (this.challenges.has(code));

    const challenge: Challenge = {
      code,
      creatorId: userId,
      creatorSocketId: socketId,
      puzzleSize,
      createdAt: Date.now(),
      creatorUsername: user.username,
      creatorMmr: stats?.mmr || 1000,
      creatorLeague: user.league,
      // Extended opponent info
      creatorCountry: user.country || null,
      creatorGamesPlayed: stats?.gamesPlayed || 0,
      creatorGamesWon: stats?.gamesWon || 0,
      targetUserId: target?.userId ?? null,
      targetUsername: target?.username ?? null,
    };

    this.challenges.set(code, challenge);

    // Auto-expire after 10 minutes
    setTimeout(() => {
      this.challenges.delete(code);
    }, 10 * 60 * 1000);

    return challenge;
  }

  getChallenge(code: string): Challenge | undefined {
    return this.challenges.get(code.toUpperCase());
  }

  deleteChallenge(code: string): void {
    this.challenges.delete(code.toUpperCase());
  }

  // Returns the deleted challenges so callers can notify their targets.
  // `onlySocketId` scopes deletion to challenges CREATED BY THAT SOCKET —
  // disconnect cleanup must pass it, or a stale socket's late ping-timeout
  // (processed up to ~45s after the fact) deletes a challenge the user just
  // created from their CURRENT socket.
  deleteChallengeByCreator(userId: string, onlySocketId?: string): Challenge[] {
    const deleted: Challenge[] = [];
    for (const [code, challenge] of this.challenges.entries()) {
      if (challenge.creatorId !== userId) continue;
      if (onlySocketId && challenge.creatorSocketId !== onlySocketId) continue;
      this.challenges.delete(code);
      deleted.push(challenge);
    }
    return deleted;
  }
}
