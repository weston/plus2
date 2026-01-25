import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaderboardController } from './leaderboard.controller';
import { LeaderboardService } from './leaderboard.service';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserPuzzleStats])],
  controllers: [LeaderboardController],
  providers: [LeaderboardService],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
