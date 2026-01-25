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
export class MatchesController {
  constructor(private matchesService: MatchesService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
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
        player1: m.player1
          ? {
              id: m.player1.id,
              username: m.player1.username,
            }
          : { id: m.player1Id, username: 'Unknown' },
        player2: m.player2
          ? {
              id: m.player2.id,
              username: m.player2.username,
            }
          : { id: m.player2Id, username: 'Unknown' },
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
      player1: match.player1
        ? {
            id: match.player1.id,
            username: match.player1.username,
            mmr: match.player1.mmr,
            league: match.player1.league,
          }
        : { id: match.player1Id, username: 'Unknown', mmr: 0, league: 'bronze' },
      player2: match.player2
        ? {
            id: match.player2.id,
            username: match.player2.username,
            mmr: match.player2.mmr,
            league: match.player2.league,
          }
        : { id: match.player2Id, username: 'Unknown', mmr: 0, league: 'bronze' },
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
        p1Moves: s.p1Moves,
        p1IsWinner: s.p1IsWinner,
        p1Status: s.p1Status,
        p2TimeMs: s.p2TimeMs,
        p2MoveCount: s.p2MoveCount,
        p2Moves: s.p2Moves,
        p2IsWinner: s.p2IsWinner,
        p2Status: s.p2Status,
      })),
    };
  }
}
