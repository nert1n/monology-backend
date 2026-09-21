import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  CategoryKind,
  ItemStatus,
  MediaType,
  Prisma,
} from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { uploadsSubdir } from '../common/uploads-path.js';
import type { AdminUpdateUserDto } from './dto/admin-update-user.dto.js';
import type {
  ImportListEntryDto,
  ImportListsDto,
} from './dto/import-lists.dto.js';
import type { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';
import { parseDateOnly } from './lib/date-of-birth.js';
import { parseProfileColors } from './lib/profile-colors.js';
import {
  toPublicProfile,
  toPublicUser,
  type PublicProfile,
  type PublicUser,
} from './user.mapper.js';

export type StatusCounts = {
  planned: number;
  inProgress: number;
  paused: number;
  done: number;
  dropped: number;
};

export type CategorySummary = {
  id: string;
  name: string;
  slug: string;
  kind: string;
  sortOrder: number;
  itemCount: number;
  statusCounts: StatusCounts;
};

export type HistoryEntry = {
  id: string;
  title: string;
  status: ItemStatus;
  rating: number | null;
  year: number | null;
  updatedAt: Date;
  mediaId: string | null;
  media: {
    coverUrl: string | null;
    contentRating: string | null;
    isAdult: boolean;
    type: string;
  } | null;
  category: {
    name: string;
    slug: string;
    kind: string;
  };
};

export type PublicProfileResponse = PublicProfile & {
  categories: CategorySummary[];
  history: HistoryEntry[];
  totals: StatusCounts & { items: number };
};

export type ExportedListEntry = {
  mediaId: string | null;
  title: string;
  type: MediaType | CategoryKind;
  year: number | null;
  status: ItemStatus;
  rating: number | null;
  notes: string;
  categorySlug: string;
  categoryKind: CategoryKind;
  completedAt: string | null;
};

export type ListsExportPayload = {
  version: 1;
  exportedAt: string;
  lists: ExportedListEntry[];
};

export type ListsImportResult = {
  created: number;
  updated: number;
  skipped: number;
  total: number;
};

const EMPTY_COUNTS: StatusCounts = {
  planned: 0,
  inProgress: 0,
  paused: 0,
  done: 0,
  dropped: 0,
};

const AVATAR_PUBLIC_PREFIX = '/uploads/avatars';
const BACKGROUND_PUBLIC_PREFIX = '/uploads/backgrounds';

function emptyCounts(): StatusCounts {
  return { ...EMPTY_COUNTS };
}

function avatarUploadDir() {
  return uploadsSubdir('avatars');
}

function backgroundUploadDir() {
  return uploadsSubdir('backgrounds');
}

function publicAvatarPath(filename: string) {
  return `${AVATAR_PUBLIC_PREFIX}/${filename}`;
}

function publicBackgroundPath(filename: string) {
  return `${BACKGROUND_PUBLIC_PREFIX}/${filename}`;
}

export type AdminUserListResponse = {
  items: PublicUser[];
  total: number;
  page: number;
  limit: number;
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async listForAdmin(query: ListUsersQueryDto): Promise<AdminUserListResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const q = query.q?.trim();

    const where: Prisma.UserWhereInput = q
      ? {
          OR: [
            { username: { contains: q } },
            { email: { contains: q } },
            { displayName: { contains: q } },
          ],
        }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: rows.map(toPublicUser),
      total,
      page,
      limit,
    };
  }

  async getForAdmin(id: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return toPublicUser(user);
  }

  async updateForAdmin(
    id: string,
    dto: AdminUpdateUserDto,
  ): Promise<PublicUser> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('User not found');
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.profileHidden !== undefined
          ? { profileHidden: dto.profileHidden }
          : {}),
      },
    });

    return toPublicUser(user);
  }

  async getPublicProfile(
    username: string,
    viewerUserId?: string | null,
  ): Promise<PublicProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: {
            items: {
              select: { status: true },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    this.assertProfileVisible(user, viewerUserId);

    const categoryIds = user.categories.map((category) => category.id);

    const historyRows =
      categoryIds.length === 0
        ? []
        : await this.prisma.item.findMany({
            where: { categoryId: { in: categoryIds } },
            orderBy: { updatedAt: 'desc' },
            take: 12,
            include: {
              category: {
                select: { name: true, slug: true, kind: true },
              },
              media: {
                select: {
                  title: true,
                  year: true,
                  coverUrl: true,
                  contentRating: true,
                  isAdult: true,
                  type: true,
                },
              },
            },
          });

    const totals = emptyCounts();
    let items = 0;

    const categories: CategorySummary[] = user.categories.map((category) => {
      const statusCounts = emptyCounts();
      for (const item of category.items) {
        items += 1;
        switch (item.status) {
          case ItemStatus.PLANNED:
            statusCounts.planned += 1;
            totals.planned += 1;
            break;
          case ItemStatus.IN_PROGRESS:
            statusCounts.inProgress += 1;
            totals.inProgress += 1;
            break;
          case ItemStatus.PAUSED:
            statusCounts.paused += 1;
            totals.paused += 1;
            break;
          case ItemStatus.DONE:
            statusCounts.done += 1;
            totals.done += 1;
            break;
          case ItemStatus.DROPPED:
            statusCounts.dropped += 1;
            totals.dropped += 1;
            break;
        }
      }

      return {
        id: category.id,
        name: category.name,
        slug: category.slug,
        kind: category.kind,
        sortOrder: category.sortOrder,
        itemCount: category.items.length,
        statusCounts,
      };
    });

    return {
      ...toPublicProfile(user),
      categories,
      history: historyRows.map((row) => ({
        id: row.id,
        title: row.media?.title ?? row.title,
        status: row.status,
        rating: row.rating,
        year: row.media?.year ?? row.year,
        updatedAt: row.updatedAt,
        mediaId: row.mediaId,
        media: row.media
          ? {
              coverUrl: row.media.coverUrl,
              contentRating: row.media.contentRating,
              isAdult: row.media.isAdult,
              type: row.media.type,
            }
          : null,
        category: row.category,
      })),
      totals: { ...totals, items },
    };
  }

  async updateMe(userId: string, dto: UpdateProfileDto): Promise<PublicUser> {
    const profileColors =
      dto.profileColors !== undefined
        ? parseProfileColors(dto.profileColors)
        : undefined;

    let dateOfBirth: Date | null | undefined;
    if (dto.dateOfBirth !== undefined) {
      if (dto.dateOfBirth === null || dto.dateOfBirth === '') {
        dateOfBirth = null;
      } else {
        dateOfBirth = parseDateOnly(dto.dateOfBirth);
      }
    }

    let websiteUrl: string | null | undefined;
    if (dto.websiteUrl !== undefined) {
      const trimmed = dto.websiteUrl?.trim() ?? '';
      websiteUrl = trimmed === '' ? null : trimmed;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.displayName !== undefined
          ? { displayName: dto.displayName.trim() }
          : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.profileHidden !== undefined
          ? { profileHidden: dto.profileHidden }
          : {}),
        ...(profileColors !== undefined
          ? {
              profileColors:
                profileColors === null ? Prisma.DbNull : profileColors,
            }
          : {}),
        ...(websiteUrl !== undefined ? { websiteUrl } : {}),
        ...(dto.sex !== undefined ? { sex: dto.sex } : {}),
        ...(dateOfBirth !== undefined ? { dateOfBirth } : {}),
        ...(dto.displayAge !== undefined
          ? { displayAge: dto.displayAge }
          : {}),
        ...(dto.displayAdultContent !== undefined
          ? { displayAdultContent: dto.displayAdultContent }
          : {}),
        ...(dto.interfaceLanguage !== undefined
          ? { interfaceLanguage: dto.interfaceLanguage }
          : {}),
      },
    });

    return toPublicUser(user);
  }

  async getDisplayAdultContent(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayAdultContent: true },
    });
    return user?.displayAdultContent ?? false;
  }

  async exportLists(userId: string): Promise<ListsExportPayload> {
    const categories = await this.prisma.category.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
      include: {
        items: {
          orderBy: { updatedAt: 'desc' },
          include: {
            media: {
              select: { id: true, title: true, type: true, year: true },
            },
          },
        },
      },
    });

    const lists: ExportedListEntry[] = categories.flatMap((category) =>
      category.items.map((item) => ({
        mediaId: item.mediaId,
        title: item.media?.title ?? item.title,
        type: item.media?.type ?? category.kind,
        year: item.media?.year ?? item.year,
        status: item.status,
        rating: item.rating,
        notes: item.notes,
        categorySlug: category.slug,
        categoryKind: category.kind,
        completedAt: item.completedAt?.toISOString() ?? null,
      })),
    );

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      lists,
    };
  }

  async importLists(
    userId: string,
    dto: ImportListsDto,
  ): Promise<ListsImportResult> {
    const categories = await this.prisma.category.findMany({
      where: { userId },
      orderBy: { sortOrder: 'asc' },
    });

    if (categories.length === 0) {
      throw new BadRequestException('User has no shelves to import into');
    }

    const byKind = new Map(categories.map((c) => [c.kind, c]));
    const bySlug = new Map(categories.map((c) => [c.slug, c]));

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const raw of dto.lists) {
      const entry = this.normalizeImportEntry(raw);
      if (!entry.title && !entry.mediaId) {
        skipped += 1;
        continue;
      }

      const category =
        (entry.categorySlug ? bySlug.get(entry.categorySlug) : undefined) ??
        (entry.categoryKind ? byKind.get(entry.categoryKind) : undefined) ??
        (entry.type ? byKind.get(this.kindFromMediaType(entry.type)) : undefined);

      if (!category) {
        skipped += 1;
        continue;
      }

      const media = await this.resolveImportMedia(entry, category.kind);
      if (!media && !entry.title) {
        skipped += 1;
        continue;
      }

      const title = (media?.title ?? entry.title)!.trim();
      const year = entry.year ?? media?.year ?? null;
      const status = entry.status ?? ItemStatus.PLANNED;
      const rating = entry.rating ?? null;
      const notes = entry.notes ?? '';
      const completedAt = entry.completedAt
        ? new Date(entry.completedAt)
        : null;

      if (media) {
        const existing = await this.prisma.item.findUnique({
          where: {
            categoryId_mediaId: {
              categoryId: category.id,
              mediaId: media.id,
            },
          },
        });

        if (existing) {
          await this.prisma.item.update({
            where: { id: existing.id },
            data: {
              title,
              year,
              status,
              rating,
              notes,
              completedAt,
            },
          });
          updated += 1;
        } else {
          await this.prisma.item.create({
            data: {
              categoryId: category.id,
              mediaId: media.id,
              title,
              year,
              status,
              rating,
              notes,
              completedAt,
            },
          });
          created += 1;
        }
        continue;
      }

      // No catalog match: upsert by category + title (custom / unmatched rows).
      const existingByTitle = await this.prisma.item.findFirst({
        where: {
          categoryId: category.id,
          mediaId: null,
          title,
        },
      });

      if (existingByTitle) {
        await this.prisma.item.update({
          where: { id: existingByTitle.id },
          data: { year, status, rating, notes, completedAt },
        });
        updated += 1;
      } else {
        await this.prisma.item.create({
          data: {
            categoryId: category.id,
            mediaId: null,
            title,
            year,
            status,
            rating,
            notes,
            completedAt,
          },
        });
        created += 1;
      }
    }

    return {
      created,
      updated,
      skipped,
      total: dto.lists.length,
    };
  }

  private normalizeImportEntry(raw: ImportListEntryDto): {
    mediaId: string | null;
    title: string | null;
    type: MediaType | null;
    year: number | null;
    status: ItemStatus | null;
    rating: number | null;
    notes: string | null;
    categorySlug: string | null;
    categoryKind: CategoryKind | null;
    completedAt: string | null;
  } {
    const legacyTitle =
      raw.target_title?.trim() || raw.target_title_ru?.trim() || null;
    const title = raw.title?.trim() || legacyTitle;
    const type = raw.type ?? raw.target_type ?? null;
    const rating =
      raw.rating ?? (raw.score != null && raw.score > 0 ? raw.score : null);

    return {
      mediaId: raw.mediaId?.trim() || null,
      title,
      type,
      year: raw.year ?? null,
      status: raw.status ?? null,
      rating,
      notes: raw.notes ?? raw.text ?? null,
      categorySlug:
        raw.categorySlug?.trim() === 'hentai'
          ? 'anime'
          : raw.categorySlug?.trim() || null,
      categoryKind:
        raw.categoryKind ?? (type ? this.kindFromMediaType(type) : null),
      completedAt: raw.completedAt ?? null,
    };
  }

  private kindFromMediaType(type: MediaType): CategoryKind {
    switch (type) {
      case MediaType.ANIME:
        return CategoryKind.ANIME;
      case MediaType.MOVIE:
        return CategoryKind.MOVIE;
      case MediaType.SERIAL:
        return CategoryKind.SERIAL;
      case MediaType.BOOK:
        return CategoryKind.BOOK;
    }
  }

  private async resolveImportMedia(
    entry: {
      mediaId: string | null;
      title: string | null;
      type: MediaType | null;
    },
    categoryKind: CategoryKind,
  ) {
    if (entry.mediaId) {
      const byId = await this.prisma.media.findUnique({
        where: { id: entry.mediaId },
      });
      if (byId) {
        return byId;
      }
    }

    if (!entry.title) {
      return null;
    }

    const type = entry.type ?? this.mediaTypeFromKind(categoryKind);
    const exact = await this.prisma.media.findFirst({
      where: { type, title: entry.title },
    });
    if (exact) {
      return exact;
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM Media
      WHERE type = ${type}
        AND lower(title) = lower(${entry.title})
      LIMIT 1
    `;
    if (rows.length === 0) {
      return null;
    }
    return this.prisma.media.findUnique({ where: { id: rows[0].id } });
  }

  private mediaTypeFromKind(kind: CategoryKind): MediaType {
    switch (kind) {
      case CategoryKind.ANIME:
        return MediaType.ANIME;
      case CategoryKind.MOVIE:
        return MediaType.MOVIE;
      case CategoryKind.SERIAL:
        return MediaType.SERIAL;
      case CategoryKind.BOOK:
        return MediaType.BOOK;
    }
  }

  async updateAvatar(
    userId: string,
    file: Express.Multer.File | undefined,
  ): Promise<PublicUser> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }

    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const nextPath = publicAvatarPath(file.filename);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: nextPath },
    });

    await this.removeLocalAvatar(current.avatarUrl);
    return toPublicUser(user);
  }

  async removeAvatar(userId: string): Promise<PublicUser> {
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl: null },
    });

    await this.removeLocalAvatar(current.avatarUrl);
    return toPublicUser(user);
  }

  async updateBackground(
    userId: string,
    file: Express.Multer.File | undefined,
  ): Promise<PublicUser> {
    if (!file) {
      throw new BadRequestException('Background file is required');
    }

    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const nextPath = publicBackgroundPath(file.filename);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { profileBackgroundUrl: nextPath },
    });

    await this.removeLocalBackground(current.profileBackgroundUrl);
    return toPublicUser(user);
  }

  async removeBackground(userId: string): Promise<PublicUser> {
    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { profileBackgroundUrl: null },
    });

    await this.removeLocalBackground(current.profileBackgroundUrl);
    return toPublicUser(user);
  }

  async findByUsernameOrThrow(username: string) {
    const user = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async assertProfileVisibleToViewer(
    username: string,
    viewerUserId?: string | null,
  ) {
    const user = await this.findByUsernameOrThrow(username);
    this.assertProfileVisible(user, viewerUserId);
    return user;
  }

  private assertProfileVisible(
    user: { id: string; profileHidden: boolean },
    viewerUserId?: string | null,
  ) {
    if (!user.profileHidden) {
      return;
    }
    if (viewerUserId && viewerUserId === user.id) {
      return;
    }
    throw new NotFoundException('User not found');
  }

  private async removeLocalAvatar(avatarUrl: string | null) {
    if (!avatarUrl?.startsWith(`${AVATAR_PUBLIC_PREFIX}/`)) {
      return;
    }

    const filename = path.basename(avatarUrl);
    const fullPath = path.join(avatarUploadDir(), filename);

    try {
      await unlink(fullPath);
    } catch {
      // File may already be gone — ignore.
    }
  }

  private async removeLocalBackground(backgroundUrl: string | null) {
    if (!backgroundUrl?.startsWith(`${BACKGROUND_PUBLIC_PREFIX}/`)) {
      return;
    }

    const filename = path.basename(backgroundUrl);
    const fullPath = path.join(backgroundUploadDir(), filename);

    try {
      await unlink(fullPath);
    } catch {
      // File may already be gone — ignore.
    }
  }
}
