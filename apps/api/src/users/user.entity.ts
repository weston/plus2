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

  // Nullable: OAuth-only accounts (Google SSO) have no password. Explicit `type`
  // is required because the `string | null` TS type reflects as `Object`.
  @Column({ name: 'password_hash', type: 'varchar', length: 255, nullable: true })
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

  // Legacy single-provider fields (kept for back-compat / first OAuth users).
  @Column({ name: 'oauth_provider', nullable: true, length: 32 })
  oauthProvider: string;

  @Column({ name: 'oauth_id', nullable: true, length: 255 })
  oauthId: string;

  // Per-provider identity links — an account can have BOTH, so signing in with
  // either resolves to the same account.
  // (unique index allows multiple NULLs on both postgres and sqlite)
  @Column({ name: 'google_id', type: 'varchar', nullable: true, length: 255 })
  @Index({ unique: true })
  googleId: string | null;

  @Column({ name: 'wca_oauth_id', type: 'varchar', nullable: true, length: 255 })
  @Index({ unique: true })
  wcaOauthId: string | null;

  // Linked WCA (World Cube Association) ID, e.g. "2015FOOB01" (for display).
  @Column({ name: 'wca_id', type: 'varchar', nullable: true, length: 20 })
  wcaId: string | null;

  @Column({ nullable: true, length: 2 })
  country: string; // ISO 3166-1 alpha-2 code (e.g., 'US', 'GB', 'JP')

  @OneToMany(() => UserPuzzleStats, (stats) => stats.user)
  puzzleStats: UserPuzzleStats[];

  @OneToMany(() => KeybindingProfile, (profile) => profile.user)
  keybindingProfiles: KeybindingProfile[];

  @Column({ name: 'is_admin', type: 'boolean', default: false })
  isAdmin: boolean;

  // Bumped on logout to revoke all outstanding refresh tokens (the refresh token
  // embeds this as the `tv` claim).
  @Column({ name: 'token_version', type: 'int', default: 0 })
  tokenVersion: number;

  @Column({ type: 'json', nullable: true })
  preferences: {
    animationSpeed?: number;
    cubeColors?: Record<string, string>;
    cubeLogo?: string | null;
  };
}
