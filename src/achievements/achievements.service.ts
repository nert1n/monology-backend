import { Injectable, OnModuleInit } from '@nestjs/common';
import { FriendshipStatus } from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import { ACHIEVEMENT_DEFINITIONS } from './achievements.definitions.js';

export type AchievementView = {
  id: string;
  code: string;
  title: string;
  description: string;
  sortOrder: number;
  unlocked: boolean;
  unlockedAt: Date | null;
};

@Injectable()
export class AchievementsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async onModuleInit() {
    await this.ensureDefinitions();
  }

  async ensureDefinitions() {
    for (const def of ACHIEVEMENT_DEFINITIONS) {
      await this.prisma.achievement.upsert({
        where: { code: def.code },
        create: {
          code: def.code,
          title: def.title,
          description: def.description,
          sortOrder: def.sortOrder,
        },
        update: {
          title: def.title,
          description: def.description,
          sortOrder: def.sortOrder,
        },
      });
    }
  }

  async listForUsername(
    username: string,
    viewerUserId?: string | null,
  ): Promise<{ items: AchievementView[]; unlockedCount: number }> {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );

    await this.computeAndUnlock(user.id);

    const achievements = await this.prisma.achievement.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        unlocks: {
          where: { userId: user.id },
          take: 1,
        },
      },
    });

    const items: AchievementView[] = achievements.map((a) => {
      const unlock = a.unlocks[0] ?? null;
      return {
        id: a.id,
        code: a.code,
        title: a.title,
        description: a.description,
        sortOrder: a.sortOrder,
        unlocked: Boolean(unlock),
        unlockedAt: unlock?.unlockedAt ?? null,
      };
    });

    return {
      items,
      unlockedCount: items.filter((i) => i.unlocked).length,
    };
  }

  /** Compute-on-read: evaluate criteria and persist any new unlocks. */
  async computeAndUnlock(userId: string) {
    await this.ensureDefinitions();

    const [user, itemCount, friendCount, clubCount, defs] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.prisma.item.count({ where: { category: { userId } } }),
      this.prisma.friendship.count({
        where: {
          status: FriendshipStatus.ACCEPTED,
          OR: [{ requesterId: userId }, { addresseeId: userId }],
        },
      }),
      this.prisma.clubMember.count({ where: { userId } }),
      this.prisma.achievement.findMany(),
    ]);

    const earnedCodes = new Set<string>();
    if (itemCount >= 1) earnedCodes.add('first_item');
    if (itemCount >= 10) earnedCodes.add('items_10');
    if (itemCount >= 50) earnedCodes.add('items_50');
    if (
      user.displayName.trim().length > 0 &&
      user.bio.trim().length > 0 &&
      Boolean(user.avatarUrl)
    ) {
      earnedCodes.add('profile_complete');
    }
    if (friendCount >= 1) earnedCodes.add('first_friend');
    if (clubCount >= 1) earnedCodes.add('club_member');

    const byCode = new Map(defs.map((d) => [d.code, d]));
    for (const code of earnedCodes) {
      const achievement = byCode.get(code);
      if (!achievement) continue;
      await this.prisma.userAchievement.upsert({
        where: {
          userId_achievementId: {
            userId,
            achievementId: achievement.id,
          },
        },
        create: {
          userId,
          achievementId: achievement.id,
        },
        update: {},
      });
    }
  }
}
