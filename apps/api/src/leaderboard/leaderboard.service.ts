import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
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
      @InjectDataSource() private dataSource: DataSource,
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
        'user.country',
      ])
      // Only rank users who have actually played a game: every account ever
      // created (sign-in-only visitors, test accounts) otherwise shows up at
      // the default rating as a mystery entry.
      .where((qb) => {
        const sub = qb
          .subQuery()
          .select('1')
          .from(UserPuzzleStats, 'played')
          .where('played.userId = user.id')
          .andWhere('played.gamesPlayed > 0')
          .getQuery();
        return `EXISTS ${sub}`;
      })
      .orderBy('user.mmr', 'DESC');

    if (league) {
      query = query.andWhere('user.league = :league', { league });
    }

    const [users, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Get stats for these users (skip the query entirely when the page is empty,
    // since `IN (:...[])` produces invalid SQL).
    const userIds = users.map((u) => u.id);
    const allStats = userIds.length
      ? await this.statsRepository
          .createQueryBuilder('stats')
          .where('stats.userId IN (:...userIds)', { userIds })
          .getMany()
      : [];

    const statsMap = new Map<string, UserPuzzleStats[]>();
    for (const stat of allStats) {
      if (!statsMap.has(stat.userId)) {
        statsMap.set(stat.userId, []);
      }
      statsMap.get(stat.userId)!.push(stat);
    }

    const entries: (LeaderboardEntry & { country?: string | null })[] = users.map((user, index) => {
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
        country: user.country || null,
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
      // Stats rows are created on first lookup — only rank players who have
      // actually played this puzzle.
      .andWhere('stats.gamesPlayed > 0')
      .orderBy('stats.mmr', 'DESC');

    if (league) {
      query = query.andWhere('stats.league = :league', { league });
    }

    const [stats, total] = await query
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    const entries: (LeaderboardEntry & { country?: string | null })[] = stats.map((stat, index) => ({
      rank: (page - 1) * limit + index + 1,
      userId: stat.user.id,
      username: stat.user.username,
      mmr: stat.mmr,
      league: stat.league,
      country: stat.user.country || null,
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
        .andWhere('stats.gamesPlayed > 0')
        .andWhere('stats.mmr > :mmr', { mmr: userStats.mmr })
        .getCount();

      return count + 1;
    } else {
      const user = await this.userRepository.findOne({ where: { id: userId } });
      if (!user) return 0;

      // Match the leaderboard filter: only players with at least one game.
      const count = await this.userRepository
        .createQueryBuilder('user')
        .where((qb) => {
          const sub = qb
            .subQuery()
            .select('1')
            .from(UserPuzzleStats, 'played')
            .where('played.userId = user.id')
            .andWhere('played.gamesPlayed > 0')
            .getQuery();
          return `EXISTS ${sub}`;
        })
        .andWhere('user.mmr > :mmr', { mmr: user.mmr })
        .getCount();

      return count + 1;
    }
  }

  /**
   * A random real recorded solve (with per-move timing) for the home-page
   * hero cube. Filters to reasonable, complete solves.
   */
  async getShowcaseSolve(): Promise<{
    scramble: string;
    timeMs: number;
    username: string;
    moves: Array<{ move: string; tMs: number }>;
  } | null> {
    const rows = await this.dataSource.query(
      `SELECT ss.moves AS moves, ss.scramble AS scramble, ss.time_ms AS "timeMs", u.username AS username
       FROM solo_solves ss
       JOIN solo_sessions s ON s.id = ss.session_id
       JOIN users u ON u.id = s.user_id
       WHERE ss.status = 'completed' AND ss.time_ms IS NOT NULL
         AND ss.time_ms BETWEEN 3000 AND 90000 AND ss.move_count >= 16
       ORDER BY RANDOM() LIMIT 1`,
    );
    const row = rows?.[0];
    if (!row) return null;

    let raw: Array<{ move: string; tMs?: number }> = [];
    try {
      raw = typeof row.moves === 'string' ? JSON.parse(row.moves) : row.moves || [];
    } catch {
      return null;
    }
    if (!Array.isArray(raw) || raw.length < 4) return null;

    // Rebase to start at 0 and clamp gaps so stale timestamps or inspection
    // pauses don't stall the hero animation.
    const ts = raw.map((m, i) => ({
      move: m.move,
      t: typeof m.tMs === 'number' && Number.isFinite(m.tMs) ? m.tMs : i * 250,
    }));
    const moves: Array<{ move: string; tMs: number }> = [];
    let acc = 0;
    for (let i = 0; i < ts.length; i++) {
      const gap = i === 0 ? 0 : Math.min(Math.max(ts[i].t - ts[i - 1].t, 40), 1500);
      acc += gap;
      moves.push({ move: ts[i].move, tMs: acc });
    }

    return { scramble: row.scramble, timeMs: Number(row.timeMs), username: row.username, moves };
  }
}
