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
import { CreateProfileCommentDto } from './dto/create-profile-comment.dto.js';
import { ProfileCommentsService } from './profile-comments.service.js';

@Controller()
export class ProfileCommentsController {
  constructor(
    private readonly profileCommentsService: ProfileCommentsService,
  ) {}

  @Get('users/:username/comments')
  @UseGuards(OptionalJwtAuthGuard)
  listForUsername(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.profileCommentsService.listForUsername(
      username,
      viewer?.userId,
    );
  }

  @Post('users/:username/comments')
  @UseGuards(JwtAuthGuard)
  create(
    @CurrentUser() user: AuthUser,
    @Param('username') username: string,
    @Body() dto: CreateProfileCommentDto,
  ) {
    return this.profileCommentsService.create(user.userId, username, dto);
  }

  @Delete('comments/:id')
  @UseGuards(JwtAuthGuard)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profileCommentsService.remove(user.userId, id);
  }
}
