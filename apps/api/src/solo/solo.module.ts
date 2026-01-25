import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SoloService } from './solo.service';
import { SoloSession } from './solo-session.entity';
import { SoloSolve } from './solo-solve.entity';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SoloSession, SoloSolve]),
    forwardRef(() => UsersModule),
  ],
  providers: [SoloService],
  exports: [SoloService],
})
export class SoloModule {}
