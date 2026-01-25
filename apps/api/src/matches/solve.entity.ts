import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { SolveStatus, MoveRecord } from '@plus2/shared';
import { Match } from './match.entity';

@Entity('solves')
@Unique(['matchId', 'roundNumber'])
export class Solve {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'match_id' })
  matchId: string;

  @ManyToOne(() => Match, (match) => match.solves, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'match_id' })
  match: Match;

  @Column({ name: 'round_number' })
  roundNumber: number;

  @Column({ type: 'text' })
  scramble: string;

  // Player 1 solve data
  @Column({ name: 'p1_status', type: 'varchar', length: 20, default: 'pending' })
  p1Status: SolveStatus;

  @Column({ name: 'p1_inspection_start_at', nullable: true })
  p1InspectionStartAt: Date;

  @Column({ name: 'p1_solve_start_at', nullable: true })
  p1SolveStartAt: Date;

  @Column({ name: 'p1_solve_end_at', nullable: true })
  p1SolveEndAt: Date;

  @Column({ name: 'p1_time_ms', type: 'integer', nullable: true })
  p1TimeMs: number | null;

  @Column({ name: 'p1_moves', type: 'simple-json', default: '[]' })
  p1Moves: MoveRecord[];

  @Column({ name: 'p1_move_count', default: 0 })
  p1MoveCount: number;

  @Column({ name: 'p1_is_winner', nullable: true })
  p1IsWinner: boolean;

  @Column({ name: 'p1_penalty_ms', default: 0 })
  p1PenaltyMs: number;

  // Player 2 solve data
  @Column({ name: 'p2_status', type: 'varchar', length: 20, default: 'pending' })
  p2Status: SolveStatus;

  @Column({ name: 'p2_inspection_start_at', nullable: true })
  p2InspectionStartAt: Date;

  @Column({ name: 'p2_solve_start_at', nullable: true })
  p2SolveStartAt: Date;

  @Column({ name: 'p2_solve_end_at', nullable: true })
  p2SolveEndAt: Date;

  @Column({ name: 'p2_time_ms', type: 'integer', nullable: true })
  p2TimeMs: number | null;

  @Column({ name: 'p2_moves', type: 'simple-json', default: '[]' })
  p2Moves: MoveRecord[];

  @Column({ name: 'p2_move_count', default: 0 })
  p2MoveCount: number;

  @Column({ name: 'p2_is_winner', nullable: true })
  p2IsWinner: boolean;

  @Column({ name: 'p2_penalty_ms', default: 0 })
  p2PenaltyMs: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
