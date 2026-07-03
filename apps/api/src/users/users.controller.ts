import {
  Controller,
  Get,
  Patch,
  Put,
  Param,
  Query,
  Body,
  UseGuards,
  Request,
  Optional,
  Inject,
  forwardRef, Post } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { IsString, MinLength, MaxLength, Matches, IsNumber, IsOptional, IsObject, Min, Max, Length } from 'class-validator';
import { MatchesService } from '../matches/matches.service';
import { SoloService } from '../solo/solo.service';
import type { PuzzleSize, WcaAchievements } from '@plus2/shared';
import { classifyChampionshipAchievements } from './championships.util';

class UpdateUsernameDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;
}

class UpdatePreferencesDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  animationSpeed?: number;

  @IsOptional()
  @IsObject()
  cubeColors?: Record<string, string>;

  // Imgur URL set via POST /users/me/logo, or null to remove. Validated
  // against i.imgur.com in the service.
  @IsOptional()
  cubeLogo?: string | null;
}

class UploadLogoDto {
  @IsString()
  imageBase64: string;
}

class UpdateCountryDto {
  @IsString()
  @Length(2, 2)
  @Matches(/^[A-Z]{2}$/)
  country: string;
}

@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private matchesService: MatchesService,
    @Optional()
    @Inject(forwardRef(() => SoloService))
    private soloService: SoloService,
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: { user: { id: string; isAdmin?: boolean } }) {
    // isAdmin is exposed only to the authenticated self here, never on the public
    // getProfile shape (GET /users/:id). req.user is the full (password-stripped)
    // user loaded by the JWT strategy, so isAdmin is available without a re-query.
    const profile = await this.usersService.getProfile(req.user.id);
    return { ...profile, isAdmin: !!req.user.isAdmin };
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  async updateMe(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdateUsernameDto,
  ) {
    const user = await this.usersService.updateUsername(req.user.id, dto.username);
    return {
      id: user.id,
      username: user.username,
      mmr: user.mmr,
      league: user.league,
    };
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    return this.usersService.getProfile(id);
  }

  @Get(':id/stats')
  async getUserStats(@Param('id') id: string) {
    const profile = await this.usersService.getProfile(id);
    return profile.stats;
  }

  @Get('me/connections')
  @UseGuards(JwtAuthGuard)
  async getMyConnections(@Request() req: { user: { id: string } }) {
    const user = await this.usersService.findById(req.user.id);
    return {
      google: !!user.googleId,
      wca: !!user.wcaOauthId,
      wcaId: user.wcaId || null,
    };
  }

  @Get('me/preferences')
  @UseGuards(JwtAuthGuard)
  async getPreferences(@Request() req: { user: { id: string } }) {
    return this.usersService.getPreferences(req.user.id);
  }

  @Put('me/preferences')
  @UseGuards(JwtAuthGuard)
  async updatePreferences(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.usersService.updatePreferences(req.user.id, dto);
  }

  @Post('me/logo')
  @UseGuards(JwtAuthGuard)
  async uploadLogo(
    @Request() req: { user: { id: string } },
    @Body() dto: UploadLogoDto,
  ) {
    return this.usersService.uploadLogo(req.user.id, dto.imageBase64);
  }

  @Put('me/country')
  @UseGuards(JwtAuthGuard)
  async updateCountry(
    @Request() req: { user: { id: string } },
    @Body() dto: UpdateCountryDto,
  ) {
    return this.usersService.updateCountry(req.user.id, dto.country);
  }

  @Get('profile/:username')
  async getProfileByUsername(@Param('username') username: string) {
    return this.usersService.getProfileByUsername(username);
  }

  // Public WCA records proxy (no auth / no creds needed — the WCA persons API is
  // public). Used to surface official PBs for a linked WCA ID.
  @Get('wca/:wcaId/records')
  async getWcaRecords(@Param('wcaId') wcaId: string) {
    try {
      const res = await fetch(
        `https://www.worldcubeassociation.org/api/v0/persons/${encodeURIComponent(wcaId)}`,
      );
      if (!res.ok) return { wcaId, person: null, personalRecords: null };
      const data = (await res.json()) as { person?: unknown; personal_records?: unknown };
      return { wcaId, person: data.person ?? null, personalRecords: data.personal_records ?? null };
    } catch {
      return { wcaId, person: null, personalRecords: null };
    }
  }

  // Major-championship (World + National) podium/win achievements for a WCA ID,
  // derived from the person's official results × the WCA championships table.
  @Get('wca/:wcaId/championships')
  async getChampionshipAchievements(
    @Param('wcaId') wcaId: string,
  ): Promise<WcaAchievements> {
    const empty: WcaAchievements = { world: null, national: null, recordTier: null, medals: null };
    const id = encodeURIComponent(wcaId);
    const base = 'https://www.worldcubeassociation.org/api/v0/persons';
    try {
      // person -> lifetime medals + ever-held record counts; results -> championship podiums.
      // Cap the upstream WCA calls so a slow/rate-limited WCA never hangs us.
      const signal = AbortSignal.timeout(8000);
      const [personRes, resultsRes] = await Promise.all([
        fetch(`${base}/${id}`, { signal }),
        fetch(`${base}/${id}/results`, { signal }),
      ]);
      const person = personRes.ok
        ? ((await personRes.json()) as {
            medals?: { gold?: number; silver?: number; bronze?: number };
            records?: { world?: number; continental?: number; national?: number };
          })
        : null;
      const resultsJson = resultsRes.ok ? await resultsRes.json() : [];
      const championships = Array.isArray(resultsJson)
        ? classifyChampionshipAchievements(resultsJson)
        : { world: null, national: null };

      // Highest record tier ever held (the WCA `records` counts are exclusive,
      // so checking world -> continental -> national gives the best tier).
      const rec = person?.records;
      const recordTier = rec
        ? rec.world
          ? 'world'
          : rec.continental
            ? 'continental'
            : rec.national
              ? 'national'
              : null
        : null;

      const m = person?.medals;
      const medals = m
        ? { gold: m.gold ?? 0, silver: m.silver ?? 0, bronze: m.bronze ?? 0 }
        : null;

      return { ...championships, recordTier, medals };
    } catch {
      return empty;
    }
  }

  // Coerce a query `page` into a positive integer (default 1); rejects NaN,
  // fractions, zero and negatives.
  private parsePage(page: unknown): number {
    const n = Math.floor(Number(page));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  }

  @Get(':id/matches')
  async getUserMatches(
    @Param('id') id: string,
    @Query('page') page = 1,
  ) {
    return this.matchesService.getUserMatches(id, this.parsePage(page), 20);
  }

  @Get(':id/mmr-history')
  async getMmrHistory(@Param('id') id: string) {
    return this.usersService.getMmrHistory(id);
  }

  @Get(':id/solve-history')
  async getSolveHistory(
    @Param('id') id: string,
    @Query('puzzleSize') puzzleSize?: string,
  ) {
    return this.usersService.getSolveTimeHistory(id, (puzzleSize as PuzzleSize) || '3x3');
  }

  @Get(':id/ghost-recordings')
  async getGhostRecordingCount(@Param('id') id: string) {
    if (!this.soloService) {
      return { count: 0 };
    }
    const count = await this.soloService.getUserGhostRecordingCount(id);
    return { count };
  }

  @Get(':id/ghost-races')
  async getUserGhostRaces(
    @Param('id') id: string,
    @Query('page') page = 1,
  ) {
    if (!this.soloService) {
      return { races: [], total: 0 };
    }

    // To produce the correct combined page sorted by date, fetch the top
    // (page * pageSize) most-recent rows from each source — that's guaranteed to
    // contain the combined page's items — then merge, sort, and slice below.
    const pageNum = this.parsePage(page);
    const pageSize = 20;
    const needed = pageNum * pageSize;

    // Get races where user was the racer
    const { races: asRacer, total: racerTotal } =
      await this.soloService.getUserGhostRaces(id, 1, needed);

    // Get races where user's ghost was used
    const { races: asGhost, total: ghostTotal } =
      await this.soloService.getGhostRacesAgainstUser(id, 1, needed);

    // Combine and format all races
    const allRaces = [
      ...asRacer.map((r) => ({
        id: r.id,
        type: 'ghost' as const,
        role: 'racer' as const,
        puzzleSize: r.puzzleSize,
        opponent: r.ghostUser
          ? { id: r.ghostUser.id, username: r.ghostUser.username }
          : { id: r.ghostUserId, username: 'Unknown' },
        myScore: r.racerScore,
        opponentScore: r.ghostScore,
        won: r.racerWon,
        mmrBefore: r.racerMmrBefore,
        mmrAfter: r.racerMmrAfter,
        isOldGhost: r.isOldGhost,
        createdAt: r.createdAt,
      })),
      ...asGhost.map((r) => ({
        id: r.id,
        type: 'ghost' as const,
        role: 'ghost' as const,
        puzzleSize: r.puzzleSize,
        opponent: r.racer
          ? { id: r.racer.id, username: r.racer.username }
          : { id: r.racerId, username: 'Unknown' },
        myScore: r.ghostScore,
        opponentScore: r.racerScore,
        won: !r.racerWon,
        // Ghost creator's MMR change isn't tracked per-race, so we don't show it
        mmrBefore: null,
        mmrAfter: null,
        isOldGhost: r.isOldGhost,
        createdAt: r.createdAt,
      })),
    ];

    // Sort by date descending
    allRaces.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Paginate
    const start = (pageNum - 1) * pageSize;
    const paginatedRaces = allRaces.slice(start, start + pageSize);

    return {
      races: paginatedRaces,
      total: racerTotal + ghostTotal,
    };
  }

  @Get(':id/available-ghosts')
  @UseGuards(JwtAuthGuard)
  async getAvailableGhostsCount(
    @Param('id') ghostUserId: string,
    @Query('puzzleSize') puzzleSize: PuzzleSize = '3x3',
    @Request() req: { user: { id: string } },
  ) {
    if (!this.soloService) {
      return { count: 0 };
    }
    // Don't count if trying to race against own ghosts
    if (req.user.id === ghostUserId) {
      return { count: 0 };
    }
    const count = await this.soloService.getAvailableGhostCountFromUser(
      req.user.id,
      ghostUserId,
      puzzleSize,
    );
    return { count };
  }
}
