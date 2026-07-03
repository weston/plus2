import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

export type ReportStatus = 'pending' | 'confirmed_cheating' | 'clean' | 'dismissed';

/**
 * A cheating report filed by a player against another player's solve(s) —
 * from a live match or a ghost race. Audited manually by admins.
 */
@Entity('reports')
export class Report {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ name: 'reporter_id', type: 'varchar', length: 36 })
  @Index()
  reporterId: string;

  @Column({ name: 'reported_user_id', type: 'varchar', length: 36 })
  @Index()
  reportedUserId: string;

  // What the report is about: a match (replayable move-by-move) or a ghost
  // session (the recorded solves the reporter raced against).
  @Column({ name: 'context_type', type: 'varchar', length: 16 })
  contextType: 'match' | 'ghost';

  @Column({ name: 'match_id', type: 'varchar', length: 36, nullable: true })
  matchId: string | null;

  @Column({ name: 'ghost_session_id', type: 'varchar', length: 36, nullable: true })
  ghostSessionId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  @Index()
  status: ReportStatus;

  @Column({ name: 'reviewed_by', type: 'varchar', length: 36, nullable: true })
  reviewedBy: string | null;

  // `type: Date` lets each driver pick its native type (sqlite: datetime,
  // postgres: timestamp) — a string type here breaks one or the other.
  @Column({ name: 'reviewed_at', type: Date, nullable: true })
  reviewedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
