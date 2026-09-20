import {
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
import { FriendshipsService } from './friendships.service.js';

@Controller()
export class FriendshipsController {
  constructor(private readonly friendshipsService: FriendshipsService) {}

  @Get('users/:username/friends')
  @UseGuards(OptionalJwtAuthGuard)
  listFriends(
    @Param('username') username: string,
    @OptionalCurrentUser() viewer: AuthUser | null,
  ) {
    return this.friendshipsService.listFriends(username, viewer?.userId);
  }

  @Get('friends/pending')
  @UseGuards(JwtAuthGuard)
  listPending(@CurrentUser() user: AuthUser) {
    return this.friendshipsService.listPending(user.userId);
  }

  @Get('friends/relation/:username')
  @UseGuards(JwtAuthGuard)
  getRelation(
    @CurrentUser() user: AuthUser,
    @Param('username') username: string,
  ) {
    return this.friendshipsService.getRelation(user.userId, username);
  }

  @Post('friends/requests/:username')
  @UseGuards(JwtAuthGuard)
  sendRequest(
    @CurrentUser() user: AuthUser,
    @Param('username') username: string,
  ) {
    return this.friendshipsService.sendRequest(user.userId, username);
  }

  @Post('friends/requests/:id/accept')
  @UseGuards(JwtAuthGuard)
  acceptRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.friendshipsService.acceptRequest(user.userId, id);
  }

  @Post('friends/requests/:id/decline')
  @UseGuards(JwtAuthGuard)
  declineRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.friendshipsService.declineRequest(user.userId, id);
  }

  @Delete('friends/requests/:id')
  @UseGuards(JwtAuthGuard)
  cancelRequest(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.friendshipsService.cancelRequest(user.userId, id);
  }

  @Delete('friends/:username')
  @UseGuards(JwtAuthGuard)
  removeFriend(
    @CurrentUser() user: AuthUser,
    @Param('username') username: string,
  ) {
    return this.friendshipsService.removeFriend(user.userId, username);
  }
}
