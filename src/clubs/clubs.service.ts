import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClubMemberRole } from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateClubDto } from './dto/create-club.dto.js';

export type ClubSummary = {
  id: string;
  name: string;
  slug: string;
  description: string;
  coverUrl: string | null;
  memberCount: number;
  role?: ClubMemberRole;
};

function slugify(input: string) {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

@Injectable()
export class ClubsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async listForUsername(
    username: string,
    viewerUserId?: string | null,
  ): Promise<{ count: number; items: ClubSummary[] }> {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );

    const memberships = await this.prisma.clubMember.findMany({
      where: { userId: user.id },
      include: {
        club: {
          include: { _count: { select: { members: true } } },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const items = memberships.map((m) => ({
      id: m.club.id,
      name: m.club.name,
      slug: m.club.slug,
      description: m.club.description,
      coverUrl: m.club.coverUrl,
      memberCount: m.club._count.members,
      role: m.role,
    }));

    return { count: items.length, items };
  }

  async listAll(limit = 40): Promise<{ items: ClubSummary[] }> {
    const clubs = await this.prisma.club.findMany({
      take: Math.min(limit, 100),
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { members: true } } },
    });

    return {
      items: clubs.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        coverUrl: c.coverUrl,
        memberCount: c._count.members,
      })),
    };
  }

  async getBySlug(slug: string, viewerUserId?: string | null) {
    const club = await this.prisma.club.findUnique({
      where: { slug: slug.toLowerCase() },
      include: {
        owner: true,
        _count: { select: { members: true } },
        members: {
          include: {
            user: true,
          },
          orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
          take: 50,
        },
      },
    });

    if (!club) {
      throw new NotFoundException('Club not found');
    }

    const membership = viewerUserId
      ? club.members.find((m) => m.userId === viewerUserId)
      : null;

    return {
      id: club.id,
      name: club.name,
      slug: club.slug,
      description: club.description,
      coverUrl: club.coverUrl,
      memberCount: club._count.members,
      isMember: Boolean(membership),
      role: membership?.role ?? null,
      owner: {
        id: club.owner.id,
        username: club.owner.username,
        displayName: club.owner.displayName,
        avatarUrl: club.owner.avatarUrl,
      },
      members: club.members.map((m) => ({
        role: m.role,
        joinedAt: m.joinedAt,
        user: {
          id: m.user.id,
          username: m.user.username,
          displayName: m.user.displayName,
          avatarUrl: m.user.avatarUrl,
        },
      })),
    };
  }

  async create(ownerId: string, dto: CreateClubDto) {
    const name = dto.name.trim();
    const baseSlug = (dto.slug?.trim() || slugify(name)).toLowerCase();
    if (!baseSlug) {
      throw new BadRequestException('Invalid club slug');
    }

    const existing = await this.prisma.club.findUnique({
      where: { slug: baseSlug },
    });
    if (existing) {
      throw new ConflictException('Club slug already taken');
    }

    const club = await this.prisma.club.create({
      data: {
        name,
        slug: baseSlug,
        description: dto.description?.trim() ?? '',
        coverUrl: dto.coverUrl?.trim() || null,
        ownerId,
        members: {
          create: {
            userId: ownerId,
            role: ClubMemberRole.OWNER,
          },
        },
      },
      include: { _count: { select: { members: true } } },
    });

    return {
      id: club.id,
      name: club.name,
      slug: club.slug,
      description: club.description,
      coverUrl: club.coverUrl,
      memberCount: club._count.members,
      role: ClubMemberRole.OWNER,
    } satisfies ClubSummary;
  }

  async join(userId: string, slug: string) {
    const club = await this.prisma.club.findUnique({
      where: { slug: slug.toLowerCase() },
    });
    if (!club) {
      throw new NotFoundException('Club not found');
    }

    const existing = await this.prisma.clubMember.findUnique({
      where: {
        clubId_userId: { clubId: club.id, userId },
      },
    });
    if (existing) {
      throw new ConflictException('Already a member');
    }

    await this.prisma.clubMember.create({
      data: {
        clubId: club.id,
        userId,
        role: ClubMemberRole.MEMBER,
      },
    });

    return this.getBySlug(slug, userId);
  }

  async leave(userId: string, slug: string) {
    const club = await this.prisma.club.findUnique({
      where: { slug: slug.toLowerCase() },
    });
    if (!club) {
      throw new NotFoundException('Club not found');
    }

    const membership = await this.prisma.clubMember.findUnique({
      where: {
        clubId_userId: { clubId: club.id, userId },
      },
    });
    if (!membership) {
      throw new NotFoundException('Not a member');
    }

    if (membership.role === ClubMemberRole.OWNER) {
      const otherMembers = await this.prisma.clubMember.count({
        where: { clubId: club.id, userId: { not: userId } },
      });
      if (otherMembers > 0) {
        throw new ForbiddenException(
          'Transfer ownership or remove members before leaving as owner',
        );
      }
      await this.prisma.club.delete({ where: { id: club.id } });
      return { ok: true, deleted: true };
    }

    await this.prisma.clubMember.delete({
      where: { clubId_userId: { clubId: club.id, userId } },
    });
    return { ok: true, deleted: false };
  }
}
