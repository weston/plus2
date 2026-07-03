import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Request,
  Optional,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MatchesService } from './matches.service';
import { SoloService } from '../solo/solo.service';

@Controller('matches')
export class MatchesController {
  constructor(
    private matchesService: MatchesService,
    @Optional()
    @Inject(forwardRef(() => SoloService))
    private soloService: SoloService,
  ) {}

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

  @Get('ghost-races')
  @UseGuards(JwtAuthGuard)
  async getGhostRaces(
    @Request() req: { user: { id: string } },
    @Query('page') page = 1,
    @Query('limit') limit = 20,
  ) {
    if (!this.soloService) {
      return { races: [], total: 0, page: Number(page), pageSize: Number(limit) };
    }

    const { races, total } = await this.soloService.getUserGhostRaces(
      req.user.id,
      Number(page),
      Number(limit),
    );

    return {
      races: races.map((r) => ({
        id: r.id,
        type: 'ghost',
        puzzleSize: r.puzzleSize,
        ghostUser: r.ghostUser
          ? { id: r.ghostUser.id, username: r.ghostUser.username }
          : { id: r.ghostUserId, username: 'Unknown' },
        racerScore: r.racerScore,
        ghostScore: r.ghostScore,
        racerWon: r.racerWon,
        racerMmrBefore: r.racerMmrBefore,
        racerMmrAfter: r.racerMmrAfter,
        ghostMmrAtRecording: r.ghostMmrAtRecording,
        isOldGhost: r.isOldGhost,
        createdAt: r.createdAt,
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
            cubeColors: match.player1.preferences?.cubeColors ?? null,
            cubeLogo: match.player1.preferences?.cubeLogo ?? null,
          }
        : { id: match.player1Id, username: 'Unknown', mmr: 0, league: 'bronze', cubeColors: null, cubeLogo: null },
      player2: match.player2
        ? {
            id: match.player2.id,
            username: match.player2.username,
            mmr: match.player2.mmr,
            league: match.player2.league,
            cubeColors: match.player2.preferences?.cubeColors ?? null,
            cubeLogo: match.player2.preferences?.cubeLogo ?? null,
          }
        : { id: match.player2Id, username: 'Unknown', mmr: 0, league: 'bronze', cubeColors: null, cubeLogo: null },
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
