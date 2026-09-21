import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { UserRole } from '../../generated/prisma/index.js';
import {
  OptionalCurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { uploadsSubdir } from '../common/uploads-path.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateMediaDto } from './dto/create-media.dto.js';
import { ListMediaQueryDto } from './dto/list-media-query.dto.js';
import { UpdateMediaDto } from './dto/update-media.dto.js';
import { MediaService } from './media.service.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

function mediaDestination() {
  const dir = uploadsSubdir('media');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function imageUploadInterceptor(field: string) {
  return FileInterceptor(field, {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, mediaDestination()),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)
          ? ext === '.jpeg'
            ? '.jpg'
            : ext
          : '.jpg';
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
      },
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        cb(
          new BadRequestException(
            'Image must be a JPEG, PNG, WebP, or GIF (max 5MB)',
          ),
          false,
        );
        return;
      }
      cb(null, true);
    },
  });
}

@Controller('media')
export class MediaController {
  constructor(
    private readonly mediaService: MediaService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  async list(
    @Query() query: ListMediaQueryDto,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    const allowAdult = await this.resolveAllowAdult(viewer);
    return this.mediaService.list(query, allowAdult, viewer?.userId);
  }

  @Get('genres')
  listGenres() {
    return this.mediaService.listGenres();
  }

  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  async getById(
    @Param('id') id: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    const allowAdult = await this.resolveAllowAdult(viewer);
    return this.mediaService.getById(id, allowAdult, viewer?.userId);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() dto: CreateMediaDto) {
    return this.mediaService.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() dto: UpdateMediaDto) {
    return this.mediaService.update(id, dto);
  }

  @Delete('photos/:photoId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  removePhoto(@Param('photoId') photoId: string) {
    return this.mediaService.removePhoto(photoId);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.mediaService.remove(id);
  }

  @Post(':id/cover')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(imageUploadInterceptor('cover'))
  setCover(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.mediaService.setCover(id, file);
  }

  @Post(':id/photos')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(imageUploadInterceptor('photo'))
  addPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.mediaService.addPhoto(id, file);
  }

  private async resolveAllowAdult(viewer: AuthUser | null): Promise<boolean> {
    if (!viewer) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: viewer.userId },
      select: { displayAdultContent: true },
    });
    return user?.displayAdultContent ?? false;
  }
}
