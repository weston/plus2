import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UserPuzzleStats } from './user-puzzle-stats.entity';
import { PuzzleSize, getLeagueFromRating, calculateRatingChange } from '@plus2/shared';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserPuzzleStats)
    private statsRepository: Repository<UserPuzzleStats>,
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
    const existing = await this.userRepository.findOne({ where: { username } });
    if (existing && existing.id !== userId) {
      throw new ConflictException('Username already taken');
    }

    await this.userRepository.update(userId, { username });
    return this.findById(userId);
  }

  async getPuzzleStats(userId: string, puzzleSize: PuzzleSize): Promise<UserPuzzleStats> {
    const stats = await this.statsRepository.findOne({
      where: { userId, puzzleSize },
    });
    if (!stats) {
      throw new NotFoundException('Stats not found');
    }
    return stats;
  }

  async updateRatingAfterMatch(
    userId: string,
    puzzleSize: PuzzleSize,
    opponentMmr: number,
    won: boolean,
    solveTimeMs?: number,
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

    // Update solve time stats if provided
    if (solveTimeMs) {
      if (!stats.bestTimeMs || solveTimeMs < stats.bestTimeMs) {
        stats.bestTimeMs = solveTimeMs;
      }
      // Update rolling average (simplified)
      if (!stats.avgTimeMs) {
        stats.avgTimeMs = solveTimeMs;
      } else {
        stats.avgTimeMs = Math.round(
          (stats.avgTimeMs * (stats.solvesCompleted - 1) + solveTimeMs) / stats.solvesCompleted,
        );
      }
    }

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

  private async updateGlobalMmr(userId: string) {
    const allStats = await this.statsRepository.find({ where: { userId } });
    const maxMmr = Math.max(...allStats.map((s) => s.mmr));
    const globalLeague = getLeagueFromRating(maxMmr);

    await this.userRepository.update(userId, {
      mmr: maxMmr,
      league: globalLeague,
    });
  }
}
