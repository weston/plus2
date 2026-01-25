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
import { PuzzleSize, MatchStatus } from '@plus2/shared';
import { User } from '../users/user.entity';
import { Solve } from './solve.entity';

@Entity('matches')
export class Match {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'puzzle_size', type: 'varchar', length: 10 })
  puzzleSize: PuzzleSize;

  @Column({ name: 'player1_id' })
  player1Id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'player1_id' })
  player1: User;

  @Column({ name: 'player2_id' })
  player2Id: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'player2_id' })
  player2: User;

  @Column({ name: 'player1_score', default: 0 })
  player1Score: number;

  @Column({ name: 'player2_score', default: 0 })
  player2Score: number;

  @Column({ name: 'winner_id', nullable: true })
  winnerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'winner_id' })
  winner: User;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index()
  status: MatchStatus;

  @Column({ name: 'best_of', default: 5 })
  bestOf: number;

  @Column({ name: 'wins_needed', default: 3 })
  winsNeeded: number;

  @CreateDateColumn({ name: 'created_at' })
  @Index()
  createdAt: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt: Date;

  @Column({ name: 'ended_at', nullable: true })
  endedAt: Date;

  @Column({ name: 'player1_mmr_before', nullable: true })
  player1MmrBefore: number;

  @Column({ name: 'player1_mmr_after', nullable: true })
  player1MmrAfter: number;

  @Column({ name: 'player2_mmr_before', nullable: true })
  player2MmrBefore: number;

  @Column({ name: 'player2_mmr_after', nullable: true })
  player2MmrAfter: number;

  @OneToMany(() => Solve, (solve) => solve.match)
  solves: Solve[];

  // Current round being played (transient, not stored)
  currentRound?: number;
}
