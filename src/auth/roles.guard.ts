import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { UserRole } from '../../generated/prisma/index.js';
import type { AuthUser } from './decorators/current-user.decorator.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';

type RequestWithUser = Request & { user?: AuthUser };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authUser = request.user;
    if (!authUser) {
      throw new ForbiddenException('Admin access required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: authUser.userId },
      select: { role: true },
    });

    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
