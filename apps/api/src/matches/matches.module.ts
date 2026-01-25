import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MatchesController } from './matches.controller';
import { MatchesService } from './matches.service';
import { Match } from './match.entity';
import { Solve } from './solve.entity';
import { UsersModule } from '../users/users.module';
import { MatchmakingModule } from '../matchmaking/matchmaking.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Match, Solve]),
    UsersModule,
    forwardRef(() => MatchmakingModule),
  ],
  controllers: [MatchesController],
  providers: [MatchesService],
  exports: [MatchesService],
})
export class MatchesModule {}
