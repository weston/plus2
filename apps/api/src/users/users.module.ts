import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User } from './user.entity';
import { UserPuzzleStats } from './user-puzzle-stats.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserPuzzleStats])],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
