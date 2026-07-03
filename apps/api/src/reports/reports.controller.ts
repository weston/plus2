import { Controller, Post, Get, Patch, Body, Param, Query, Request, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { ReportStatus } from './report.entity';

class CreateReportDto {
  @IsUUID()
  reportedUserId: string;

  @IsIn(['match', 'ghost'])
  contextType: 'match' | 'ghost';

  @IsOptional()
  @IsUUID()
  matchId?: string;

  @IsOptional()
  @IsUUID()
  ghostSessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ReviewReportDto {
  @IsIn(['pending', 'confirmed_cheating', 'clean', 'dismissed'])
  status: ReportStatus;
}

@Controller('reports')
export class ReportsController {
  constructor(private reportsService: ReportsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Request() req: { user: { id: string } }, @Body() dto: CreateReportDto) {
    return this.reportsService.createReport(req.user.id, dto);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard)
  async list(
    @Request() req: { user: { id: string } },
    @Query('status') status?: ReportStatus,
  ) {
    await this.reportsService.assertAdmin(req.user.id);
    return { reports: await this.reportsService.listReports(status || undefined) };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async review(
    @Request() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() dto: ReviewReportDto,
  ) {
    await this.reportsService.assertAdmin(req.user.id);
    return this.reportsService.reviewReport(req.user.id, id, dto.status);
  }
}
