import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TeamsController } from './teams.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TeamsController],
})
export class TeamsModule {}
