import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { SoloSession } from './solo-session.entity';
import { SoloSolve } from './solo-solve.entity';
import { GhostRace } from './ghost-race.entity';
import { Match } from '../matches/match.entity';
import { v4 as uuidv4 } from 'uuid';
import { UsersService } from '../users/users.service';
import {
  PuzzleSize,
  MoveRecord,
  GHOST_CLOSE_MMR_RANGE,
  GHOST_WIDE_MMR_RANGE,
  SCRAMBLE_LENGTHS,
  getLeagueFromRating,
  getSeedTargetTime,
  calculateGhostRatingChange,
  LeagueTier,
} from '@plus2/shared';

const ROUNDS_PER_SESSION = 5;
const GHOST_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000; // 1 week in ms

// Simple scramble generator
function generateScramble(puzzleSize: PuzzleSize): string {
  const moves3x3 = ['R', 'L', 'U', 'D', 'F', 'B'];
  const modifiers = ['', "'", '2'];
  const length = SCRAMBLE_LENGTHS[puzzleSize];

  const scramble: string[] = [];
  let lastMove = '';
  let secondLastMove = '';

  for (let i = 0; i < length; i++) {
    let move: string;
    do {
      move = moves3x3[Math.floor(Math.random() * moves3x3.length)];
    } while (
      move === lastMove ||
      (move === secondLastMove && isOpposite(move, lastMove))
    );

    const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
    scramble.push(move + modifier);

    secondLastMove = lastMove;
    lastMove = move;
  }

  return scramble.join(' ');
}

function isOpposite(move1: string, move2: string): boolean {
  const opposites: Record<string, string> = {
    R: 'L', L: 'R', U: 'D', D: 'U', F: 'B', B: 'F',
  };
  return opposites[move1] === move2;
}

@Injectable()
export class SoloService {
  constructor(
    @InjectRepository(SoloSession)
    private sessionRepository: Repository<SoloSession>,
    @InjectRepository(SoloSolve)
    private solveRepository: Repository<SoloSolve>,
    @InjectRepository(Match)
    private matchRepository: Repository<Match>,
    @InjectRepository(GhostRace)
    private ghostRaceRepository: Repository<GhostRace>,
    private usersService: UsersService,
  ) {}

  // Per-key serialization so rapid moves on the same solve don't clobber each
  // other in the read-modify-write append below.
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(key, run);
    run.catch(() => {}).finally(() => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    });
    return run;
  }

  async createSession(userId: string, puzzleSize: PuzzleSize): Promise<SoloSession> {
    // Get user's current MMR for recording
    const stats = await this.usersService.getPuzzleStats(userId, puzzleSize);

    const session = this.sessionRepository.create({
      userId,
      puzzleSize,
      totalRounds: ROUNDS_PER_SESSION,
      completedRounds: 0,
      status: 'in_progress',
      startedAt: new Date(),
      mmrAtRecording: stats.mmr,
      // Freshly generated scrambles = a brand-new scramble set.
      scrambleSetId: uuidv4(),
    });

    return this.sessionRepository.save(session);
  }

  async getSession(sessionId: string): Promise<SoloSession> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
      relations: ['solves'],
    });
    if (!session) {
      throw new Error('Session not found');
    }
    return session;
  }

  async startRound(sessionId: string, roundNumber: number): Promise<SoloSolve> {
    const session = await this.getSession(sessionId);
    const scramble = generateScramble(session.puzzleSize);

    const solve = this.solveRepository.create({
      sessionId,
      roundNumber,
      scramble,
      status: 'inspecting',
      inspectionStartAt: new Date(),
    });

    return this.solveRepository.save(solve);
  }

  async startSolving(sessionId: string, roundNumber: number): Promise<void> {
    const solve = await this.solveRepository.findOne({
      where: { sessionId, roundNumber },
    });

    if (!solve || solve.status !== 'inspecting') return;

    solve.status = 'solving';
    solve.solveStartAt = new Date();
    await this.solveRepository.save(solve);
  }

  async recordMove(
    sessionId: string,
    roundNumber: number,
    move: MoveRecord,
  ): Promise<void> {
    // Append the move via a serialized read-modify-write. The `moves` column is
    // `simple-json` (text), so the previous `|| ::jsonb` SQL was invalid on both
    // sqlite and postgres; the per-(session,round) lock keeps rapid moves from
    // clobbering each other.
    await this.withLock(`move:${sessionId}:${roundNumber}`, async () => {
      const solve = await this.solveRepository.findOne({
        where: { sessionId, roundNumber },
      });
      if (!solve) return;

      const moves = Array.isArray(solve.moves) ? solve.moves : [];
      moves.push(move);
      solve.moves = moves;
      solve.moveCount = moves.length;
      solve.status = 'solving';
      if (!solve.solveStartAt) solve.solveStartAt = new Date();
      await this.solveRepository.save(solve);
    });
  }

  async recordSolveComplete(
    sessionId: string,
    roundNumber: number,
    isDnf: boolean = false,
    moves?: MoveRecord[],
    clientTimeMs?: number,
  ): Promise<{
    timeMs: number | null;
    roundNumber: number;
    isSessionComplete: boolean;
  } | null> {
    const session = await this.getSession(sessionId);
    const solve = await this.solveRepository.findOne({
      where: { sessionId, roundNumber },
    });

    if (!solve) return null;

    const now = new Date();

    if (isDnf) {
      solve.status = 'dnf';
      solve.timeMs = null;
    } else {
      solve.status = 'completed';
      solve.solveEndAt = now;
      // Use client-provided time if available (more accurate since client tracks solve start)
      // Fall back to server calculation if possible; otherwise leave null rather
      // than recording a bogus 0 ms solve that would skew the average.
      solve.timeMs = clientTimeMs ?? (solve.solveStartAt
        ? now.getTime() - solve.solveStartAt.getTime()
        : null);
    }

    // Store moves if provided (batch submission)
    if (moves && moves.length > 0) {
      solve.moves = moves;
      solve.moveCount = moves.length;
      // Set solveStartAt based on client time if not already set
      if (!solve.solveStartAt && clientTimeMs) {
        solve.solveStartAt = new Date(now.getTime() - clientTimeMs);
      }
    }

    await this.solveRepository.save(solve);

    // Update completed rounds count (never move it backwards on out-of-order/retried completions)
    session.completedRounds = Math.max(session.completedRounds, roundNumber);
    await this.sessionRepository.save(session);

    const isSessionComplete = roundNumber >= ROUNDS_PER_SESSION;

    return {
      timeMs: solve.timeMs,
      roundNumber,
      isSessionComplete,
    };
  }

  async completeSession(sessionId: string): Promise<{
    solves: Array<{ round: number; timeMs: number | null; moveCount: number }>;
    averageTime: number | null;
  }> {
    const session = await this.getSession(sessionId);

    // Get all solves for this session
    const solves = await this.solveRepository.find({
      where: { sessionId },
      order: { roundNumber: 'ASC' },
    });

    const solveResults = solves.map(s => ({
      round: s.roundNumber,
      timeMs: s.timeMs,
      moveCount: s.moveCount,
    }));

    // Calculate average (excluding DNFs)
    const validTimes = solves.filter(s => s.timeMs !== null).map(s => s.timeMs!);
    const averageTime = validTimes.length > 0
      ? Math.round(validTimes.reduce((a, b) => a + b, 0) / validTimes.length)
      : null;

    // Update session
    session.status = 'completed';
    session.endedAt = new Date();
    session.averageTimeMs = averageTime;
    await this.sessionRepository.save(session);

    return {
      solves: solveResults,
      averageTime,
    };
  }

  async abandonSession(sessionId: string): Promise<void> {
    // Only abandon a session that's still in progress, so we never overwrite a
    // already-completed session's status/endedAt.
    await this.sessionRepository.update(
      { id: sessionId, status: 'in_progress' },
      {
        status: 'abandoned',
        endedAt: new Date(),
      },
    );
  }

  // Get a random completed session to use as ghost opponent in matchmaking
  // Excludes sessions the user has already played against
  /**
   * Every scramble-set identity this user has already been exposed to:
   * matches they played, ghosts they raced (any exposure counts — races are
   * persisted on finish AND abandon), and ghost sessions they own (their own
   * recordings + race snapshots).
   */
  async getSeenScrambleSetIds(userId: string): Promise<string[]> {
    const seen = new Set<string>();

    const own = await this.sessionRepository
      .createQueryBuilder('session')
      .select('DISTINCT session.scrambleSetId', 'sid')
      .where('session.userId = :userId', { userId })
      .andWhere('session.scrambleSetId IS NOT NULL')
      .getRawMany<{ sid: string }>();
    own.forEach((r) => seen.add(r.sid));

    const played = await this.matchRepository
      .createQueryBuilder('m')
      .select('DISTINCT m.scrambleSetId', 'sid')
      .where('(m.player1Id = :userId OR m.player2Id = :userId)', { userId })
      .andWhere('m.scrambleSetId IS NOT NULL')
      .getRawMany<{ sid: string }>();
    played.forEach((r) => seen.add(r.sid));

    const raced = await this.ghostRaceRepository
      .createQueryBuilder('gr')
      .innerJoin(SoloSession, 'gs', 'gs.id = gr.ghostSessionId')
      .select('DISTINCT gs.scrambleSetId', 'sid')
      .where('gr.racerId = :userId', { userId })
      .andWhere('gs.scrambleSetId IS NOT NULL')
      .getRawMany<{ sid: string }>();
    raced.forEach((r) => seen.add(r.sid));

    return [...seen];
  }

  async getRandomGhostSession(
    puzzleSize: PuzzleSize,
    excludeUserId: string,
    aroundMmr: number,
    mmrRange: number,
    seenSetIds: string[],
  ): Promise<SoloSession | null> {
    // Get IDs of ghost sessions this user has already played
    const playedRaces = await this.ghostRaceRepository.find({
      where: { racerId: excludeUserId },
      select: ['ghostSessionId'],
    });

    const playedSessionIds = playedRaces.map(r => r.ghostSessionId);

    // First, get just the session ID with RANDOM() ordering
    // PostgreSQL doesn't allow ORDER BY RANDOM() with SELECT DISTINCT when using joins
    const idQuery = this.sessionRepository
      .createQueryBuilder('session')
      .select('session.id')
      .where('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere('session.status = :status', { status: 'completed' })
      .andWhere('session.userId != :excludeUserId', { excludeUserId });

    // Exclude already-played ghost sessions
    if (playedSessionIds.length > 0) {
      idQuery.andWhere('session.id NOT IN (:...playedSessionIds)', { playedSessionIds });
    }

    // NEVER offer scrambles the user has already seen — a ghost whose
    // scramble set is in the user's seen list is permanently ineligible,
    // no matter whose recording it is.
    if (seenSetIds.length > 0) {
      idQuery.andWhere(
        '(session.scrambleSetId IS NULL OR session.scrambleSetId NOT IN (:...seenSetIds))',
        { seenSetIds },
      );
    }

    idQuery.andWhere('session.mmrAtRecording BETWEEN :minMmr AND :maxMmr', {
      minMmr: aroundMmr - mmrRange,
      maxMmr: aroundMmr + mmrRange,
    });

    idQuery.orderBy('RANDOM()').limit(1);

    const result = await idQuery.getRawOne();
    if (!result) {
      return null;
    }

    // Now load the full session with relations
    return this.sessionRepository.findOne({
      where: { id: result.session_id },
      relations: ['solves'],
    });
  }

  async getUserSessions(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ sessions: SoloSession[]; total: number }> {
    const [sessions, total] = await this.sessionRepository.findAndCount({
      where: { userId, status: 'completed' },
      relations: ['solves'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { sessions, total };
  }

  /**
   * Get the count of ghost recordings for a user
   */
  async getUserGhostRecordingCount(userId: string): Promise<number> {
    return this.sessionRepository.count({
      where: { userId, status: 'completed' },
    });
  }

  /**
   * Get count of available (unplayed) ghost sessions from a specific user
   */
  async getAvailableGhostCountFromUser(
    racerId: string,
    ghostUserId: string,
    puzzleSize: PuzzleSize,
  ): Promise<number> {
    // Get IDs of ghost sessions the racer has already played
    const playedRaces = await this.ghostRaceRepository.find({
      where: { racerId },
      select: ['ghostSessionId'],
    });

    const playedSessionIds = playedRaces.map(r => r.ghostSessionId);

    const query = this.sessionRepository
      .createQueryBuilder('session')
      .where('session.userId = :ghostUserId', { ghostUserId })
      .andWhere('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere('session.status = :status', { status: 'completed' });

    if (playedSessionIds.length > 0) {
      query.andWhere('session.id NOT IN (:...playedSessionIds)', { playedSessionIds });
    }

    return query.getCount();
  }

  /**
   * Find a ghost session from a specific user to race against
   */
  async findGhostFromUser(
    racerId: string,
    ghostUserId: string,
    puzzleSize: PuzzleSize,
  ): Promise<{
    ghostSession: SoloSession;
    ghostUser: {
      id: string;
      username: string;
      country: string | null;
      gamesPlayed: number;
      gamesWon: number;
      cubeColors?: Record<string, string> | null;
      cubeLogo?: string | null;
    };
    isOldGhost: boolean;
  } | null> {
    // Get IDs of ghost sessions the racer has already played
    const playedRaces = await this.ghostRaceRepository.find({
      where: { racerId },
      select: ['ghostSessionId'],
    });

    const playedSessionIds = playedRaces.map(r => r.ghostSessionId);
    const seenSetIds = await this.getSeenScrambleSetIds(racerId);

    // First, get just the session ID with RANDOM() ordering
    // PostgreSQL doesn't allow ORDER BY RANDOM() with SELECT DISTINCT when using joins
    const idQuery = this.sessionRepository
      .createQueryBuilder('session')
      .select('session.id')
      .where('session.userId = :ghostUserId', { ghostUserId })
      .andWhere('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere('session.status = :status', { status: 'completed' });

    if (playedSessionIds.length > 0) {
      idQuery.andWhere('session.id NOT IN (:...playedSessionIds)', { playedSessionIds });
    }

    // Never offer scrambles the racer has already seen.
    if (seenSetIds.length > 0) {
      idQuery.andWhere(
        '(session.scrambleSetId IS NULL OR session.scrambleSetId NOT IN (:...seenSetIds))',
        { seenSetIds },
      );
    }

    idQuery.orderBy('RANDOM()').limit(1);

    const result = await idQuery.getRawOne();
    if (!result) {
      return null;
    }

    // Now load the full session with relations
    const ghostSession = await this.sessionRepository.findOne({
      where: { id: result.session_id },
      relations: ['solves'],
    });

    if (!ghostSession) {
      return null;
    }

    const ghostUser = await this.usersService.findById(ghostUserId);
    if (!ghostUser) {
      return null;
    }

    // Get ghost user's stats for this puzzle size
    const ghostStats = await this.usersService.getPuzzleStats(ghostUserId, puzzleSize);

    const ghostAge = Date.now() - ghostSession.createdAt.getTime();
    const isOldGhost = ghostAge > GHOST_AGE_LIMIT_MS;

    return {
      ghostSession,
      ghostUser: {
        id: ghostUser.id,
        username: ghostUser.username,
        country: ghostUser.country || null,
        gamesPlayed: ghostStats?.gamesPlayed || 0,
        gamesWon: ghostStats?.gamesWon || 0,
        cubeColors: ghostUser.preferences?.cubeColors ?? null,
        cubeLogo: ghostUser.preferences?.cubeLogo ?? null,
      },
      isOldGhost,
    };
  }

  // ============================================================================
  // GHOST RACING
  // ============================================================================

  /**
   * Find a ghost session to race against, matched by skill level
   */
  async findGhostToRace(
    userId: string,
    puzzleSize: PuzzleSize,
  ): Promise<{
    ghostSession: SoloSession;
    ghostUser: {
      id: string;
      username: string;
      country: string | null;
      gamesPlayed: number;
      gamesWon: number;
      cubeColors?: Record<string, string> | null;
      cubeLogo?: string | null;
    };
    isOldGhost: boolean;
  } | null> {
    const userStats = await this.usersService.getPuzzleStats(userId, puzzleSize);
    const seenSetIds = await this.getSeenScrambleSetIds(userId);

    // Tiered selection: a ghost close to the user's rating first, then a
    // wider band. Beyond that there is deliberately NO fallback — the caller
    // sends the player to record their own ao5 (a fresh ghost) instead.
    let ghostSession = await this.getRandomGhostSession(
      puzzleSize, userId, userStats.mmr, GHOST_CLOSE_MMR_RANGE, seenSetIds,
    );
    if (!ghostSession) {
      ghostSession = await this.getRandomGhostSession(
        puzzleSize, userId, userStats.mmr, GHOST_WIDE_MMR_RANGE, seenSetIds,
      );
    }

    if (!ghostSession) {
      return null;
    }

    // Load ghost user info
    const ghostUser = await this.usersService.findById(ghostSession.userId);
    if (!ghostUser) {
      return null;
    }

    // Get ghost user's stats for this puzzle size
    const ghostStats = await this.usersService.getPuzzleStats(ghostSession.userId, puzzleSize);

    // Check if ghost is old (more than 1 week)
    const ghostAge = Date.now() - ghostSession.createdAt.getTime();
    const isOldGhost = ghostAge > GHOST_AGE_LIMIT_MS;

    return {
      ghostSession,
      ghostUser: {
        id: ghostUser.id,
        username: ghostUser.username,
        country: ghostUser.country || null,
        gamesPlayed: ghostStats?.gamesPlayed || 0,
        gamesWon: ghostStats?.gamesWon || 0,
        cubeColors: ghostUser.preferences?.cubeColors ?? null,
        cubeLogo: ghostUser.preferences?.cubeLogo ?? null,
      },
      isOldGhost,
    };
  }

  /**
   * Get the ghost's solve data for a specific round
   */
  getGhostSolveForRound(
    ghostSession: SoloSession,
    roundNumber: number,
  ): SoloSolve | undefined {
    return ghostSession.solves?.find(s => s.roundNumber === roundNumber);
  }

  /**
   * Snapshot a set of solves into a completed ghost session so others can race
   * it. Used to grow the ghost pool from ranked play (and, later, practice).
   * Respects the user's ghost opt-out preference.
   */
  async recordGhost(
    userId: string,
    puzzleSize: PuzzleSize,
    mmr: number,
    solves: Array<{
      roundNumber: number;
      scramble: string;
      timeMs: number | null;
      moves: MoveRecord[];
      inspectionStartAt?: Date | null;
      solveStartAt?: Date | null;
    }>,
    scrambleSetId?: string | null,
  ): Promise<void> {
    const valid = solves.filter((s) => s.scramble);
    if (valid.length === 0) return;

    const user = await this.usersService.findById(userId).catch(() => null);
    if (user?.preferences?.ghostOptOut) return; // user opted out of contributing ghosts

    const session = this.sessionRepository.create({
      userId,
      puzzleSize,
      totalRounds: valid.length,
      completedRounds: valid.length,
      status: 'completed',
      startedAt: new Date(),
      endedAt: new Date(),
      mmrAtRecording: mmr,
      // Inherit the source's scramble-set identity (match or raced ghost);
      // a missing id means these scrambles are their own new lineage.
      scrambleSetId: scrambleSetId ?? uuidv4(),
    });
    await this.sessionRepository.save(session);

    // Dates can arrive as Date objects or (from some drivers) strings.
    const toMs = (v: unknown): number | null => {
      if (v == null) return null;
      if (typeof v === 'number') return v;
      const t = new Date(v as string | Date).getTime();
      return Number.isNaN(t) ? null : t;
    };

    const entities = valid.map((s) => {
      const inspMs = toMs(s.inspectionStartAt);
      // Normalize per-move timing to inspection-relative tMs — the field the
      // ghost replay actually plays back. Match-recorded moves only carry an
      // ABSOLUTE clientTs (solveStart + offset); without this conversion a
      // ghost snapshotted from a ranked match replays with fabricated timing.
      const moves = (s.moves || []).map((m) => {
        if (typeof m.tMs === 'number') return m;
        if (typeof m.clientTs === 'number' && m.clientTs > 1e10 && inspMs != null) {
          return { ...m, tMs: Math.max(0, m.clientTs - inspMs) };
        }
        return m;
      });

      return this.solveRepository.create({
        sessionId: session.id,
        roundNumber: s.roundNumber,
        scramble: s.scramble,
        status: s.timeMs != null ? 'completed' : 'dnf',
        timeMs: s.timeMs ?? null,
        moves,
        moveCount: moves.length,
        inspectionStartAt: s.inspectionStartAt ?? undefined,
        solveStartAt: s.solveStartAt ?? undefined,
      });
    });
    await this.solveRepository.save(entities);
  }

  /**
   * Build a synthetic "seed" ghost — a pace bot at the player's level. Used as the
   * last fallback in ranked when no human and no real ghost is available, so there
   * is ALWAYS an opponent. Not persisted; flagged isSeed so no GhostRace row is saved.
   */
  buildSeedGhost(
    puzzleSize: PuzzleSize,
    mmr: number,
  ): {
    ghostSession: SoloSession;
    ghostUser: { id: string; username: string; country: string | null; gamesPlayed: number; gamesWon: number };
    isOldGhost: boolean;
    isSeed: boolean;
  } {
    const league = getLeagueFromRating(mmr);
    const target = getSeedTargetTime(puzzleSize, league);

    const solves: SoloSolve[] = [];
    for (let i = 0; i < ROUNDS_PER_SESSION; i++) {
      const jitter = 1 + (Math.random() * 0.2 - 0.1); // ±10%
      solves.push({
        roundNumber: i + 1,
        scramble: generateScramble(puzzleSize),
        timeMs: Math.round(target * jitter),
        moves: [],
      } as unknown as SoloSolve);
    }

    const ghostSession = {
      id: `seed_${puzzleSize}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      userId: 'seed',
      puzzleSize,
      mmrAtRecording: mmr,
      createdAt: new Date(),
      solves,
    } as unknown as SoloSession;

    const label = league.charAt(0).toUpperCase() + league.slice(1);
    return {
      ghostSession,
      ghostUser: { id: 'seed', username: `${label} Pace`, country: null, gamesPlayed: 0, gamesWon: 0 },
      isOldGhost: false,
      isSeed: true,
    };
  }

  /** Seed ghost sized to a user's current MMR for the given puzzle. */
  async buildSeedGhostForUser(userId: string, puzzleSize: PuzzleSize) {
    const stats = await this.usersService.getPuzzleStats(userId, puzzleSize);
    return this.buildSeedGhost(puzzleSize, stats.mmr);
  }

  /**
   * Calculate race result after completing all rounds.
   *
   * Ranked-ghost rating model (see design): the RACER gains/loses MMR at a
   * reduced rate (GHOST_K_MULTIPLIER) against the ghost's MMR at recording time,
   * and it counts as a ranked game (provisional-aware). The ghost OWNER is
   * frozen — racing a recording never changes the owner's rating. `ghostUserId`
   * and `isOldGhost` are retained for record-keeping (saveGhostRace).
   */
  async calculateGhostRaceResult(
    oderId: string,
    puzzleSize: PuzzleSize,
    userTimes: (number | null)[],
    ghostTimes: (number | null)[],
    ghostMmrAtRecording: number,
    ghostUserId: string,
    isOldGhost: boolean,
  ): Promise<{
    userWins: number;
    ghostWins: number;
    userWon: boolean;
    mmrBefore: number;
    mmrDelta: number;
    newMmr: number;
    newLeague: string;
  }> {
    // Count wins
    let userWins = 0;
    let ghostWins = 0;

    for (let i = 0; i < userTimes.length; i++) {
      const userTime = userTimes[i];
      const ghostTime = ghostTimes[i];

      if (userTime === null && ghostTime === null) {
        // Both DNF, no winner
      } else if (userTime === null) {
        ghostWins++;
      } else if (ghostTime === null) {
        userWins++;
      } else if (userTime < ghostTime) {
        userWins++;
      } else if (ghostTime < userTime) {
        ghostWins++;
      }
      // Equal times = no winner for that round
    }

    const isDraw = userWins === ghostWins;
    const userWon = userWins > ghostWins;
    const userStats = await this.usersService.getPuzzleStats(oderId, puzzleSize);
    const mmrBefore = userStats.mmr;

    // Reduced-K, provisional-aware change vs the ghost's recorded MMR.
    // Draw counts as a half-point.
    const actualScore = isDraw ? 0.5 : userWon ? 1 : 0;
    const mmrDelta = calculateGhostRatingChange(
      mmrBefore,
      ghostMmrAtRecording,
      actualScore,
      userStats.isProvisional,
    );
    const newMmr = Math.max(0, mmrBefore + mmrDelta);

    // Apply as a ranked game (updates league, games played/won, provisional).
    // The ghost owner is intentionally NOT updated.
    await this.usersService.updateRatingDirect(oderId, puzzleSize, newMmr, userWon);

    const newLeague = getLeagueFromRating(newMmr);

    return {
      userWins,
      ghostWins,
      userWon,
      mmrBefore,
      mmrDelta,
      newMmr,
      newLeague,
    };
  }

  /**
   * Save a completed ghost race to the database
   */
  async saveGhostRace(data: {
    racerId: string;
    ghostSessionId: string;
    ghostUserId: string;
    puzzleSize: PuzzleSize;
    racerScore: number;
    ghostScore: number;
    racerWon: boolean;
    racerMmrBefore: number;
    racerMmrAfter: number;
    racerLeagueAfter: LeagueTier;
    ghostMmrAtRecording: number;
    isOldGhost: boolean;
    racerTimes: (number | null)[];
    ghostTimes: (number | null)[];
  }): Promise<GhostRace> {
    const ghostRace = this.ghostRaceRepository.create(data);
    return this.ghostRaceRepository.save(ghostRace);
  }

  /**
   * Get a user's ghost race history (for Recent Matches display)
   */
  async getUserGhostRaces(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ races: GhostRace[]; total: number }> {
    const [races, total] = await this.ghostRaceRepository.findAndCount({
      where: { racerId: userId },
      relations: ['ghostUser'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { races, total };
  }

  /**
   * Get ghost races where the user's ghost was used (others racing against their recordings)
   */
  async getGhostRacesAgainstUser(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ races: GhostRace[]; total: number }> {
    const [races, total] = await this.ghostRaceRepository.findAndCount({
      where: { ghostUserId: userId },
      relations: ['racer'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { races, total };
  }
}
