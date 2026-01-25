import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';
import { User } from '../users/user.entity';
import { UserPuzzleStats } from '../users/user-puzzle-stats.entity';
import { KeybindingProfile } from '../keybindings/keybinding-profile.entity';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'plus2-secret-change-me'),
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN', '15m'),
        },
      }),
    }),
    TypeOrmModule.forFeature([User, UserPuzzleStats, KeybindingProfile]),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtStrategy, PassportModule],
})
export class AuthModule {}
