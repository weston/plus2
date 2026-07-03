import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Report } from './report.entity';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { User } from '../users/user.entity';
import { Match } from '../matches/match.entity';
import { SoloSession } from '../solo/solo-session.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Report, User, Match, SoloSession])],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
