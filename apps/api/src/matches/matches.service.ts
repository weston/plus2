import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Match } from './match.entity';
import { Solve } from './solve.entity';
import { UsersService } from '../users/users.service';
import {
  PuzzleSize,
  MoveRecord,
  WINS_NEEDED,
  BEST_OF,
  SCRAMBLE_LENGTHS,
  getLeagueFromRating,
} from '@plus2/shared';

// Simple scramble generator (in production, use cubing.js)
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
      // Avoid R L R patterns (same axis)
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
    R: 'L',
    L: 'R',
    U: 'D',
    D: 'U',
    F: 'B',
    B: 'F',
  };
  return opposites[move1] === move2;
}

@Injectable()
export class MatchesService {
  constructor(
    @InjectRepository(Match)
    private matchRepository: Repository<Match>,
    @InjectRepository(Solve)
    private solveRepository: Repository<Solve>,
    private usersService: UsersService,
  ) {}

  // Per-key serialization so concurrent read-modify-write operations on the same
  // match/round (rapid moves, simultaneous solve completions) don't lose updates.
  private locks = new Map<string, Promise<unknown>>();

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(key, run);
    // Clean up once this is the tail of the chain to avoid unbounded growth.
    run.catch(() => {}).finally(() => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    });
    return run;
  }

  // Decide the round winner from both players' terminal states (completed/dnf)
  // and bump the match score. A completed solve beats a DNF; faster time wins
  // when both completed; both-DNF or equal time is a draw (no score change).
  private resolveRoundWinner(solve: Solve, match: Match): void {
    const p1Completed = solve.p1Status === 'completed';
    const p2Completed = solve.p2Status === 'completed';

    if (p1Completed && p2Completed) {
      if (solve.p1TimeMs! < solve.p2TimeMs!) {
        solve.p1IsWinner = true;
        solve.p2IsWinner = false;
        match.player1Score += 1;
      } else if (solve.p2TimeMs! < solve.p1TimeMs!) {
        solve.p1IsWinner = false;
        solve.p2IsWinner = true;
        match.player2Score += 1;
      } else {
        solve.p1IsWinner = false;
        solve.p2IsWinner = false; // draw
      }
    } else if (p1Completed && !p2Completed) {
      solve.p1IsWinner = true;
      solve.p2IsWinner = false;
      match.player1Score += 1;
    } else if (p2Completed && !p1Completed) {
      solve.p1IsWinner = false;
      solve.p2IsWinner = true;
      match.player2Score += 1;
    } else {
      // both DNF — no winner
      solve.p1IsWinner = false;
      solve.p2IsWinner = false;
    }
  }

  async createMatch(
    player1Id: string,
    player2Id: string,
    puzzleSize: PuzzleSize,
  ): Promise<Match> {
    const [p1Stats, p2Stats] = await Promise.all([
      this.usersService.getPuzzleStats(player1Id, puzzleSize),
      this.usersService.getPuzzleStats(player2Id, puzzleSize),
    ]);

    const match = this.matchRepository.create({
      player1Id,
      player2Id,
      puzzleSize,
      bestOf: BEST_OF,
      winsNeeded: WINS_NEEDED,
      status: 'in_progress',
      startedAt: new Date(),
      player1MmrBefore: p1Stats.mmr,
      player2MmrBefore: p2Stats.mmr,
      // The identity of this match's scramble sequence; both players' ghost
      // snapshots inherit it so nobody is ever offered these scrambles twice.
      scrambleSetId: uuidv4(),
    });

    return this.matchRepository.save(match);
  }

  async getMatch(matchId: string): Promise<Match> {
    const match = await this.matchRepository.findOne({
      where: { id: matchId },
      relations: ['player1', 'player2', 'solves'],
    });
    if (!match) {
      throw new NotFoundException('Match not found');
    }
    return match;
  }

  async startRound(matchId: string, roundNumber: number): Promise<Solve> {
    const match = await this.getMatch(matchId);

    const scramble = generateScramble(match.puzzleSize);

    const solve = this.solveRepository.create({
      matchId,
      roundNumber,
      scramble,
      p1Status: 'inspecting',
      p2Status: 'inspecting',
      p1InspectionStartAt: new Date(),
      p2InspectionStartAt: new Date(),
    });

    return this.solveRepository.save(solve);
  }

  async recordMove(
    matchId: string,
    roundNumber: number,
    userId: string,
    move: MoveRecord,
  ): Promise<void> {
    const match = await this.getMatch(matchId);
    const isPlayer1 = match.player1Id === userId;

    // Append the move via a serialized read-modify-write. The columns are
    // `simple-json` (text), so the previous `|| ::jsonb` SQL was invalid on
    // both sqlite and postgres; the per-(match,round,player) lock keeps rapid
    // moves from clobbering each other.
    await this.withLock(`move:${matchId}:${roundNumber}:${isPlayer1 ? 1 : 2}`, async () => {
      const solve = await this.solveRepository.findOne({
        where: { matchId, roundNumber },
      });
      if (!solve) return;

      const now = new Date();
      if (isPlayer1) {
        const moves = Array.isArray(solve.p1Moves) ? solve.p1Moves : [];
        moves.push(move);
        solve.p1Moves = moves;
        solve.p1MoveCount = moves.length;
        solve.p1Status = 'solving';
        if (!solve.p1SolveStartAt) solve.p1SolveStartAt = now;
      } else {
        const moves = Array.isArray(solve.p2Moves) ? solve.p2Moves : [];
        moves.push(move);
        solve.p2Moves = moves;
        solve.p2MoveCount = moves.length;
        solve.p2Status = 'solving';
        if (!solve.p2SolveStartAt) solve.p2SolveStartAt = now;
      }
      await this.solveRepository.save(solve);
    });
  }

  async recordSolveComplete(
    matchId: string,
    roundNumber: number,
    userId: string,
    clientTimeMs?: number | null, // Client-calculated time (player is authority of their own time)
  ): Promise<{
    timeMs: number;
    roundComplete: boolean;
    p1Time: number | null;
    p2Time: number | null;
    winner: 'p1' | 'p2' | 'draw' | null;
    scores: { p1: number; p2: number };
    matchComplete: boolean;
  } | null> {
    // Serialize per match so simultaneous completions (or a completion racing a
    // DNF) can't both read a stale state and leave the round unresolved.
    return this.withLock(`round:${matchId}`, async () => {
      const match = await this.getMatch(matchId);
      const solve = await this.solveRepository.findOne({
        where: { matchId, roundNumber },
      });

      if (!solve) return null;

      const isPlayer1 = match.player1Id === userId;
      const now = new Date();

      if (isPlayer1) {
        solve.p1Status = 'completed';
        solve.p1SolveEndAt = now;
        // Use client-calculated time if provided, otherwise fall back to server calculation
        solve.p1TimeMs = clientTimeMs != null
          ? clientTimeMs
          : (solve.p1SolveStartAt ? now.getTime() - solve.p1SolveStartAt.getTime() : 0);
      } else {
        solve.p2Status = 'completed';
        solve.p2SolveEndAt = now;
        // Use client-calculated time if provided, otherwise fall back to server calculation
        solve.p2TimeMs = clientTimeMs != null
          ? clientTimeMs
          : (solve.p2SolveStartAt ? now.getTime() - solve.p2SolveStartAt.getTime() : 0);
      }

      const timeMs = isPlayer1 ? solve.p1TimeMs! : solve.p2TimeMs!;

      // Round is complete once both players reached a terminal state. This must
      // include the opponent having DNF'd before this completion, otherwise the
      // round would hang forever.
      const roundComplete =
        (solve.p1Status === 'completed' || solve.p1Status === 'dnf') &&
        (solve.p2Status === 'completed' || solve.p2Status === 'dnf');

      if (roundComplete) {
        this.resolveRoundWinner(solve, match);

        await this.matchRepository.save(match);

        // Update solve stats only for players who actually completed (a DNF has
        // a null time, which would corrupt the average).
        const statUpdates: Promise<void>[] = [];
        if (solve.p1Status === 'completed') {
          statUpdates.push(
            this.usersService.incrementSolveStats(
              match.player1Id,
              match.puzzleSize,
              solve.p1IsWinner || false,
              solve.p1TimeMs!,
            ),
          );
        }
        if (solve.p2Status === 'completed') {
          statUpdates.push(
            this.usersService.incrementSolveStats(
              match.player2Id,
              match.puzzleSize,
              solve.p2IsWinner || false,
              solve.p2TimeMs!,
            ),
          );
        }
        await Promise.all(statUpdates);
      }

      await this.solveRepository.save(solve);

      // Check if match is complete
      const matchComplete =
        match.player1Score >= WINS_NEEDED || match.player2Score >= WINS_NEEDED;

      return {
        timeMs,
        roundComplete,
        p1Time: solve.p1TimeMs,
        p2Time: solve.p2TimeMs,
        winner: roundComplete
          ? solve.p1IsWinner
            ? 'p1'
            : solve.p2IsWinner
              ? 'p2'
              : 'draw'
          : null,
        scores: { p1: match.player1Score, p2: match.player2Score },
        matchComplete,
      };
    });
  }

  async completeMatch(matchId: string): Promise<{
    winnerId: string;
    p1Score: number;
    p2Score: number;
    p1MmrDelta: number;
    p1NewMmr: number;
    p1NewLeague: string;
    p2MmrDelta: number;
    p2NewMmr: number;
    p2NewLeague: string;
  }> {
    const match = await this.getMatch(matchId);

    const winnerId =
      match.player1Score >= WINS_NEEDED ? match.player1Id : match.player2Id;

    match.winnerId = winnerId;
    match.status = 'completed';
    match.endedAt = new Date();

    // Update ratings
    const p1Won = match.player1Score >= WINS_NEEDED;

    const [p1Result, p2Result] = await Promise.all([
      this.usersService.updateRatingAfterMatch(
        match.player1Id,
        match.puzzleSize,
        match.player2MmrBefore!,
        p1Won,
      ),
      this.usersService.updateRatingAfterMatch(
        match.player2Id,
        match.puzzleSize,
        match.player1MmrBefore!,
        !p1Won,
      ),
    ]);

    match.player1MmrAfter = p1Result.mmrAfter;
    match.player2MmrAfter = p2Result.mmrAfter;

    await this.matchRepository.save(match);

    return {
      winnerId,
      p1Score: match.player1Score,
      p2Score: match.player2Score,
      p1MmrDelta: p1Result.mmrAfter - p1Result.mmrBefore,
      p1NewMmr: p1Result.mmrAfter,
      p1NewLeague: p1Result.league,
      p2MmrDelta: p2Result.mmrAfter - p2Result.mmrBefore,
      p2NewMmr: p2Result.mmrAfter,
      p2NewLeague: p2Result.league,
    };
  }

  async abandonMatch(matchId: string): Promise<void> {
    await this.matchRepository.update(matchId, {
      status: 'abandoned',
      endedAt: new Date(),
    });
  }

  /**
   * Forfeit a match - the forfeiting player loses, opponent wins by default.
   * All incomplete solves are marked as DNF for the forfeiting player.
   */
  async forfeitMatch(
    matchId: string,
    forfeitingPlayerId: string,
  ): Promise<{
    winnerId: string;
    p1Score: number;
    p2Score: number;
    p1MmrDelta: number;
    p1NewMmr: number;
    p1NewLeague: string;
    p2MmrDelta: number;
    p2NewMmr: number;
    p2NewLeague: string;
  } | null> {
    const match = await this.matchRepository.findOne({
      where: { id: matchId },
      relations: ['solves'],
    });

    if (!match || match.status === 'completed' || match.status === 'forfeited') {
      return null;
    }

    const isPlayer1Forfeiting = match.player1Id === forfeitingPlayerId;
    const winnerId = isPlayer1Forfeiting ? match.player2Id : match.player1Id;

    // Mark all incomplete solves as DNF for the forfeiting player
    for (const solve of match.solves || []) {
      if (isPlayer1Forfeiting) {
        if (solve.p1Status !== 'completed') {
          solve.p1Status = 'dnf';
          solve.p1TimeMs = null;
          solve.p1IsWinner = false;
          solve.p2IsWinner = true;
        }
      } else {
        if (solve.p2Status !== 'completed') {
          solve.p2Status = 'dnf';
          solve.p2TimeMs = null;
          solve.p2IsWinner = false;
          solve.p1IsWinner = true;
        }
      }
      await this.solveRepository.save(solve);
    }

    // Set winner's score to wins needed
    match.winnerId = winnerId;
    match.status = 'forfeited';
    match.endedAt = new Date();

    if (isPlayer1Forfeiting) {
      match.player2Score = WINS_NEEDED;
    } else {
      match.player1Score = WINS_NEEDED;
    }

    // Update ratings - forfeiting player gets a loss
    const p1Won = !isPlayer1Forfeiting;

    const [p1Result, p2Result] = await Promise.all([
      this.usersService.updateRatingAfterMatch(
        match.player1Id,
        match.puzzleSize,
        match.player2MmrBefore!,
        p1Won,
      ),
      this.usersService.updateRatingAfterMatch(
        match.player2Id,
        match.puzzleSize,
        match.player1MmrBefore!,
        !p1Won,
      ),
    ]);

    match.player1MmrAfter = p1Result.mmrAfter;
    match.player2MmrAfter = p2Result.mmrAfter;

    await this.matchRepository.save(match);

    return {
      winnerId,
      p1Score: match.player1Score,
      p2Score: match.player2Score,
      p1MmrDelta: p1Result.mmrAfter - p1Result.mmrBefore,
      p1NewMmr: p1Result.mmrAfter,
      p1NewLeague: p1Result.league,
      p2MmrDelta: p2Result.mmrAfter - p2Result.mmrBefore,
      p2NewMmr: p2Result.mmrAfter,
      p2NewLeague: p2Result.league,
    };
  }

  /**
   * Mark a player's solve as DNF (timeout or other reason)
   */
  async recordDNF(
    matchId: string,
    roundNumber: number,
    userId: string,
  ): Promise<{
    roundComplete: boolean;
    p1Time: number | null;
    p2Time: number | null;
    winner: 'p1' | 'p2' | 'draw' | null;
    scores: { p1: number; p2: number };
    matchComplete: boolean;
  } | null> {
    return this.withLock(`round:${matchId}`, async () => {
      const match = await this.getMatch(matchId);
      const solve = await this.solveRepository.findOne({
        where: { matchId, roundNumber },
      });

      if (!solve) return null;

      const isPlayer1 = match.player1Id === userId;

      if (isPlayer1) {
        solve.p1Status = 'dnf';
        solve.p1TimeMs = null;
      } else {
        solve.p2Status = 'dnf';
        solve.p2TimeMs = null;
      }

      // Check if round is complete
      const roundComplete =
        (solve.p1Status === 'completed' || solve.p1Status === 'dnf') &&
        (solve.p2Status === 'completed' || solve.p2Status === 'dnf');

      if (roundComplete) {
        this.resolveRoundWinner(solve, match);
        await this.matchRepository.save(match);
      }

      await this.solveRepository.save(solve);

      const matchComplete =
        match.player1Score >= WINS_NEEDED || match.player2Score >= WINS_NEEDED;

      return {
        roundComplete,
        p1Time: solve.p1TimeMs,
        p2Time: solve.p2TimeMs,
        winner: roundComplete
          ? solve.p1IsWinner
            ? 'p1'
            : solve.p2IsWinner
              ? 'p2'
              : 'draw'
          : null,
        scores: { p1: match.player1Score, p2: match.player2Score },
        matchComplete,
      };
    });
  }

  async getUserMatches(
    userId: string,
    page = 1,
    limit = 20,
  ): Promise<{ matches: Match[]; total: number }> {
    const [matches, total] = await this.matchRepository.findAndCount({
      where: [{ player1Id: userId }, { player2Id: userId }],
      relations: ['player1', 'player2'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { matches, total };
  }

  async getMatchWithSolves(matchId: string): Promise<Match> {
    const match = await this.matchRepository.findOne({
      where: { id: matchId },
      relations: ['player1', 'player2', 'solves'],
    });

    if (!match) {
      throw new NotFoundException('Match not found');
    }

    return match;
  }
}
