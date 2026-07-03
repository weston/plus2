import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './user.entity';
import { UserPuzzleStats } from './user-puzzle-stats.entity';
import { Match } from '../matches/match.entity';
import { Solve } from '../matches/solve.entity';
import { SoloSession } from '../solo/solo-session.entity';
import { SoloSolve } from '../solo/solo-solve.entity';
import { MatchesModule } from '../matches/matches.module';
import { SoloModule } from '../solo/solo.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserPuzzleStats, Match, Solve, SoloSession, SoloSolve]),
    forwardRef(() => MatchesModule),
    forwardRef(() => SoloModule),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
