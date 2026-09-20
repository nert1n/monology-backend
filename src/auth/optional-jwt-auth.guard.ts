import { Injectable, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { type Observable, isObservable, lastValueFrom } from 'rxjs';

/** Allows anonymous access; attaches user when a valid JWT is present. */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser>(err: Error | null, user: TUser): TUser | null {
    if (err || !user) {
      return null;
    }
    return user;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      const result = super.canActivate(context);
      if (typeof result === 'boolean') {
        return result;
      }
      if (isObservable(result)) {
        return await lastValueFrom(result as Observable<boolean>);
      }
      return await result;
    } catch {
      return true;
    }
  }
}
