import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { KeybindingsService } from './keybindings.service';
import { IsString, IsOptional, IsObject, MaxLength } from 'class-validator';

class CreateProfileDto {
  @IsString()
  @MaxLength(64)
  name: string;

  @IsObject()
  @IsOptional()
  bindings?: Record<string, string>;
}

class UpdateProfileDto {
  @IsString()
  @MaxLength(64)
  @IsOptional()
  name?: string;

  @IsObject()
  @IsOptional()
  bindings?: Record<string, string>;
}

@Controller('keybindings')
@UseGuards(JwtAuthGuard)
export class KeybindingsController {
  constructor(private keybindingsService: KeybindingsService) {}

  @Get()
  async getProfiles(@Request() req: { user: { id: string } }) {
    const profiles = await this.keybindingsService.getProfiles(req.user.id);
    return profiles.map((p) => ({
      id: p.id,
      name: p.name,
      isActive: p.isActive,
      bindings: p.bindings,
    }));
  }

  @Get('active')
  async getActiveProfile(@Request() req: { user: { id: string } }) {
    const profile = await this.keybindingsService.getActiveProfile(req.user.id);
    return {
      id: profile.id,
      name: profile.name,
      isActive: profile.isActive,
      bindings: profile.bindings,
    };
  }

  @Post()
  async createProfile(
    @Request() req: { user: { id: string } },
    @Body() dto: CreateProfileDto,
  ) {
    const profile = await this.keybindingsService.createProfile(
      req.user.id,
      dto.name,
      dto.bindings,
    );
    return {
      id: profile.id,
      name: profile.name,
      isActive: profile.isActive,
      bindings: profile.bindings,
    };
  }

  @Patch(':id')
  async updateProfile(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
  ) {
    const profile = await this.keybindingsService.updateProfile(req.user.id, id, dto);
    return {
      id: profile.id,
      name: profile.name,
      isActive: profile.isActive,
      bindings: profile.bindings,
    };
  }

  @Delete(':id')
  async deleteProfile(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
  ) {
    await this.keybindingsService.deleteProfile(req.user.id, id);
    return { success: true };
  }

  @Post(':id/activate')
  async activateProfile(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
  ) {
    const profile = await this.keybindingsService.activateProfile(req.user.id, id);
    return {
      id: profile.id,
      name: profile.name,
      isActive: profile.isActive,
      bindings: profile.bindings,
    };
  }

  @Post(':id/reset')
  async resetToDefaults(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
  ) {
    const profile = await this.keybindingsService.resetToDefaults(req.user.id, id);
    return {
      id: profile.id,
      name: profile.name,
      isActive: profile.isActive,
      bindings: profile.bindings,
    };
  }
}
