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
  CurrentUser,
  OptionalCurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto.js';
import { ImportListsDto } from './dto/import-lists.dto.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';
import { UpdateProfileDto } from './dto/update-profile.dto.js';
import { UsersService } from './users.service.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'] as const;

function ensureUploadDir(...segments: string[]) {
  const dir = path.resolve(process.cwd(), 'uploads', ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function imageFilename(
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, filename: string) => void,
) {
  const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
  const safeExt = IMAGE_EXTS.includes(ext as (typeof IMAGE_EXTS)[number])
    ? ext === '.jpeg'
      ? '.jpg'
      : ext
    : '.jpg';
  cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
}

function imageFileFilter(label: string): (
  _req: unknown,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => void {
  return (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(
        new BadRequestException(
          `${label} must be a JPEG, PNG, WebP, or GIF image`,
        ),
        false,
      );
      return;
    }
    cb(null, true);
  };
}

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateMe(user.userId, dto);
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, ensureUploadDir('avatars'));
        },
        filename: imageFilename,
      }),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: imageFileFilter('Avatar'),
    }),
  )
  uploadAvatar(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.usersService.updateAvatar(user.userId, file);
  }

  @Delete('me/avatar')
  @UseGuards(JwtAuthGuard)
  removeAvatar(@CurrentUser() user: AuthUser) {
    return this.usersService.removeAvatar(user.userId);
  }

  @Post('me/background')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('background', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          cb(null, ensureUploadDir('backgrounds'));
        },
        filename: imageFilename,
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: imageFileFilter('Background'),
    }),
  )
  uploadBackground(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.usersService.updateBackground(user.userId, file);
  }

  @Delete('me/background')
  @UseGuards(JwtAuthGuard)
  removeBackground(@CurrentUser() user: AuthUser) {
    return this.usersService.removeBackground(user.userId);
  }

  @Get('me/lists/export')
  @UseGuards(JwtAuthGuard)
  exportLists(@CurrentUser() user: AuthUser) {
    return this.usersService.exportLists(user.userId);
  }

  @Post('me/lists/import')
  @UseGuards(JwtAuthGuard)
  importLists(
    @CurrentUser() user: AuthUser,
    @Body() dto: ImportListsDto,
  ) {
    return this.usersService.importLists(user.userId, dto);
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listForAdmin(@Query() query: ListUsersQueryDto) {
    return this.usersService.listForAdmin(query);
  }

  @Get('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getForAdmin(@Param('id') id: string) {
    return this.usersService.getForAdmin(id);
  }

  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateForAdmin(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
    return this.usersService.updateForAdmin(id, dto);
  }

  @Get(':username')
  @UseGuards(OptionalJwtAuthGuard)
  getPublicProfile(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.usersService.getPublicProfile(username, viewer?.userId);
  }
}
