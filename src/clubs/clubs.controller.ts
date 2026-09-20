import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  OptionalCurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { ClubsService } from './clubs.service.js';
import { CreateClubDto } from './dto/create-club.dto.js';

@Controller()
export class ClubsController {
  constructor(private readonly clubsService: ClubsService) {}

  @Get('users/:username/clubs')
  @UseGuards(OptionalJwtAuthGuard)
  listForUsername(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.clubsService.listForUsername(username, viewer?.userId);
  }

  @Get('clubs')
  listAll() {
    return this.clubsService.listAll();
  }

  @Get('clubs/:slug')
  @UseGuards(OptionalJwtAuthGuard)
  getBySlug(
    @Param('slug') slug: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.clubsService.getBySlug(slug, viewer?.userId);
  }

  @Post('clubs')
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateClubDto) {
    return this.clubsService.create(user.userId, dto);
  }

  @Post('clubs/:slug/join')
  @UseGuards(JwtAuthGuard)
  join(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.clubsService.join(user.userId, slug);
  }

  @Delete('clubs/:slug/leave')
  @UseGuards(JwtAuthGuard)
  leave(@CurrentUser() user: AuthUser, @Param('slug') slug: string) {
    return this.clubsService.leave(user.userId, slug);
  }
}
