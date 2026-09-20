import { Injectable } from '@nestjs/common';
import { FriendshipsService } from '../friendships/friendships.service.js';

export type NotificationActor = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type FriendRequestNotification = {
  id: string;
  type: 'FRIEND_REQUEST';
  createdAt: Date;
  actor: NotificationActor;
  friendshipId: string;
};

@Injectable()
export class NotificationsService {
  constructor(private readonly friendshipsService: FriendshipsService) {}

  async listForUser(userId: string): Promise<{
    items: FriendRequestNotification[];
    unreadCount: number;
  }> {
    const { incoming } = await this.friendshipsService.listPending(userId);

    const items: FriendRequestNotification[] = incoming.map((req) => ({
      id: req.id,
      type: 'FRIEND_REQUEST' as const,
      createdAt: req.createdAt,
      actor: req.user,
      friendshipId: req.id,
    }));

    return {
      items,
      unreadCount: items.length,
    };
  }
}
