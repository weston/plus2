import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PuzzleSize, LeagueTier } from '@plus2/shared';
import { User } from '../users/user.entity';
import { SoloSession } from './solo-session.entity';

/**
 * Records a completed ghost race between a user and a ghost recording.
 * Used for:
 * - Preventing users from racing the same ghost twice
 * - Displaying ghost races in recent matches
 */
@Entity('ghost_races')
export class GhostRace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The user who raced against the ghost
  @Column({ name: 'racer_id' })
  @Index()
  racerId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'racer_id' })
  racer: User;

  // The ghost session that was raced against
  @Column({ name: 'ghost_session_id' })
  @Index()
  ghostSessionId: string;

  @ManyToOne(() => SoloSession)
  @JoinColumn({ name: 'ghost_session_id' })
  ghostSession: SoloSession;

  // The user who created the ghost recording
  @Column({ name: 'ghost_user_id' })
  @Index()
  ghostUserId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'ghost_user_id' })
  ghostUser: User;

  @Column({ name: 'puzzle_size', type: 'varchar', length: 10 })
  puzzleSize: PuzzleSize;

  // Race results
  @Column({ name: 'racer_score', default: 0 })
  racerScore: number;

  @Column({ name: 'ghost_score', default: 0 })
  ghostScore: number;

  @Column({ name: 'racer_won' })
  racerWon: boolean;

  // MMR changes for the racer
  @Column({ name: 'racer_mmr_before' })
  racerMmrBefore: number;

  @Column({ name: 'racer_mmr_after' })
  racerMmrAfter: number;

  @Column({ name: 'racer_league_after', type: 'varchar', length: 20 })
  racerLeagueAfter: LeagueTier;

  // Ghost's MMR at recording time (for display)
  @Column({ name: 'ghost_mmr_at_recording' })
  ghostMmrAtRecording: number;

  // Whether this was an "old ghost" (>1 week, didn't affect ghost creator's MMR)
  @Column({ name: 'is_old_ghost', default: false })
  isOldGhost: boolean;

  // Store round times for replay/history (JSON array)
  @Column({ name: 'racer_times', type: 'simple-json', nullable: true })
  racerTimes: (number | null)[];

  @Column({ name: 'ghost_times', type: 'simple-json', nullable: true })
  ghostTimes: (number | null)[];

  @CreateDateColumn({ name: 'created_at' })
  @Index()
  createdAt: Date;
}
