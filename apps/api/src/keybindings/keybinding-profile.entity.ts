import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../users/user.entity';

@Entity('keybinding_profiles')
export class KeybindingProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => User, (user) => user.keybindingProfiles, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ length: 64, default: 'Default' })
  name: string;

  @Column({ name: 'is_active', default: false })
  isActive: boolean;

  @Column({ type: 'simple-json', default: '{}' })
  bindings: Record<string, string>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
