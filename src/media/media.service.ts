import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ItemStatus, Prisma } from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateMediaDto } from './dto/create-media.dto.js';
import type { ListMediaQueryDto } from './dto/list-media-query.dto.js';
import type { UpdateMediaDto } from './dto/update-media.dto.js';
import { uploadsSubdir } from '../common/uploads-path.js';
import {
  normalizeGenreNames,
  resolveIsAdult,
  slugifyGenreName,
} from './media.helpers.js';

const MEDIA_PUBLIC_PREFIX = '/uploads/media';

const mediaInclude = {
  photos: { orderBy: { sortOrder: 'asc' as const } },
  genres: {
    include: { genre: true },
    orderBy: { genre: { name: 'asc' as const } },
  },
} satisfies Prisma.MediaInclude;

type MediaWithRelations = Prisma.MediaGetPayload<{
  include: typeof mediaInclude;
}>;

function mediaUploadDir() {
  return uploadsSubdir('media');
}

function publicMediaPath(filename: string) {
  return `${MEDIA_PUBLIC_PREFIX}/${filename}`;
}

function mapMediaGenres(media: MediaWithRelations) {
  return {
    ...media,
    genres: media.genres.map((row) => ({
      id: row.genre.id,
      name: row.genre.name,
      slug: row.genre.slug,
    })),
  };
}

@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: ListMediaQueryDto,
    allowAdult = false,
    viewerUserId?: string | null,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const sort = query.sort ?? 'updatedAt';
    const minRating = query.minRating;
    // For rating sort, minRating is applied in listByAverageRating (HAVING),
    // so skip the ID prefetch in buildListWhere.
    const where = await this.buildListWhere(query, {
      applyMinRating: sort !== 'rating',
      allowAdult,
    });

    if (sort === 'rating') {
      return this.listByAverageRating(
        where,
        page,
        limit,
        skip,
        minRating,
        viewerUserId,
      );
    }

    const orderBy: Prisma.MediaOrderByWithRelationInput[] =
      sort === 'yearDesc'
        ? [{ year: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
        : sort === 'createdAt'
          ? [{ createdAt: 'desc' }]
          : [{ updatedAt: 'desc' }];

    const [items, total] = await Promise.all([
      this.prisma.media.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: mediaInclude,
      }),
      this.prisma.media.count({ where }),
    ]);

    return {
      items: await this.enrichMediaItems(
        items.map(mapMediaGenres),
        viewerUserId,
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  listGenres() {
    return this.prisma.genre.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true },
    });
  }

  async getById(
    id: string,
    allowAdult = false,
    viewerUserId?: string | null,
  ) {
    const media = await this.prisma.media.findUnique({
      where: { id },
      include: mediaInclude,
    });
    if (!media || (media.isAdult && !allowAdult)) {
      throw new NotFoundException('Media not found');
    }
    const [enriched] = await this.enrichMediaItems(
      [mapMediaGenres(media)],
      viewerUserId,
    );
    return enriched;
  }

  async create(dto: CreateMediaDto) {
    const genreNames = normalizeGenreNames(dto.genres);
    const isAdult = resolveIsAdult({
      contentRating: dto.contentRating,
      isAdult: dto.isAdult,
      genres: genreNames,
    });

    const media = await this.prisma.media.create({
      data: {
        type: dto.type,
        title: dto.title.trim(),
        description: dto.description ?? '',
        year: dto.year ?? null,
        status: dto.status ?? null,
        episodeCount: dto.episodeCount ?? null,
        episodesAired: dto.episodesAired ?? null,
        contentRating: dto.contentRating ?? null,
        isAdult,
        ...(genreNames.length
          ? {
              genres: {
                create: await this.genreConnectCreates(genreNames),
              },
            }
          : {}),
      },
      include: mediaInclude,
    });

    return mapMediaGenres(media);
  }

  async update(id: string, dto: UpdateMediaDto) {
    const existing = await this.getById(id, true);
    const nextRating =
      dto.contentRating !== undefined
        ? dto.contentRating
        : existing.contentRating;
    const nextGenreNames =
      dto.genres !== undefined
        ? normalizeGenreNames(dto.genres)
        : (existing.genres ?? []).map((genre) => genre.name);
    const nextIsAdult = resolveIsAdult({
      contentRating: nextRating,
      isAdult:
        dto.isAdult !== undefined
          ? dto.isAdult
          : // Preserve explicit adult when not forced by rating/genre.
            existing.isAdult,
      genres: nextGenreNames,
    });

    const data: Prisma.MediaUpdateInput = {
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
      ...(dto.description !== undefined
        ? { description: dto.description }
        : {}),
      ...(dto.year !== undefined ? { year: dto.year } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.episodeCount !== undefined
        ? { episodeCount: dto.episodeCount }
        : {}),
      ...(dto.episodesAired !== undefined
        ? { episodesAired: dto.episodesAired }
        : {}),
      ...(dto.contentRating !== undefined
        ? { contentRating: dto.contentRating }
        : {}),
      isAdult: nextIsAdult,
    };

    if (dto.genres !== undefined) {
      const genreNames = normalizeGenreNames(dto.genres);
      data.genres = {
        deleteMany: {},
        ...(genreNames.length
          ? { create: await this.genreConnectCreates(genreNames) }
          : {}),
      };
    }

    const updated = await this.prisma.media.update({
      where: { id },
      data,
      include: mediaInclude,
    });

    if (dto.title !== undefined || dto.year !== undefined) {
      await this.prisma.item.updateMany({
        where: { mediaId: id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.year !== undefined ? { year: dto.year } : {}),
        },
      });
    }

    const [enriched] = await this.withAverageRatings([
      mapMediaGenres(updated),
    ]);
    return enriched;
  }

  async remove(id: string) {
    const media = await this.getById(id, true);
    await this.prisma.media.delete({ where: { id } });
    await this.removeLocalFile(media.coverUrl);
    for (const photo of media.photos) {
      await this.removeLocalFile(photo.url);
    }
    return { ok: true };
  }

  async setCover(id: string, file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('Cover file is required');
    }
    const media = await this.getById(id, true);
    const nextUrl = publicMediaPath(file.filename);
    const updated = await this.prisma.media.update({
      where: { id },
      data: { coverUrl: nextUrl },
      include: mediaInclude,
    });
    await this.removeLocalFile(media.coverUrl);
    return mapMediaGenres(updated);
  }

  async addPhoto(id: string, file: Express.Multer.File | undefined) {
    if (!file) {
      throw new BadRequestException('Photo file is required');
    }
    await this.getById(id, true);
    const maxSort = await this.prisma.mediaPhoto.aggregate({
      where: { mediaId: id },
      _max: { sortOrder: true },
    });
    return this.prisma.mediaPhoto.create({
      data: {
        mediaId: id,
        url: publicMediaPath(file.filename),
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async removePhoto(photoId: string) {
    const photo = await this.prisma.mediaPhoto.findUnique({
      where: { id: photoId },
    });
    if (!photo) {
      throw new NotFoundException('Photo not found');
    }
    await this.prisma.mediaPhoto.delete({ where: { id: photoId } });
    await this.removeLocalFile(photo.url);
    return { ok: true };
  }

  getUploadDir() {
    return mediaUploadDir();
  }

  private async genreConnectCreates(names: string[]) {
    const creates: Array<{ genre: { connect: { id: string } } }> = [];
    for (const name of names) {
      let slug = slugifyGenreName(name);
      if (!slug) {
        slug = `g-${Date.now().toString(36)}-${creates.length}`;
      }

      let genre = await this.prisma.genre.findFirst({
        where: {
          OR: [{ slug }, { name }],
        },
      });
      if (!genre) {
        genre = await this.prisma.genre.create({
          data: { name, slug },
        });
      }

      creates.push({ genre: { connect: { id: genre.id } } });
    }
    return creates;
  }

  private async buildListWhere(
    query: ListMediaQueryDto,
    options: { applyMinRating?: boolean; allowAdult?: boolean } = {},
  ): Promise<Prisma.MediaWhereInput> {
    const applyMinRating = options.applyMinRating ?? true;
    const allowAdult = options.allowAdult ?? false;
    const currentYear = new Date().getFullYear();
    const yearFrom = query.yearFrom;
    const yearTo = query.yearTo;
    const hasYearRange = yearFrom != null || yearTo != null;
    const minRating = applyMinRating ? query.minRating : undefined;
    const genreSlug = query.genre?.trim().toLowerCase();

    const baseWhere: Prisma.MediaWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...(query.q?.trim()
        ? { title: { contains: query.q.trim() } }
        : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.contentRating
        ? { contentRating: query.contentRating }
        : {}),
      ...(genreSlug
        ? { genres: { some: { genre: { slug: genreSlug } } } }
        : {}),
      ...(hasYearRange
        ? {
            year: {
              ...(yearFrom != null ? { gte: yearFrom } : {}),
              ...(yearTo != null ? { lte: yearTo } : {}),
            },
          }
        : {}),
      // Include unknown (null) years; never include titles set in a future year.
      ...(query.excludeFutureYears
        ? {
            OR: [{ year: null }, { year: { lte: currentYear } }],
          }
        : {}),
      // Guests and users who opt out never see isAdult media.
      ...(!allowAdult ? { isAdult: false } : {}),
    };

    if (minRating != null) {
      const groups = await this.prisma.item.groupBy({
        by: ['mediaId'],
        where: {
          rating: { not: null },
          mediaId: { not: null },
          media: baseWhere,
        },
        _avg: { rating: true },
        having: {
          rating: {
            _avg: { gte: minRating },
          },
        },
      });
      const ids = groups
        .map((group) => group.mediaId)
        .filter((id): id is string => id != null);
      return {
        ...baseWhere,
        id: { in: ids },
      };
    }

    return {
      ...baseWhere,
      ...(query.hasRating || query.sort === 'rating'
        ? { items: { some: { rating: { not: null } } } }
        : {}),
    };
  }

  private async listByAverageRating(
    where: Prisma.MediaWhereInput,
    page: number,
    limit: number,
    skip: number,
    minRating?: number,
    viewerUserId?: string | null,
  ) {
    const itemWhere: Prisma.ItemWhereInput = {
      rating: { not: null },
      mediaId: { not: null },
      media: where,
    };
    const having =
      minRating != null
        ? {
            rating: {
              _avg: { gte: minRating },
            },
          }
        : undefined;

    const [pageGroups, allGroups] = await Promise.all([
      this.prisma.item.groupBy({
        by: ['mediaId'],
        where: itemWhere,
        _avg: { rating: true },
        ...(having ? { having } : {}),
        orderBy: { _avg: { rating: 'desc' } },
        skip,
        take: limit,
      }),
      this.prisma.item.groupBy({
        by: ['mediaId'],
        where: itemWhere,
        ...(having
          ? {
              _avg: { rating: true },
              having,
            }
          : {}),
      }),
    ]);

    const total = allGroups.length;
    const ids = pageGroups
      .map((group) => group.mediaId)
      .filter((id): id is string => id != null);

    if (ids.length === 0) {
      return {
        items: [],
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    }

    const items = await this.prisma.media.findMany({
      where: { id: { in: ids } },
      include: mediaInclude,
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((item): item is MediaWithRelations => item != null);

    return {
      items: await this.enrichMediaItems(
        ordered.map(mapMediaGenres),
        viewerUserId,
      ),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  private async enrichMediaItems<T extends { id: string }>(
    items: T[],
    viewerUserId?: string | null,
  ): Promise<
    Array<
      T & {
        averageRating: number | null;
        viewerItemStatus: ItemStatus | null;
      }
    >
  > {
    const withRatings = await this.withAverageRatings(items);
    return this.withViewerItemStatuses(withRatings, viewerUserId);
  }

  private async withAverageRatings<
    T extends { id: string },
  >(items: T[]): Promise<Array<T & { averageRating: number | null }>> {
    if (items.length === 0) {
      return [];
    }

    const groups = await this.prisma.item.groupBy({
      by: ['mediaId'],
      where: {
        mediaId: { in: items.map((item) => item.id) },
        rating: { not: null },
      },
      _avg: { rating: true },
    });

    const byId = new Map(
      groups.map((group) => [
        group.mediaId,
        group._avg.rating == null
          ? null
          : Math.round(group._avg.rating * 100) / 100,
      ]),
    );

    return items.map((item) => ({
      ...item,
      averageRating: byId.get(item.id) ?? null,
    }));
  }

  private async withViewerItemStatuses<T extends { id: string }>(
    items: T[],
    viewerUserId?: string | null,
  ): Promise<Array<T & { viewerItemStatus: ItemStatus | null }>> {
    if (items.length === 0) {
      return [];
    }

    if (!viewerUserId) {
      return items.map((item) => ({ ...item, viewerItemStatus: null }));
    }

    const rows = await this.prisma.item.findMany({
      where: {
        mediaId: { in: items.map((item) => item.id) },
        category: { userId: viewerUserId },
      },
      select: { mediaId: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });

    const byMediaId = new Map<string, ItemStatus>();
    for (const row of rows) {
      if (row.mediaId && !byMediaId.has(row.mediaId)) {
        byMediaId.set(row.mediaId, row.status);
      }
    }

    return items.map((item) => ({
      ...item,
      viewerItemStatus: byMediaId.get(item.id) ?? null,
    }));
  }

  private async removeLocalFile(url: string | null | undefined) {
    if (!url?.startsWith(`${MEDIA_PUBLIC_PREFIX}/`)) {
      return;
    }
    const filename = path.basename(url);
    try {
      await unlink(path.join(mediaUploadDir(), filename));
    } catch {
      // ignore missing files
    }
  }
}

