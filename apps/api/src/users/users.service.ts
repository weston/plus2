import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UserPuzzleStats } from './user-puzzle-stats.entity';
import { Match } from '../matches/match.entity';
import { PuzzleSize, getLeagueFromRating, calculateRatingChange } from '@plus2/shared';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserPuzzleStats)
    private statsRepository: Repository<UserPuzzleStats>,
    @InjectRepository(Match)
    private matchRepository: Repository<Match>,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findByIdWithStats(id: string): Promise<User & { puzzleStats: UserPuzzleStats[] }> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['puzzleStats'],
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user as User & { puzzleStats: UserPuzzleStats[] };
  }

  async getProfile(userId: string) {
    const user = await this.findByIdWithStats(userId);
    return {
      id: user.id,
      username: user.username,
      mmr: user.mmr,
      league: user.league,
      country: user.country,
      createdAt: user.createdAt.toISOString(),
      stats: user.puzzleStats.map((s) => ({
        id: s.id,
        puzzleSize: s.puzzleSize,
        mmr: s.mmr,
        league: s.league,
        gamesPlayed: s.gamesPlayed,
        gamesWon: s.gamesWon,
        solvesCompleted: s.solvesCompleted,
        solvesWon: s.solvesWon,
        bestTimeMs: s.bestTimeMs,
        avgTimeMs: s.avgTimeMs,
        isProvisional: s.isProvisional,
      })),
    };
  }

  async getProfileByUsername(username: string) {
    const user = await this.userRepository.findOne({
      where: { username },
      relations: ['puzzleStats'],
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return {
      id: user.id,
      username: user.username,
      mmr: user.mmr,
      league: user.league,
      country: user.country,
      createdAt: user.createdAt.toISOString(),
      stats: user.puzzleStats.map((s) => ({
        id: s.id,
        puzzleSize: s.puzzleSize,
        mmr: s.mmr,
        league: s.league,
        gamesPlayed: s.gamesPlayed,
        gamesWon: s.gamesWon,
        solvesCompleted: s.solvesCompleted,
        solvesWon: s.solvesWon,
        bestTimeMs: s.bestTimeMs,
        avgTimeMs: s.avgTimeMs,
        isProvisional: s.isProvisional,
      })),
    };
  }

  async updateUsername(userId: string, username: string): Promise<User> {
    const existing = await this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.username) = LOWER(:username)', { username })
      .getOne();
    if (existing && existing.id !== userId) {
      throw new ConflictException('Username already taken');
    }

    await this.userRepository.update(userId, { username });
    return this.findById(userId);
  }

  async getPuzzleStats(userId: string, puzzleSize: PuzzleSize): Promise<UserPuzzleStats> {
    let stats = await this.statsRepository.findOne({
      where: { userId, puzzleSize },
    });
    if (!stats) {
      // Auto-create stats for users who don't have them yet
      stats = this.statsRepository.create({
        userId,
        puzzleSize,
      });
      await this.statsRepository.save(stats);
    }
    return stats;
  }

  async updateRatingAfterMatch(
    userId: string,
    puzzleSize: PuzzleSize,
    opponentMmr: number,
    won: boolean,
  ): Promise<{ mmrBefore: number; mmrAfter: number; league: string }> {
    const stats = await this.getPuzzleStats(userId, puzzleSize);
    const mmrBefore = stats.mmr;

    // Calculate rating change
    const ratingChange = calculateRatingChange(
      stats.mmr,
      opponentMmr,
      won ? 1 : 0,
      stats.isProvisional,
    );

    const mmrAfter = Math.max(0, stats.mmr + ratingChange);
    const newLeague = getLeagueFromRating(mmrAfter);

    // Update stats
    stats.mmr = mmrAfter;
    stats.league = newLeague;
    stats.gamesPlayed += 1;
    if (won) stats.gamesWon += 1;

    // Update provisional status
    if (stats.isProvisional) {
      stats.provisionalGamesRemaining -= 1;
      if (stats.provisionalGamesRemaining <= 0) {
        stats.isProvisional = false;
      }
    }

    // Note: per-solve time stats (best/avg) are tracked in incrementSolveStats,
    // which has the correct solvesCompleted count. They are intentionally not
    // recomputed here (doing so divided by a stale/zero count, yielding NaN).

    await this.statsRepository.save(stats);

    // Update user's global MMR (use highest puzzle MMR)
    await this.updateGlobalMmr(userId);

    return { mmrBefore, mmrAfter, league: newLeague };
  }

  async incrementSolveStats(userId: string, puzzleSize: PuzzleSize, won: boolean, timeMs: number) {
    const stats = await this.getPuzzleStats(userId, puzzleSize);
    stats.solvesCompleted += 1;
    if (won) stats.solvesWon += 1;

    if (!stats.bestTimeMs || timeMs < stats.bestTimeMs) {
      stats.bestTimeMs = timeMs;
    }

    // Update average
    if (!stats.avgTimeMs) {
      stats.avgTimeMs = timeMs;
    } else {
      stats.avgTimeMs = Math.round(
        (stats.avgTimeMs * (stats.solvesCompleted - 1) + timeMs) / stats.solvesCompleted,
      );
    }

    await this.statsRepository.save(stats);
  }

  /**
   * Update rating directly (for solo mode with pre-calculated MMR)
   */
  async updateRatingDirect(
    userId: string,
    puzzleSize: PuzzleSize,
    newMmr: number,
    won: boolean,
  ): Promise<void> {
    const stats = await this.getPuzzleStats(userId, puzzleSize);
    const newLeague = getLeagueFromRating(newMmr);

    stats.mmr = newMmr;
    stats.league = newLeague;
    stats.gamesPlayed += 1;
    if (won) stats.gamesWon += 1;

    // Update provisional status
    if (stats.isProvisional) {
      stats.provisionalGamesRemaining -= 1;
      if (stats.provisionalGamesRemaining <= 0) {
        stats.isProvisional = false;
      }
    }

    await this.statsRepository.save(stats);
    await this.updateGlobalMmr(userId);
  }

  private async updateGlobalMmr(userId: string) {
    const allStats = await this.statsRepository.find({ where: { userId } });
    if (allStats.length === 0) return; // no per-puzzle stats yet; nothing to roll up
    const maxMmr = Math.max(...allStats.map((s) => s.mmr));
    const globalLeague = getLeagueFromRating(maxMmr);

    await this.userRepository.update(userId, {
      mmr: maxMmr,
      league: globalLeague,
    });
  }

  async getPreferences(userId: string) {
    const user = await this.findById(userId);
    return user.preferences || {};
  }

  async updatePreferences(
    userId: string,
    preferences: { animationSpeed?: number; cubeColors?: Record<string, string> },
  ) {
    const user = await this.findById(userId);
    const merged = { ...user.preferences, ...preferences };
    await this.userRepository.update(userId, { preferences: merged });
    return merged;
  }

  async updateCountry(userId: string, country: string) {
    await this.userRepository.update(userId, { country });
    return { country };
  }

  async getMmrHistory(userId: string): Promise<{ date: string; mmr: number; matchId: string }[]> {
    // Get all completed matches for the user
    const matches = await this.matchRepository.find({
      where: [
        { player1Id: userId, status: 'completed' },
        { player2Id: userId, status: 'completed' },
      ],
      order: { endedAt: 'ASC' },
    });

    const history: { date: string; mmr: number; matchId: string }[] = [];

    for (const match of matches) {
      const isPlayer1 = match.player1Id === userId;
      const mmrAfter = isPlayer1 ? match.player1MmrAfter : match.player2MmrAfter;

      if (mmrAfter && match.endedAt) {
        history.push({
          date: match.endedAt.toISOString(),
          mmr: mmrAfter,
          matchId: match.id,
        });
      }
    }

    return history;
  }

  /**
   * Update a user's MMR directly (used for ghost races)
   */
  async updateMmr(userId: string, puzzleSize: PuzzleSize, newMmr: number): Promise<void> {
    const stats = await this.statsRepository.findOne({
      where: { userId, puzzleSize },
    });

    if (stats) {
      stats.mmr = newMmr;
      stats.league = getLeagueFromRating(newMmr);
      await this.statsRepository.save(stats);
    }

    // Also update global MMR on user entity
    const user = await this.findById(userId);
    user.mmr = newMmr;
    user.league = getLeagueFromRating(newMmr);
    await this.userRepository.save(user);
  }
}
