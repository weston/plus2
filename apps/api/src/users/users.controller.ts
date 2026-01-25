import {
  Controller,
  Get,
  Patch,
  Put,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { IsString, MinLength, MaxLength, Matches, IsNumber, IsOptional, IsObject, Min, Max, Length } from 'class-validator';
import { MatchesService } from '../matches/matches.service';

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
  ) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: { user: { id: string } }) {
    return this.usersService.getProfile(req.user.id);
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

  @Get(':id/matches')
  async getUserMatches(
    @Param('id') id: string,
    @Param('page') page: number = 1,
  ) {
    return this.matchesService.getUserMatches(id, page, 20);
  }

  @Get(':id/mmr-history')
  async getMmrHistory(@Param('id') id: string) {
    return this.usersService.getMmrHistory(id);
  }
}
