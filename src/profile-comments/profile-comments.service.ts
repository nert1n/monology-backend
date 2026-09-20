import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateProfileCommentDto } from './dto/create-profile-comment.dto.js';

export type ProfileCommentView = {
  id: string;
  body: string;
  createdAt: Date;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
  };
};

@Injectable()
export class ProfileCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async listForUsername(
    username: string,
    viewerUserId?: string | null,
  ): Promise<{ items: ProfileCommentView[] }> {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );

    const comments = await this.prisma.profileComment.findMany({
      where: { profileUserId: user.id },
      include: { author: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      items: comments.map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        author: {
          id: c.author.id,
          username: c.author.username,
          displayName: c.author.displayName,
          avatarUrl: c.author.avatarUrl,
        },
      })),
    };
  }

  async create(
    authorId: string,
    username: string,
    dto: CreateProfileCommentDto,
  ): Promise<ProfileCommentView> {
    const profileUser = await this.usersService.assertProfileVisibleToViewer(
      username,
      authorId,
    );

    const comment = await this.prisma.profileComment.create({
      data: {
        profileUserId: profileUser.id,
        authorId,
        body: dto.body.trim(),
      },
      include: { author: true },
    });

    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      author: {
        id: comment.author.id,
        username: comment.author.username,
        displayName: comment.author.displayName,
        avatarUrl: comment.author.avatarUrl,
      },
    };
  }

  async remove(actorId: string, commentId: string) {
    const comment = await this.prisma.profileComment.findUnique({
      where: { id: commentId },
    });
    if (!comment) {
      throw new NotFoundException('Comment not found');
    }

    const canDelete =
      comment.authorId === actorId || comment.profileUserId === actorId;
    if (!canDelete) {
      throw new ForbiddenException('Cannot delete this comment');
    }

    await this.prisma.profileComment.delete({ where: { id: commentId } });
    return { ok: true };
  }
}
