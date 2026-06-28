import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { LeagueTier } from '@plus2/shared';
import { UserPuzzleStats } from './user-puzzle-stats.entity';
import { KeybindingProfile } from '../keybindings/keybinding-profile.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true, length: 255 })
  @Index()
  email: string;

  @Column({ unique: true, length: 32 })
  @Index()
  username: string;

  // Nullable: OAuth-only accounts (Google SSO) have no password.
  @Column({ name: 'password_hash', length: 255, nullable: true })
  passwordHash: string | null;

  @Column({ default: 1000 })
  @Index()
  mmr: number;

  @Column({ type: 'varchar', length: 20, default: 'bronze' })
  @Index()
  league: LeagueTier;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'last_login_at', nullable: true })
  lastLoginAt: Date;

  @Column({ name: 'oauth_provider', nullable: true, length: 32 })
  oauthProvider: string;

  @Column({ name: 'oauth_id', nullable: true, length: 255 })
  oauthId: string;

  // Linked WCA (World Cube Association) ID, e.g. "2015FOOB01".
  @Column({ name: 'wca_id', nullable: true, length: 20 })
  wcaId: string | null;

  @Column({ nullable: true, length: 2 })
  country: string; // ISO 3166-1 alpha-2 code (e.g., 'US', 'GB', 'JP')

  @OneToMany(() => UserPuzzleStats, (stats) => stats.user)
  puzzleStats: UserPuzzleStats[];

  @OneToMany(() => KeybindingProfile, (profile) => profile.user)
  keybindingProfiles: KeybindingProfile[];

  @Column({ type: 'json', nullable: true })
  preferences: {
    animationSpeed?: number;
    cubeColors?: Record<string, string>;
    // When true, the user's solves are NOT saved as ghosts others can race.
    ghostOptOut?: boolean;
  };
}
