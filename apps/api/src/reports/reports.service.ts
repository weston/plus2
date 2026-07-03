import { Injectable, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { Report, ReportStatus } from './report.entity';
import { User } from '../users/user.entity';
import { Match } from '../matches/match.entity';
import { SoloSession } from '../solo/solo-session.entity';

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Report) private reportRepository: Repository<Report>,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Match) private matchRepository: Repository<Match>,
    @InjectRepository(SoloSession) private sessionRepository: Repository<SoloSession>,
  ) {}

  async createReport(
    reporterId: string,
    data: {
      reportedUserId: string;
      contextType: 'match' | 'ghost';
      matchId?: string | null;
      ghostSessionId?: string | null;
      reason?: string | null;
    },
  ): Promise<{ id: string }> {
    if (data.reportedUserId === reporterId) {
      throw new BadRequestException('You cannot report yourself');
    }
    const reported = await this.userRepository.findOne({ where: { id: data.reportedUserId } });
    if (!reported) throw new BadRequestException('Reported player not found');

    // Integrity: the reporter must actually have played the thing they're
    // reporting, and the reported player must be its other party.
    if (data.contextType === 'match') {
      if (!data.matchId) throw new BadRequestException('matchId required');
      const match = await this.matchRepository.findOne({ where: { id: data.matchId } });
      if (!match) throw new BadRequestException('Match not found');
      const pair = [match.player1Id, match.player2Id];
      if (!pair.includes(reporterId) || !pair.includes(data.reportedUserId)) {
        throw new BadRequestException('You can only report your own opponents');
      }
    } else if (data.contextType === 'ghost') {
      if (!data.ghostSessionId) throw new BadRequestException('ghostSessionId required');
      const session = await this.sessionRepository.findOne({ where: { id: data.ghostSessionId } });
      if (!session) throw new BadRequestException('Ghost session not found');
      if (session.userId !== data.reportedUserId) {
        throw new BadRequestException('Session does not belong to the reported player');
      }
    } else {
      throw new BadRequestException('Invalid context');
    }

    // One report per reporter per context; light daily cap against spam.
    const dup = await this.reportRepository.findOne({
      where: data.contextType === 'match'
        ? { reporterId, matchId: data.matchId! }
        : { reporterId, ghostSessionId: data.ghostSessionId! },
    });
    if (dup) throw new BadRequestException('You already reported this');

    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await this.reportRepository
      .createQueryBuilder('r')
      .where('r.reporter_id = :reporterId AND r.created_at > :dayAgo', { reporterId, dayAgo })
      .getCount();
    if (recent >= 10) throw new BadRequestException('Report limit reached — try again tomorrow');

    const report = this.reportRepository.create({
      id: uuidv4(),
      reporterId,
      reportedUserId: data.reportedUserId,
      contextType: data.contextType,
      matchId: data.matchId ?? null,
      ghostSessionId: data.ghostSessionId ?? null,
      reason: (data.reason || '').trim().slice(0, 500) || null,
      status: 'pending',
    });
    await this.reportRepository.save(report);
    return { id: report.id };
  }

  /** Admin view: all reports (optionally by status), newest first, with names. */
  async listReports(status?: ReportStatus) {
    const qb = this.reportRepository
      .createQueryBuilder('r')
      .leftJoin(User, 'reported', 'reported.id = r.reported_user_id')
      .leftJoin(User, 'reporter', 'reporter.id = r.reporter_id')
      .select([
        'r.id AS id',
        'r.context_type AS "contextType"',
        'r.match_id AS "matchId"',
        'r.ghost_session_id AS "ghostSessionId"',
        'r.reason AS reason',
        'r.status AS status',
        'r.created_at AS "createdAt"',
        'r.reported_user_id AS "reportedUserId"',
        'reported.username AS "reportedUsername"',
        'reported.mmr AS "reportedMmr"',
        'r.reporter_id AS "reporterId"',
        'reporter.username AS "reporterUsername"',
      ])
      .orderBy('r.created_at', 'DESC')
      .limit(500);
    if (status) qb.where('r.status = :status', { status });
    return qb.getRawMany();
  }

  async reviewReport(adminId: string, reportId: string, status: ReportStatus) {
    if (!['confirmed_cheating', 'clean', 'dismissed', 'pending'].includes(status)) {
      throw new BadRequestException('Invalid status');
    }
    const report = await this.reportRepository.findOne({ where: { id: reportId } });
    if (!report) throw new BadRequestException('Report not found');
    report.status = status;
    report.reviewedBy = status === 'pending' ? null : adminId;
    report.reviewedAt = status === 'pending' ? null : new Date();
    await this.reportRepository.save(report);
    return { id: report.id, status: report.status };
  }

  async assertAdmin(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user?.isAdmin) throw new ForbiddenException('Admin access required');
  }
}
