import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FriendshipsModule } from '../friendships/friendships.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [AuthModule, FriendshipsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
