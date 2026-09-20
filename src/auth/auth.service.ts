import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { UserRole } from '../../generated/prisma/index.js';
import {
  DEFAULT_CATEGORIES,
  GOOGLE_CONFIG_KEY,
  JWT_CONFIG_KEY,
} from '../common/constants/index.js';
import type { GoogleConfig, JwtConfig } from '../config/configuration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toPublicUser, type PublicUser } from '../users/user.mapper.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';

export type AuthResponse = {
  accessToken: string;
  user: PublicUser;
};

export type GoogleConnectStatus = {
  connected: boolean;
  oauthConfigured: boolean;
  /** Present when oauthConfigured — open this URL to complete linking. */
  authorizationUrl?: string;
};

type GoogleLinkState = {
  sub: string;
  purpose: 'google-link';
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const username = dto.username.toLowerCase().trim();

    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });

    if (existing) {
      throw new ConflictException(
        existing.email === email
          ? 'Email already registered'
          : 'Username already taken',
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const displayName =
      dto.displayName?.trim() ||
      username.charAt(0).toUpperCase() + username.slice(1);

    const adminEmail = (
      this.configService.get<string>('ADMIN_EMAIL') ?? ''
    ).toLowerCase();
    const role =
      adminEmail && email === adminEmail ? UserRole.ADMIN : UserRole.USER;

    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        passwordHash,
        displayName,
        role,
        categories: {
          create: DEFAULT_CATEGORIES,
        },
      },
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.buildAuthResponse(user);
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return toPublicUser(user);
  }

  isGoogleOAuthConfigured(): boolean {
    const google = this.getGoogleConfig();
    return Boolean(google.clientId && google.clientSecret);
  }

  async getGoogleConnectStatus(userId: string): Promise<GoogleConnectStatus> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { googleId: true },
    });
    const oauthConfigured = this.isGoogleOAuthConfigured();
    const connected = Boolean(user.googleId);
    if (!oauthConfigured || connected) {
      return { connected, oauthConfigured };
    }
    return {
      connected,
      oauthConfigured,
      authorizationUrl: this.buildGoogleAuthorizationUrl(userId),
    };
  }

  /**
   * Start Google linking. When OAuth keys are missing, stubs a connection
   * (googleId = stub:<userId>) so settings UI can be exercised locally.
   */
  async connectGoogle(userId: string): Promise<
    | { mode: 'oauth'; authorizationUrl: string }
    | { mode: 'stub'; user: PublicUser }
  > {
    if (this.isGoogleOAuthConfigured()) {
      return {
        mode: 'oauth',
        authorizationUrl: this.buildGoogleAuthorizationUrl(userId),
      };
    }

    const existing = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (existing.googleId) {
      return { mode: 'stub', user: toPublicUser(existing) };
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        googleId: `stub:${userId}`,
        googleConnectedAt: new Date(),
      },
    });
    return { mode: 'stub', user: toPublicUser(user) };
  }

  async disconnectGoogle(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        googleId: null,
        googleConnectedAt: null,
      },
    });
    return toPublicUser(user);
  }

  /**
   * OAuth callback: exchange code, attach Google `sub` to the user in `state`.
   * Returns a frontend redirect URL with ?google=connected|error.
   */
  async handleGoogleCallback(
    code: string | undefined,
    state: string | undefined,
    oauthError?: string,
  ): Promise<string> {
    const google = this.getGoogleConfig();
    const base = google.frontendRedirectUrl;

    if (!this.isGoogleOAuthConfigured()) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }

    if (oauthError || !code || !state) {
      return `${base}?google=error`;
    }

    let userId: string;
    try {
      const payload = this.jwtService.verify<GoogleLinkState>(state, {
        secret: this.configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY).secret,
      });
      if (payload.purpose !== 'google-link' || !payload.sub) {
        throw new BadRequestException('Invalid state');
      }
      userId = payload.sub;
    } catch {
      return `${base}?google=error`;
    }

    try {
      const googleSub = await this.exchangeGoogleCode(code, google);
      const clash = await this.prisma.user.findUnique({
        where: { googleId: googleSub },
      });
      if (clash && clash.id !== userId) {
        return `${base}?google=error&reason=already_linked`;
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          googleId: googleSub,
          googleConnectedAt: new Date(),
        },
      });
      return `${base}?google=connected`;
    } catch {
      return `${base}?google=error`;
    }
  }

  private buildGoogleAuthorizationUrl(userId: string): string {
    const google = this.getGoogleConfig();
    if (!google.clientId) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }

    const jwt = this.configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY);
    const state = this.jwtService.sign(
      { sub: userId, purpose: 'google-link' } satisfies GoogleLinkState,
      { secret: jwt.secret, expiresIn: '10m' },
    );

    const params = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: google.callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  private async exchangeGoogleCode(
    code: string,
    google: GoogleConfig,
  ): Promise<string> {
    if (!google.clientId || !google.clientSecret) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: google.clientId,
        client_secret: google.clientSecret,
        redirect_uri: google.callbackUrl,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      throw new BadRequestException('Google token exchange failed');
    }

    const tokenJson = (await tokenRes.json()) as {
      access_token?: string;
    };
    if (!tokenJson.access_token) {
      throw new BadRequestException('Google token missing');
    }

    const infoRes = await fetch(
      'https://www.googleapis.com/oauth2/v3/userinfo',
      {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      },
    );
    if (!infoRes.ok) {
      throw new BadRequestException('Google userinfo failed');
    }

    const info = (await infoRes.json()) as { sub?: string };
    if (!info.sub) {
      throw new BadRequestException('Google subject missing');
    }
    return info.sub;
  }

  private getGoogleConfig(): GoogleConfig {
    return this.configService.getOrThrow<GoogleConfig>(GOOGLE_CONFIG_KEY);
  }

  private buildAuthResponse(
    user: Parameters<typeof toPublicUser>[0],
  ): AuthResponse {
    const jwt = this.configService.getOrThrow<JwtConfig>(JWT_CONFIG_KEY);
    const accessToken = this.jwtService.sign(
      {
        sub: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      {
        secret: jwt.secret,
        expiresIn: jwt.expiresIn as `${number}d`,
      },
    );

    return {
      accessToken,
      user: toPublicUser(user),
    };
  }
}
