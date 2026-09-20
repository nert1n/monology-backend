import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  OptionalCurrentUser,
  type AuthUser,
} from '../auth/decorators/current-user.decorator.js';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { AchievementsService } from './achievements.service.js';

@Controller()
export class AchievementsController {
  constructor(private readonly achievementsService: AchievementsService) {}

  @Get('users/:username/achievements')
  @UseGuards(OptionalJwtAuthGuard)
  listForUsername(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.achievementsService.listForUsername(username, viewer?.userId);
  }
}
