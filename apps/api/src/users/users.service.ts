import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UserPuzzleStats } from './user-puzzle-stats.entity';
import { Match } from '../matches/match.entity';
import { Solve } from '../matches/solve.entity';
import { SoloSession } from '../solo/solo-session.entity';
import { SoloSolve } from '../solo/solo-solve.entity';
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
    @InjectRepository(Solve)
    private solveRepository: Repository<Solve>,
    @InjectRepository(SoloSession)
    private soloSessionRepository: Repository<SoloSession>,
    @InjectRepository(SoloSolve)
    private soloSolveRepository: Repository<SoloSolve>,
  ) {}

  async findByUsername(username: string): Promise<User | null> {
    return this.userRepository
      .createQueryBuilder('user')
      .where('LOWER(user.username) = LOWER(:username)', { username })
      .getOne();
  }

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
      wcaId: user.wcaId || null,
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
      wcaId: user.wcaId || null,
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
    preferences: {
      animationSpeed?: number;
      cubeColors?: Record<string, string>;
      ghostOptOut?: boolean;
      cubeLogo?: string | null;
    },
  ) {
    // The logo URL renders on OTHER players' screens — never store an
    // arbitrary URL. Only Imgur uploads (see uploadLogo) or null (removal).
    if (preferences.cubeLogo !== undefined && preferences.cubeLogo !== null) {
      if (!/^https:\/\/i\.imgur\.com\/[A-Za-z0-9]+\.(png|jpe?g|gif|webp)$/.test(preferences.cubeLogo)) {
        throw new BadRequestException('Invalid logo URL');
      }
    }
    const user = await this.findById(userId);
    // The validated DTO instance carries ALL declared fields as own
    // properties — absent ones as `undefined` (ES2022 class-field semantics).
    // Spreading it raw clobbered every unsent setting: changing one color
    // wiped animationSpeed, changing speed wiped colors. Only merge keys the
    // client actually sent (null is a real value — e.g. cubeLogo removal).
    const updates = Object.fromEntries(
      Object.entries(preferences).filter(([, v]) => v !== undefined),
    );
    const merged = { ...user.preferences, ...updates };
    await this.userRepository.update(userId, { preferences: merged });
    return merged;
  }

  /**
   * Upload a cube logo image to Imgur and store the hosted URL in the user's
   * preferences. Accepts a base64 image (data-URL prefix tolerated).
   */
  async uploadLogo(userId: string, imageBase64: string): Promise<{ url: string }> {
    const base64 = imageBase64.replace(/^data:image\/[a-z+]+;base64,/, '');
    if (!base64 || base64.length > 2_000_000) {
      throw new BadRequestException('Image missing or too large (max ~1.5MB)');
    }

    const apiUrl = process.env.IMGUR_API_URL || 'https://api.imgur.com/3/image';
    // Anonymous Imgur upload. The fallback is Imgur's documented example
    // client id — register a real one and set IMGUR_CLIENT_ID for production.
    const clientId = process.env.IMGUR_CLIENT_ID || '546c25a59c58ad7';

    let link: string | undefined;
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          Authorization: `Client-ID ${clientId}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ image: base64, type: 'base64' }),
      });
      const body = (await res.json()) as { success?: boolean; data?: { link?: string } };
      if (!res.ok || !body?.data?.link) {
        console.error('[LOGO] imgur upload failed', res.status, JSON.stringify(body).slice(0, 300));
        throw new Error('upload failed');
      }
      link = body.data.link.replace(/^http:/, 'https:');
    } catch {
      throw new BadRequestException('Image upload failed — try again later');
    }

    if (!/^https:\/\/i\.imgur\.com\//.test(link)) {
      throw new BadRequestException('Unexpected upload host');
    }

    await this.updatePreferences(userId, { cubeLogo: link });
    return { url: link };
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
   * Every completed solve time for a user (matches + solo recordings),
   * chronological — powers the profile progress chart.
   */
  async getSolveTimeHistory(
    userId: string,
    puzzleSize: PuzzleSize = '3x3',
    limit = 500,
  ): Promise<{ date: string; timeMs: number; source: 'match' | 'solo' }[]> {
    // Match solves: pick this player's side, completed with a real time.
    const matchSolves = await this.solveRepository
      .createQueryBuilder('solve')
      .innerJoin(Match, 'match', 'match.id = solve.matchId')
      .where('match.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere(
        '((match.player1Id = :userId AND solve.p1Status = :done AND solve.p1TimeMs IS NOT NULL) OR ' +
          '(match.player2Id = :userId AND solve.p2Status = :done AND solve.p2TimeMs IS NOT NULL))',
        { userId, done: 'completed' },
      )
      .select([
        'solve.createdAt AS created_at',
        'CASE WHEN match.player1Id = :userId THEN solve.p1TimeMs ELSE solve.p2TimeMs END AS time_ms',
      ])
      .setParameter('userId', userId)
      .getRawMany<{ created_at: string | Date; time_ms: number }>();

    // Solo solves (ghost recordings / race snapshots).
    const soloSolves = await this.soloSolveRepository
      .createQueryBuilder('solve')
      .innerJoin(SoloSession, 'session', 'session.id = solve.sessionId')
      .where('session.userId = :userId', { userId })
      .andWhere('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere("solve.status = 'completed'")
      .andWhere('solve.timeMs IS NOT NULL')
      .select(['solve.createdAt AS created_at', 'solve.timeMs AS time_ms'])
      .getRawMany<{ created_at: string | Date; time_ms: number }>();

    const toPoint = (r: { created_at: string | Date; time_ms: number }, source: 'match' | 'solo') => ({
      date: new Date(r.created_at).toISOString(),
      timeMs: Number(r.time_ms),
      source,
    });

    return [
      ...matchSolves.map((r) => toPoint(r, 'match' as const)),
      ...soloSolves.map((r) => toPoint(r, 'solo' as const)),
    ]
      .filter((p) => Number.isFinite(p.timeMs) && p.timeMs > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit);
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
