import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { SoloSession } from './solo-session.entity';
import { SoloSolve } from './solo-solve.entity';
import { GhostRace } from './ghost-race.entity';
import { UsersService } from '../users/users.service';
import {
  PuzzleSize,
  MoveRecord,
  SCRAMBLE_LENGTHS,
  getLeagueFromRating,
  LeagueTier,
} from '@plus2/shared';

const ROUNDS_PER_SESSION = 5;
const GHOST_AGE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000; // 1 week in ms
const K_FACTOR = 32; // ELO K-factor for MMR calculations

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
    @InjectRepository(GhostRace)
    private ghostRaceRepository: Repository<GhostRace>,
    private usersService: UsersService,
  ) {}

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
    const solve = await this.solveRepository.findOne({
      where: { sessionId, roundNumber },
    });

    if (!solve) return;

    // If first move during inspection, start solving
    if (solve.status === 'inspecting') {
      solve.status = 'solving';
      solve.solveStartAt = new Date();
    }

    solve.moves.push(move);
    solve.moveCount = solve.moves.length;

    await this.solveRepository.save(solve);
  }

  async recordSolveComplete(
    sessionId: string,
    roundNumber: number,
    isDnf: boolean = false,
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
      solve.timeMs = solve.solveStartAt
        ? now.getTime() - solve.solveStartAt.getTime()
        : 0;
    }

    await this.solveRepository.save(solve);

    // Update completed rounds count
    session.completedRounds = roundNumber;
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
    await this.sessionRepository.update(sessionId, {
      status: 'abandoned',
      endedAt: new Date(),
    });
  }

  // Get a random completed session to use as ghost opponent in matchmaking
  // Excludes sessions the user has already played against
  async getRandomGhostSession(
    puzzleSize: PuzzleSize,
    excludeUserId: string,
    aroundMmr?: number,
  ): Promise<SoloSession | null> {
    // Get IDs of ghost sessions this user has already played
    const playedSessions = await this.ghostRaceRepository
      .createQueryBuilder('race')
      .select('race.ghostSessionId')
      .where('race.racerId = :userId', { userId: excludeUserId })
      .getRawMany();

    const playedSessionIds = playedSessions.map(r => r.race_ghost_session_id);

    const query = this.sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.solves', 'solves')
      .where('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere('session.status = :status', { status: 'completed' })
      .andWhere('session.userId != :excludeUserId', { excludeUserId });

    // Exclude already-played ghost sessions
    if (playedSessionIds.length > 0) {
      query.andWhere('session.id NOT IN (:...playedSessionIds)', { playedSessionIds });
    }

    // If MMR provided, try to find sessions from similar skill players
    if (aroundMmr !== undefined) {
      query.andWhere('session.mmrAtRecording BETWEEN :minMmr AND :maxMmr', {
        minMmr: aroundMmr - 200,
        maxMmr: aroundMmr + 200,
      });
    }

    query.orderBy('RANDOM()').take(1);

    return query.getOne();
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
    const playedSessions = await this.ghostRaceRepository
      .createQueryBuilder('race')
      .select('race.ghostSessionId')
      .where('race.racerId = :racerId', { racerId })
      .getRawMany();

    const playedSessionIds = playedSessions.map(r => r.race_ghost_session_id);

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
    ghostUser: { id: string; username: string };
    isOldGhost: boolean;
  } | null> {
    // Get IDs of ghost sessions the racer has already played
    const playedSessions = await this.ghostRaceRepository
      .createQueryBuilder('race')
      .select('race.ghostSessionId')
      .where('race.racerId = :racerId', { racerId })
      .getRawMany();

    const playedSessionIds = playedSessions.map(r => r.race_ghost_session_id);

    const query = this.sessionRepository
      .createQueryBuilder('session')
      .leftJoinAndSelect('session.solves', 'solves')
      .where('session.userId = :ghostUserId', { ghostUserId })
      .andWhere('session.puzzleSize = :puzzleSize', { puzzleSize })
      .andWhere('session.status = :status', { status: 'completed' });

    if (playedSessionIds.length > 0) {
      query.andWhere('session.id NOT IN (:...playedSessionIds)', { playedSessionIds });
    }

    const ghostSession = await query.orderBy('RANDOM()').take(1).getOne();

    if (!ghostSession) {
      return null;
    }

    const ghostUser = await this.usersService.findById(ghostUserId);
    if (!ghostUser) {
      return null;
    }

    const ghostAge = Date.now() - ghostSession.createdAt.getTime();
    const isOldGhost = ghostAge > GHOST_AGE_LIMIT_MS;

    return {
      ghostSession,
      ghostUser: { id: ghostUser.id, username: ghostUser.username },
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
    ghostUser: { id: string; username: string };
    isOldGhost: boolean;
  } | null> {
    const userStats = await this.usersService.getPuzzleStats(userId, puzzleSize);

    // Try to find a ghost near user's MMR
    let ghostSession = await this.getRandomGhostSession(puzzleSize, userId, userStats.mmr);

    // If no ghost found in range, try without MMR filter
    if (!ghostSession) {
      ghostSession = await this.getRandomGhostSession(puzzleSize, userId);
    }

    if (!ghostSession) {
      return null;
    }

    // Load ghost user info
    const ghostUser = await this.usersService.findById(ghostSession.userId);
    if (!ghostUser) {
      return null;
    }

    // Check if ghost is old (more than 1 week)
    const ghostAge = Date.now() - ghostSession.createdAt.getTime();
    const isOldGhost = ghostAge > GHOST_AGE_LIMIT_MS;

    return {
      ghostSession,
      ghostUser: { id: ghostUser.id, username: ghostUser.username },
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
   * Calculate race result after completing all rounds.
   * The racer ALWAYS gains/loses MMR based on the ghost's MMR at recording time.
   * The ghost creator's MMR is updated separately (only for ghosts < 1 week old).
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

    const userWon = userWins > ghostWins;
    const userStats = await this.usersService.getPuzzleStats(oderId, puzzleSize);
    const mmrBefore = userStats.mmr;

    // Calculate MMR change for racer using ELO formula
    // Racer ALWAYS gains/loses MMR regardless of ghost age
    const expectedScore = 1 / (1 + Math.pow(10, (ghostMmrAtRecording - userStats.mmr) / 400));
    const actualScore = userWon ? 1 : 0;
    const mmrDelta = Math.round(K_FACTOR * (actualScore - expectedScore));

    // Apply MMR change to racer
    const newMmr = Math.max(0, userStats.mmr + mmrDelta);
    await this.usersService.updateMmr(oderId, puzzleSize, newMmr);

    // Update ghost creator's MMR (only if ghost is less than 1 week old)
    if (!isOldGhost && ghostUserId !== oderId) {
      const ghostCreatorStats = await this.usersService.getPuzzleStats(ghostUserId, puzzleSize);
      const ghostExpectedScore = 1 / (1 + Math.pow(10, (userStats.mmr - ghostMmrAtRecording) / 400));
      const ghostActualScore = userWon ? 0 : 1; // Ghost wins if user loses
      const ghostMmrDelta = Math.round(K_FACTOR * (ghostActualScore - ghostExpectedScore));
      const ghostNewMmr = Math.max(0, ghostCreatorStats.mmr + ghostMmrDelta);
      await this.usersService.updateMmr(ghostUserId, puzzleSize, ghostNewMmr);
    }

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
