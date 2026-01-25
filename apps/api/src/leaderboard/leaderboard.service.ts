import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';
import { PuzzleSize, LeaderboardEntry, LeagueTier } from '@plus2/shared';

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserPuzzleStats)
    private statsRepository: Repository<UserPuzzleStats>,
  ) {}

  async getGlobalLeaderboard(
    page = 1,
    limit = 50,
    league?: LeagueTier,
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    let query = this.userRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.username',
        'user.mmr',
        'user.league',
      ])
      .orderBy('user.mmr', 'DESC');

    if (league) {
      query = query.where('user.league = :league', { league });
    }

    const [users, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Get stats for these users
    const userIds = users.map((u) => u.id);
    const allStats = await this.statsRepository
      .createQueryBuilder('stats')
      .where('stats.userId IN (:...userIds)', { userIds })
      .getMany();

    const statsMap = new Map<string, UserPuzzleStats[]>();
    for (const stat of allStats) {
      if (!statsMap.has(stat.userId)) {
        statsMap.set(stat.userId, []);
      }
      statsMap.get(stat.userId)!.push(stat);
    }

    const entries: LeaderboardEntry[] = users.map((user, index) => {
      const userStats = statsMap.get(user.id) || [];
      const totalGamesPlayed = userStats.reduce((sum, s) => sum + s.gamesPlayed, 0);
      const totalGamesWon = userStats.reduce((sum, s) => sum + s.gamesWon, 0);
      const bestTime = Math.min(
        ...userStats.filter((s) => s.bestTimeMs).map((s) => s.bestTimeMs!),
      );

      return {
        rank: (page - 1) * limit + index + 1,
        userId: user.id,
        username: user.username,
        mmr: user.mmr,
        league: user.league,
        gamesPlayed: totalGamesPlayed,
        gamesWon: totalGamesWon,
        winRate: totalGamesPlayed > 0 ? totalGamesWon / totalGamesPlayed : 0,
        bestTimeMs: bestTime === Infinity ? null : bestTime,
      };
    });

    return { entries, total };
  }

  async getPuzzleLeaderboard(
    puzzleSize: PuzzleSize,
    page = 1,
    limit = 50,
    league?: LeagueTier,
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    let query = this.statsRepository
      .createQueryBuilder('stats')
      .leftJoinAndSelect('stats.user', 'user')
      .where('stats.puzzleSize = :puzzleSize', { puzzleSize })
      .orderBy('stats.mmr', 'DESC');

    if (league) {
      query = query.andWhere('stats.league = :league', { league });
    }

    const [stats, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const entries: LeaderboardEntry[] = stats.map((stat, index) => ({
      rank: (page - 1) * limit + index + 1,
      userId: stat.user.id,
      username: stat.user.username,
      mmr: stat.mmr,
      league: stat.league,
      gamesPlayed: stat.gamesPlayed,
      gamesWon: stat.gamesWon,
      winRate: stat.gamesPlayed > 0 ? stat.gamesWon / stat.gamesPlayed : 0,
      bestTimeMs: stat.bestTimeMs,
    }));

    return { entries, total };
  }

  async getUserRank(userId: string, puzzleSize?: PuzzleSize): Promise<number> {
    if (puzzleSize) {
      const userStats = await this.statsRepository.findOne({
        where: { userId, puzzleSize },
      });

      if (!userStats) return 0;

      const count = await this.statsRepository
        .createQueryBuilder('stats')
        .where('stats.puzzleSize = :puzzleSize', { puzzleSize })
        .andWhere('stats.mmr > :mmr', { mmr: userStats.mmr })
        .getCount();

      return count + 1;
    } else {
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) return 0;

      const count = await this.userRepository
        .createQueryBuilder('user')
        .where('user.mmr > :mmr', { mmr: user.mmr })
        .getCount();

      return count + 1;
    }
  }
}
