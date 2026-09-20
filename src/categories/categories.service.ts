import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryKind,
  UserRole,
  type Prisma,
} from '../../generated/prisma/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from '../users/users.service.js';
import type { CreateCategoryDto } from './dto/create-category.dto.js';
import type {
  ItemListSort,
  ListCategoryItemsQueryDto,
} from './dto/list-category-items-query.dto.js';
import type { UpdateCategoryDto } from './dto/update-category.dto.js';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function buildItemListWhere(
  base: Prisma.ItemWhereInput,
  query: ListCategoryItemsQueryDto,
): Prisma.ItemWhereInput {
  const q = query.q?.trim();
  const yearFrom = query.yearFrom;
  const yearTo = query.yearTo;
  const hasYearRange = yearFrom != null || yearTo != null;

  return {
    ...base,
    ...(query.status ? { status: query.status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q } },
            { media: { title: { contains: q } } },
          ],
        }
      : {}),
    ...(hasYearRange
      ? {
          year: {
            ...(yearFrom != null ? { gte: yearFrom } : {}),
            ...(yearTo != null ? { lte: yearTo } : {}),
          },
        }
      : {}),
  };
}

function itemListOrderBy(
  sort: ItemListSort = 'updatedAt',
): Prisma.ItemOrderByWithRelationInput[] {
  if (sort === 'rating') {
    return [
      { rating: { sort: 'desc', nulls: 'last' } },
      { updatedAt: 'desc' },
    ];
  }
  if (sort === 'createdAt') {
    return [{ createdAt: 'desc' }];
  }
  return [{ updatedAt: 'desc' }];
}

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async listByUsername(username: string, viewerUserId?: string | null) {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );
    return this.prisma.category.findMany({
      where: { userId: user.id },
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { items: true } } },
    });
  }

  async getByUsernameAndSlug(
    username: string,
    slug: string,
    query: ListCategoryItemsQueryDto,
    viewerUserId?: string | null,
  ) {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );
    const category = await this.prisma.category.findUnique({
      where: {
        userId_slug: { userId: user.id, slug },
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = buildItemListWhere({ categoryId: category.id }, query);
    const orderBy = itemListOrderBy(query.sort);

    const [items, total] = await Promise.all([
      this.prisma.item.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          media: { include: { photos: { orderBy: { sortOrder: 'asc' } } } },
        },
      }),
      this.prisma.item.count({ where }),
    ]);

    return {
      category,
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async listItemsByUsername(
    username: string,
    query: ListCategoryItemsQueryDto,
    viewerUserId?: string | null,
  ) {
    const user = await this.usersService.assertProfileVisibleToViewer(
      username,
      viewerUserId,
    );

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const where = buildItemListWhere({ category: { userId: user.id } }, query);
    const orderBy = itemListOrderBy(query.sort);

    const [items, total] = await Promise.all([
      this.prisma.item.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        include: {
          media: { include: { photos: { orderBy: { sortOrder: 'asc' } } } },
          category: {
            select: { id: true, name: true, slug: true, kind: true },
          },
        },
      }),
      this.prisma.item.count({ where }),
    ]);

    return {
      status: query.status ?? null,
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /** Reserved category slugs that must not collide with profile sub-routes. */
  static isReservedSlug(slug: string): boolean {
    return slug === 'lists';
  }

  assertNotReservedSlug(slug: string) {
    if (CategoriesService.isReservedSlug(slug)) {
      throw new ConflictException('Category slug is reserved');
    }
  }

  async create(userId: string, dto: CreateCategoryDto) {
    await this.requireAdmin(userId);
    const slug = dto.slug ? slugify(dto.slug) : slugify(dto.name);
    if (!slug) {
      throw new ConflictException('Could not derive a valid slug');
    }
    this.assertNotReservedSlug(slug);

    const existing = await this.prisma.category.findUnique({
      where: { userId_slug: { userId, slug } },
    });
    if (existing) {
      throw new ConflictException('Category slug already exists');
    }

    const maxSort = await this.prisma.category.aggregate({
      where: { userId },
      _max: { sortOrder: true },
    });

    return this.prisma.category.create({
      data: {
        userId,
        name: dto.name.trim(),
        slug,
        kind: dto.kind ?? CategoryKind.ANIME,
        sortOrder: dto.sortOrder ?? (maxSort._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateCategoryDto) {
    const category = await this.requireOwnedCategory(userId, id);

    const nextSlug = dto.slug ? slugify(dto.slug) : undefined;
    if (nextSlug && nextSlug !== category.slug) {
      this.assertNotReservedSlug(nextSlug);
      const clash = await this.prisma.category.findUnique({
        where: { userId_slug: { userId, slug: nextSlug } },
      });
      if (clash) {
        throw new ConflictException('Category slug already exists');
      }
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(nextSlug !== undefined ? { slug: nextSlug } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async remove(userId: string, id: string) {
    await this.requireOwnedCategory(userId, id);
    await this.prisma.category.delete({ where: { id } });
    return { ok: true };
  }

  async requireOwnedCategory(userId: string, id: string) {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (category.userId !== userId) {
      throw new ForbiddenException('Not allowed to modify this category');
    }
    return category;
  }

  private async requireAdmin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only admins can manage lists');
    }
  }
}
