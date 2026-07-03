import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KeybindingProfile } from './keybinding-profile.entity';
import { DEFAULT_KEYBINDINGS } from '@plus2/shared';

@Injectable()
export class KeybindingsService {
  constructor(
    @InjectRepository(KeybindingProfile)
    private profileRepository: Repository<KeybindingProfile>,
  ) {}

  async getProfiles(userId: string): Promise<KeybindingProfile[]> {
    return this.profileRepository.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
  }

  async getActiveProfile(userId: string): Promise<KeybindingProfile> {
    const profile = await this.profileRepository.findOne({
      where: { userId, isActive: true },
    });
    if (!profile) {
      throw new NotFoundException('No active keybinding profile found');
    }
    return profile;
  }

  async createProfile(
    userId: string,
    name: string,
    bindings?: Record<string, string>,
  ): Promise<KeybindingProfile> {
    const profile = this.profileRepository.create({
      userId,
      name,
      bindings: bindings || DEFAULT_KEYBINDINGS,
      isActive: false,
    });
    return this.profileRepository.save(profile);
  }

  async updateProfile(
    userId: string,
    profileId: string,
    updates: { name?: string; bindings?: Record<string, string> },
  ): Promise<KeybindingProfile> {
    const profile = await this.profileRepository.findOne({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    // `bindings` is a key -> move map. Multiple keys legitimately map to the
    // same move (e.g. two keys for one rotation), and keys are unique by object
    // construction — so there is nothing to reject. The previous check compared
    // the move VALUES for duplicates and thus rejected every default-derived
    // profile with "Duplicate key bindings detected".

    if (updates.name) profile.name = updates.name;
    if (updates.bindings) profile.bindings = updates.bindings;

    return this.profileRepository.save(profile);
  }

  async deleteProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.profileRepository.findOne({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    if (profile.isActive) {
      throw new BadRequestException('Cannot delete active profile');
    }
    await this.profileRepository.remove(profile);
  }

  async activateProfile(userId: string, profileId: string): Promise<KeybindingProfile> {
    const profile = await this.profileRepository.findOne({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }

    // Deactivate all other profiles
    await this.profileRepository.update({ userId }, { isActive: false });

    // Activate this one
    profile.isActive = true;
    return this.profileRepository.save(profile);
  }

  async resetToDefaults(userId: string, profileId: string): Promise<KeybindingProfile> {
    const profile = await this.profileRepository.findOne({
      where: { id: profileId, userId },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    profile.bindings = DEFAULT_KEYBINDINGS;
    return this.profileRepository.save(profile);
  }
}
