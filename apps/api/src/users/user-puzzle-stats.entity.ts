import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { PuzzleSize, LeagueTier } from '@plus2/shared';
import { User } from './user.entity';

@Entity('user_puzzle_stats')
@Unique(['userId', 'puzzleSize'])
export class UserPuzzleStats {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => User, (user) => user.puzzleStats, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'puzzle_size', type: 'varchar', length: 10 })
  puzzleSize: PuzzleSize;

  @Column({ default: 1000 })
  mmr: number;

  @Column({ type: 'varchar', length: 20, default: 'bronze' })
  league: LeagueTier;

  @Column({ name: 'games_played', default: 0 })
  gamesPlayed: number;

  @Column({ name: 'games_won', default: 0 })
  gamesWon: number;

  @Column({ name: 'solves_completed', default: 0 })
  solvesCompleted: number;

  @Column({ name: 'solves_won', default: 0 })
  solvesWon: number;

  @Column({ name: 'best_time_ms', nullable: true })
  bestTimeMs: number;

  @Column({ name: 'avg_time_ms', nullable: true })
  avgTimeMs: number;

  @Column({ name: 'avg_of_5_ms', nullable: true })
  avgOf5Ms: number;

  @Column({ name: 'avg_of_12_ms', nullable: true })
  avgOf12Ms: number;

  @Column({ name: 'is_provisional', default: true })
  isProvisional: boolean;

  @Column({ name: 'provisional_games_remaining', default: 10 })
  provisionalGamesRemaining: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
