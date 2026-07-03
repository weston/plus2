import { Controller, Get, Param, Query } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { PuzzleSize, LeagueTier, PUZZLE_SIZES, LEAGUE_TIERS } from '@plus2/shared';

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private leaderboardService: LeaderboardService) {}

  @Get()
  async getGlobalLeaderboard(
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('league') league?: LeagueTier,
  ) {
    if (league && !LEAGUE_TIERS.includes(league)) {
      league = undefined;
    }

    const { entries, total } = await this.leaderboardService.getGlobalLeaderboard(
      Number(page),
      Math.min(Number(limit), 100),
      league,
    );

    return {
      entries,
      total,
      page: Number(page),
      pageSize: Math.min(Number(limit), 100),
    };
  }

  // A random real recorded solve for the home-page hero cube. Public.
  @Get('showcase')
  async getShowcase() {
    return this.leaderboardService.getShowcaseSolve();
  }

  @Get(':puzzle')
  async getPuzzleLeaderboard(
    @Param('puzzle') puzzle: string,
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('league') league?: LeagueTier,
  ) {
    const puzzleSize = puzzle as PuzzleSize;

    if (!PUZZLE_SIZES.includes(puzzleSize)) {
      return { error: 'Invalid puzzle size' };
    }

    if (league && !LEAGUE_TIERS.includes(league)) {
      league = undefined;
    }

    const { entries, total } = await this.leaderboardService.getPuzzleLeaderboard(
      puzzleSize,
      Number(page),
      Math.min(Number(limit), 100),
      league,
    );

    return {
      entries,
      total,
      page: Number(page),
      pageSize: Math.min(Number(limit), 100),
      puzzleSize,
    };
  }
}
