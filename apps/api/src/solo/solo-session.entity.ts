import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { PuzzleSize, SoloSessionStatus } from '@plus2/shared';
import { User } from '../users/user.entity';
import { SoloSolve } from './solo-solve.entity';

/**
 * A solo recording session - user does 5 solves which are saved for
 * later use as ghost opponents in matchmaking.
 */
@Entity('solo_sessions')
export class SoloSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'puzzle_size', type: 'varchar', length: 10 })
  puzzleSize: PuzzleSize;

  @Column({ type: 'varchar', length: 20, default: 'in_progress' })
  @Index()
  status: SoloSessionStatus;

  @Column({ name: 'total_rounds', default: 5 })
  totalRounds: number;

  @Column({ name: 'completed_rounds', default: 0 })
  completedRounds: number;

  // Average time across all completed solves (for matchmaking ranking)
  @Column({ name: 'average_time_ms', type: 'integer', nullable: true })
  averageTimeMs: number | null;

  // MMR at time of recording (for finding similar skill ghost opponents)
  // Identity of the scramble sequence this session used. Shared across every
  // ghost/match descended from the same original scrambles, so players are
  // never offered scrambles they've already seen.
  @Column({ name: 'scramble_set_id', type: 'varchar', length: 64, nullable: true })
  scrambleSetId: string | null;

  @Column({ name: 'mmr_at_recording', nullable: true })
  mmrAtRecording: number;

  @CreateDateColumn({ name: 'created_at' })
  @Index()
  createdAt: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt: Date;

  @Column({ name: 'ended_at', nullable: true })
  endedAt: Date;

  @OneToMany(() => SoloSolve, (solve) => solve.session)
  solves: SoloSolve[];
}
