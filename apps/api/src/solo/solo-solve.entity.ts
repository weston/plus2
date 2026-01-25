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
import { SoloSession } from './solo-session.entity';

/**
 * A single solve within a solo recording session.
 * Records the scramble, time, and moves for later replay as a ghost.
 */
@Entity('solo_solves')
@Unique(['sessionId', 'roundNumber'])
export class SoloSolve {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'session_id' })
  sessionId: string;

  @ManyToOne(() => SoloSession, (session) => session.solves, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'session_id' })
  session: SoloSession;

  @Column({ name: 'round_number' })
  roundNumber: number;

  @Column({ type: 'text' })
  scramble: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: 'pending' })
  status: SolveStatus;

  @Column({ name: 'inspection_start_at', nullable: true })
  inspectionStartAt: Date;

  @Column({ name: 'solve_start_at', nullable: true })
  solveStartAt: Date;

  @Column({ name: 'solve_end_at', nullable: true })
  solveEndAt: Date;

  @Column({ name: 'time_ms', type: 'integer', nullable: true })
  timeMs: number | null;

  @Column({ name: 'moves', type: 'simple-json', default: '[]' })
  moves: MoveRecord[];

  @Column({ name: 'move_count', default: 0 })
  moveCount: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
