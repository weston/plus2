import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    const solve = await this.solveRepository.findOne({
      where: { matchId, roundNumber },
    });

    if (!solve) return;

    const isPlayer1 = match.player1Id === userId;

    // If this is the first move, start the solve timer
    if (isPlayer1) {
      if (solve.p1Status === 'inspecting') {
        solve.p1Status = 'solving';
        solve.p1SolveStartAt = new Date();
      }
      solve.p1Moves.push(move);
      solve.p1MoveCount = solve.p1Moves.length;
    } else {
      if (solve.p2Status === 'inspecting') {
        solve.p2Status = 'solving';
        solve.p2SolveStartAt = new Date();
      }
      solve.p2Moves.push(move);
      solve.p2MoveCount = solve.p2Moves.length;
    }

    await this.solveRepository.save(solve);
  }

  async recordSolveComplete(
    matchId: string,
    roundNumber: number,
    userId: string,
  ): Promise<{
    timeMs: number;
    roundComplete: boolean;
    p1Time: number | null;
    p2Time: number | null;
    winner: 'p1' | 'p2' | 'draw' | null;
    scores: { p1: number; p2: number };
    matchComplete: boolean;
  } | null> {
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
      solve.p1TimeMs = solve.p1SolveStartAt
        ? now.getTime() - solve.p1SolveStartAt.getTime()
        : 0;
    } else {
      solve.p2Status = 'completed';
      solve.p2SolveEndAt = now;
      solve.p2TimeMs = solve.p2SolveStartAt
        ? now.getTime() - solve.p2SolveStartAt.getTime()
        : 0;
    }

    const timeMs = isPlayer1 ? solve.p1TimeMs! : solve.p2TimeMs!;

    // Check if round is complete
    const roundComplete =
      solve.p1Status === 'completed' && solve.p2Status === 'completed';

    if (roundComplete) {
      // Determine winner
      if (solve.p1TimeMs! < solve.p2TimeMs!) {
        solve.p1IsWinner = true;
        solve.p2IsWinner = false;
        match.player1Score += 1;
      } else if (solve.p2TimeMs! < solve.p1TimeMs!) {
        solve.p1IsWinner = false;
        solve.p2IsWinner = true;
        match.player2Score += 1;
      } else {
        // Draw - rare but possible
        solve.p1IsWinner = false;
        solve.p2IsWinner = false;
      }

      await this.matchRepository.save(match);

      // Update solve stats
      await Promise.all([
        this.usersService.incrementSolveStats(
          match.player1Id,
          match.puzzleSize,
          solve.p1IsWinner || false,
          solve.p1TimeMs!,
        ),
        this.usersService.incrementSolveStats(
          match.player2Id,
          match.puzzleSize,
          solve.p2IsWinner || false,
          solve.p2TimeMs!,
        ),
      ]);
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
