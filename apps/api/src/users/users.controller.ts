import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UsersService } from './users.service';
import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

class UpdateUsernameDto {
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_]+$/)
  username: string;
}

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

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
}
