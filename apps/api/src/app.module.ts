import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { MatchmakingModule } from './matchmaking/matchmaking.module';
import { MatchesModule } from './matches/matches.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { KeybindingsModule } from './keybindings/keybindings.module';
import { HealthModule } from './health/health.module';
import { SoloModule } from './solo/solo.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbType = configService.get<string>('DB_TYPE', 'sqlite');
        const isProd = configService.get('NODE_ENV') === 'production';

        if (dbType === 'sqlite') {
          return {
            type: 'better-sqlite3' as const,
            database: configService.get<string>('DB_DATABASE') || 'plus2.db',
            entities: [__dirname + '/**/*.entity{.ts,.js}'],
            migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
            migrationsRun: true, // Auto-run migrations on startup
            synchronize: true,
            logging: configService.get('NODE_ENV') === 'development',
          };
        }

        return {
          type: 'postgres' as const,
          host: configService.get<string>('DB_HOST') || 'localhost',
          port: configService.get<number>('DB_PORT') || 5432,
          username: configService.get<string>('DB_USERNAME') || 'postgres',
          password: configService.get<string>('DB_PASSWORD') || 'postgres',
          database: configService.get<string>('DB_DATABASE') || 'plus2',
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          migrationsRun: true, // Auto-run migrations on startup
          synchronize: !isProd,
          logging: !isProd,
        };
      },
    }),
    AuthModule,
    UsersModule,
    MatchmakingModule,
    MatchesModule,
    LeaderboardModule,
    KeybindingsModule,
    HealthModule,
    SoloModule,
  ],
})
export class AppModule {}
