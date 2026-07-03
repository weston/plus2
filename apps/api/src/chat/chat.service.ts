import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ChatMessage } from './chat-message.entity';

export const CHAT_MAX_LENGTH = 280;
export const CHAT_HISTORY_SIZE = 50;

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ChatMessage)
    private chatRepository: Repository<ChatMessage>,
  ) {}

  async saveMessage(userId: string, username: string, country: string | null, text: string): Promise<ChatMessage> {
    const message = this.chatRepository.create({ id: uuidv4(), userId, username, country, text });
    return this.chatRepository.save(message);
  }

  /** Most recent messages, oldest-first (ready to render). */
  async getRecentMessages(limit = CHAT_HISTORY_SIZE): Promise<ChatMessage[]> {
    const rows = await this.chatRepository.find({
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.reverse();
  }
}
