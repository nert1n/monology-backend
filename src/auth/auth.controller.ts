import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import {
  CurrentUser,
  type AuthUser,
} from './decorators/current-user.decorator.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.authService.me(user.userId);
  }

  /** Google connect status + optional authorization URL when OAuth is configured. */
  @Get('google/status')
  @UseGuards(JwtAuthGuard)
  googleStatus(@CurrentUser() user: AuthUser) {
    return this.authService.getGoogleConnectStatus(user.userId);
  }

  /**
   * Start Google linking.
   * - OAuth configured → `{ mode: 'oauth', authorizationUrl }`
   * - Otherwise stub → `{ mode: 'stub', user }` (marks connected without Google)
   */
  @Post('google/connect')
  @UseGuards(JwtAuthGuard)
  connectGoogle(@CurrentUser() user: AuthUser) {
    return this.authService.connectGoogle(user.userId);
  }

  @Delete('google')
  @UseGuards(JwtAuthGuard)
  disconnectGoogle(@CurrentUser() user: AuthUser) {
    return this.authService.disconnectGoogle(user.userId);
  }

  /** Browser redirect from Google; lands on frontend settings with ?google=. */
  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ) {
    const redirectUrl = await this.authService.handleGoogleCallback(
      code,
      state,
      error,
    );
    return res.redirect(redirectUrl);
  }
}
