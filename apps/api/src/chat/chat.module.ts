import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatMessage } from './chat-message.entity';
import { ChatService } from './chat.service';

@Module({
  imports: [TypeOrmModule.forFeature([ChatMessage])],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
