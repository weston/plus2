import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MatchmakingGateway } from './matchmaking.gateway';
import { MatchmakingService } from './matchmaking.service';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';
import { MatchesModule } from '../matches/matches.module';
import { UsersModule } from '../users/users.module';
import { SoloModule } from '../solo/solo.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserPuzzleStats]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'plus2-secret-change-me'),
      }),
    }),
    forwardRef(() => MatchesModule),
    forwardRef(() => SoloModule),
    forwardRef(() => UsersModule),
    ChatModule,
  ],
  providers: [MatchmakingGateway, MatchmakingService],
  exports: [MatchmakingService],
})
export class MatchmakingModule {}
