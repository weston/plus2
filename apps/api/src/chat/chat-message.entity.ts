import { Entity, PrimaryColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Global chat message. Username/country are snapshotted at send time so
 * rendering history needs no joins.
 */
@Entity('chat_messages')
export class ChatMessage {
  // Generated app-side (see ChatService) so no DB default is required —
  // keeps sqlite (dev) and postgres (prod) behavior identical.
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @Column({ type: 'varchar', length: 50 })
  username: string;

  @Column({ type: 'varchar', length: 8, nullable: true })
  country: string | null;

  @Column({ type: 'varchar', length: 280 })
  text: string;

  @CreateDateColumn({ name: 'created_at' })
  @Index()
  createdAt: Date;
}
