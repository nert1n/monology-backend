import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FriendshipStatus } from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';

export type FriendUserSummary = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type FriendshipRequestView = {
  id: string;
  status: FriendshipStatus;
  createdAt: Date;
  direction: 'incoming' | 'outgoing';
  user: FriendUserSummary;
};

function toFriendSummary(user: {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}): FriendUserSummary {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

@Injectable()
export class FriendshipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async listFriends(
    username: string,
    viewerUserId?: string | null,
  ): Promise<{ count: number; items: FriendUserSummary[] }> {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );

    const rows = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.ACCEPTED,
        OR: [{ requesterId: user.id }, { addresseeId: user.id }],
      },
      include: {
        requester: true,
        addressee: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const items = rows.map((row) =>
      toFriendSummary(
        row.requesterId === user.id ? row.addressee : row.requester,
      ),
    );

    return { count: items.length, items };
  }

  async listPending(userId: string): Promise<{
    incoming: FriendshipRequestView[];
    outgoing: FriendshipRequestView[];
  }> {
    const rows = await this.prisma.friendship.findMany({
      where: {
        status: FriendshipStatus.PENDING,
        OR: [{ requesterId: userId }, { addresseeId: userId }],
      },
      include: {
        requester: true,
        addressee: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const incoming: FriendshipRequestView[] = [];
    const outgoing: FriendshipRequestView[] = [];

    for (const row of rows) {
      if (row.addresseeId === userId) {
        incoming.push({
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          direction: 'incoming',
          user: toFriendSummary(row.requester),
        });
      } else {
        outgoing.push({
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          direction: 'outgoing',
          user: toFriendSummary(row.addressee),
        });
      }
    }

    return { incoming, outgoing };
  }

  async getRelation(viewerUserId: string, username: string) {
    const other = await this.usersService.findByUsernameOrThrow(username);
    if (other.id === viewerUserId) {
      return { status: 'self' as const, friendshipId: null };
    }

    const friendship = await this.findBetween(viewerUserId, other.id);
    if (!friendship) {
      return { status: 'none' as const, friendshipId: null };
    }

    if (friendship.status === FriendshipStatus.ACCEPTED) {
      return { status: 'friends' as const, friendshipId: friendship.id };
    }

    if (friendship.requesterId === viewerUserId) {
      return {
        status: 'outgoing' as const,
        friendshipId: friendship.id,
      };
    }

    return {
      status: 'incoming' as const,
      friendshipId: friendship.id,
    };
  }

  async sendRequest(requesterId: string, username: string) {
    // Respect hidden profiles: outsiders cannot send requests.
    const addressee = await this.usersService.assertProfileVisibleToViewer(
      username,
      requesterId,
    );
    if (addressee.id === requesterId) {
      throw new BadRequestException('Cannot friend yourself');
    }

    const existing = await this.findBetween(requesterId, addressee.id);
    if (existing) {
      if (existing.status === FriendshipStatus.ACCEPTED) {
        throw new ConflictException('Already friends');
      }
      if (existing.requesterId === requesterId) {
        throw new ConflictException('Friend request already sent');
      }
      // Incoming pending → accept instead of creating a duplicate.
      return this.acceptRequest(requesterId, existing.id);
    }

    const friendship = await this.prisma.friendship.create({
      data: {
        requesterId,
        addresseeId: addressee.id,
        status: FriendshipStatus.PENDING,
      },
      include: {
        requester: true,
        addressee: true,
      },
    });

    return {
      id: friendship.id,
      status: friendship.status,
      user: toFriendSummary(friendship.addressee),
    };
  }

  async acceptRequest(userId: string, friendshipId: string) {
    const friendship = await this.requireFriendship(friendshipId);
    if (friendship.addresseeId !== userId) {
      throw new ForbiddenException('Only the recipient can accept');
    }
    if (friendship.status !== FriendshipStatus.PENDING) {
      throw new BadRequestException('Request is not pending');
    }

    const updated = await this.prisma.friendship.update({
      where: { id: friendshipId },
      data: { status: FriendshipStatus.ACCEPTED },
      include: { requester: true, addressee: true },
    });

    return {
      id: updated.id,
      status: updated.status,
      user: toFriendSummary(updated.requester),
    };
  }

  async declineRequest(userId: string, friendshipId: string) {
    const friendship = await this.requireFriendship(friendshipId);
    if (friendship.addresseeId !== userId) {
      throw new ForbiddenException('Only the recipient can decline');
    }
    if (friendship.status !== FriendshipStatus.PENDING) {
      throw new BadRequestException('Request is not pending');
    }

    await this.prisma.friendship.delete({ where: { id: friendshipId } });
    return { ok: true };
  }

  async cancelRequest(userId: string, friendshipId: string) {
    const friendship = await this.requireFriendship(friendshipId);
    if (friendship.requesterId !== userId) {
      throw new ForbiddenException('Only the sender can cancel');
    }
    if (friendship.status !== FriendshipStatus.PENDING) {
      throw new BadRequestException('Request is not pending');
    }

    await this.prisma.friendship.delete({ where: { id: friendshipId } });
    return { ok: true };
  }

  async removeFriend(userId: string, username: string) {
    const other = await this.usersService.findByUsernameOrThrow(username);
    const friendship = await this.findBetween(userId, other.id);
    if (!friendship || friendship.status !== FriendshipStatus.ACCEPTED) {
      throw new NotFoundException('Friendship not found');
    }

    await this.prisma.friendship.delete({ where: { id: friendship.id } });
    return { ok: true };
  }

  private async findBetween(userA: string, userB: string) {
    return this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: userA, addresseeId: userB },
          { requesterId: userB, addresseeId: userA },
        ],
      },
    });
  }

  private async requireFriendship(id: string) {
    const friendship = await this.prisma.friendship.findUnique({
      where: { id },
    });
    if (!friendship) {
      throw new NotFoundException('Friendship not found');
    }
    return friendship;
  }
}
