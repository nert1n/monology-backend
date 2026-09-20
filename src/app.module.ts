import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AchievementsModule } from './achievements/achievements.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { ClubsModule } from './clubs/clubs.module.js';
import { configuration, validateEnv } from './config/index.js';
import { FriendshipsModule } from './friendships/friendships.module.js';
import { HealthModule } from './health/health.module.js';
import { ItemsModule } from './items/items.module.js';
import { MediaModule } from './media/media.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProfileCommentsModule } from './profile-comments/profile-comments.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    ItemsModule,
    MediaModule,
    AchievementsModule,
    FriendshipsModule,
    NotificationsModule,
    ClubsModule,
    ProfileCommentsModule,
  ],
})
export class AppModule {}
