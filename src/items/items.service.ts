import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CategoryKind, MediaType } from '../../generated/prisma/index.js';
import { CategoriesService } from '../categories/categories.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CreateItemDto } from './dto/create-item.dto.js';
import type { UpdateItemDto } from './dto/update-item.dto.js';

const KIND_MEDIA_TYPES: Record<CategoryKind, MediaType[]> = {
  [CategoryKind.ANIME]: [MediaType.ANIME],
  [CategoryKind.MOVIE]: [MediaType.MOVIE],
  [CategoryKind.SERIAL]: [MediaType.SERIAL],
  [CategoryKind.BOOK]: [MediaType.BOOK],
  [CategoryKind.HENTAI]: [MediaType.HENTAI],
};

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
  ) {}

  async create(userId: string, dto: CreateItemDto) {
    const category = await this.categoriesService.requireOwnedCategory(
      userId,
      dto.categoryId,
    );

    const media = await this.prisma.media.findUnique({
      where: { id: dto.mediaId },
    });
    if (!media) {
      throw new NotFoundException('Media not found');
    }

    const allowed = KIND_MEDIA_TYPES[category.kind] ?? [];
    if (!allowed.includes(media.type)) {
      throw new ForbiddenException(
        `Media type ${media.type} does not belong in ${category.name}`,
      );
    }

    return this.prisma.item.create({
      data: {
        categoryId: dto.categoryId,
        mediaId: media.id,
        title: media.title,
        year: media.year,
        status: dto.status,
        rating: dto.rating ?? null,
        notes: dto.notes ?? '',
        completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
      },
      include: {
        media: { include: { photos: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
  }

  async findMineByMedia(userId: string, mediaId: string) {
    if (!mediaId?.trim()) {
      return null;
    }

    return this.prisma.item.findFirst({
      where: {
        mediaId: mediaId.trim(),
        category: { userId },
      },
      include: {
        category: true,
        media: { include: { photos: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateItemDto) {
    await this.requireOwnedItem(userId, id);

    return this.prisma.item.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.rating !== undefined ? { rating: dto.rating } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.year !== undefined ? { year: dto.year } : {}),
        ...(dto.completedAt !== undefined
          ? {
              completedAt: dto.completedAt ? new Date(dto.completedAt) : null,
            }
          : {}),
      },
      include: {
        media: { include: { photos: { orderBy: { sortOrder: 'asc' } } } },
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.requireOwnedItem(userId, id);
    await this.prisma.item.delete({ where: { id } });
    return { ok: true };
  }

  private async requireOwnedItem(userId: string, id: string) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: { category: true },
    });

    if (!item) {
      throw new NotFoundException('Item not found');
    }
    if (item.category.userId !== userId) {
      throw new ForbiddenException('Not allowed to modify this item');
    }
    return item;
  }
}
