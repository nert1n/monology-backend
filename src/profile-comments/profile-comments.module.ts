import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { ProfileCommentsController } from './profile-comments.controller.js';
import { ProfileCommentsService } from './profile-comments.service.js';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [ProfileCommentsController],
  providers: [ProfileCommentsService],
  exports: [ProfileCommentsService],
})
export class ProfileCommentsModule {}
