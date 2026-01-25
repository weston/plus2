import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KeybindingsController } from './keybindings.controller';
import { KeybindingsService } from './keybindings.service';
import { KeybindingProfile } from './keybinding-profile.entity';

@Module({
  imports: [TypeOrmModule.forFeature([KeybindingProfile])],
  controllers: [KeybindingsController],
  providers: [KeybindingsService],
  exports: [KeybindingsService],
})
export class KeybindingsModule {}
