import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MatchesService } from './matches.service';

@Controller('matches')
@UseGuards(JwtAuthGuard)
export class MatchesController {
  constructor(private matchesService: MatchesService) {}

  @Get()
  async getMatches(
    @Request() req: { user: { id: string } },
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    const { matches, total } = await this.matchesService.getUserMatches(
      req.user.id,
      Number(page),
      Number(limit),
    );

    return {
      matches: matches.map((m) => ({
        id: m.id,
        puzzleSize: m.puzzleSize,
        player1: {
          id: m.player1.id,
          username: m.player1.username,
        },
        player2: {
          id: m.player2.id,
          username: m.player2.username,
        },
        player1Score: m.player1Score,
        player2Score: m.player2Score,
        winnerId: m.winnerId,
        status: m.status,
        createdAt: m.createdAt,
        endedAt: m.endedAt,
      })),
      total,
      page: Number(page),
      pageSize: Number(limit),
    };
  }

  @Get(':id')
  async getMatch(@Param('id') id: string) {
    const match = await this.matchesService.getMatchWithSolves(id);

    return {
      id: match.id,
      puzzleSize: match.puzzleSize,
      player1: {
        id: match.player1.id,
        username: match.player1.username,
        mmr: match.player1.mmr,
        league: match.player1.league,
      },
      player2: {
        id: match.player2.id,
        username: match.player2.username,
        mmr: match.player2.mmr,
        league: match.player2.league,
      },
      player1Score: match.player1Score,
      player2Score: match.player2Score,
      player1MmrBefore: match.player1MmrBefore,
      player1MmrAfter: match.player1MmrAfter,
      player2MmrBefore: match.player2MmrBefore,
      player2MmrAfter: match.player2MmrAfter,
      winnerId: match.winnerId,
      status: match.status,
      createdAt: match.createdAt,
      startedAt: match.startedAt,
      endedAt: match.endedAt,
      solves: match.solves?.map((s) => ({
        id: s.id,
        roundNumber: s.roundNumber,
        scramble: s.scramble,
        p1TimeMs: s.p1TimeMs,
        p1MoveCount: s.p1MoveCount,
        p1IsWinner: s.p1IsWinner,
        p2TimeMs: s.p2TimeMs,
        p2MoveCount: s.p2MoveCount,
        p2IsWinner: s.p2IsWinner,
      })),
    };
  }
}
