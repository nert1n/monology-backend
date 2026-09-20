import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { FriendshipsController } from './friendships.controller.js';
import { FriendshipsService } from './friendships.service.js';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [FriendshipsController],
  providers: [FriendshipsService],
  exports: [FriendshipsService],
})
export class FriendshipsModule {}
