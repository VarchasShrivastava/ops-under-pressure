import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import type { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
};

export type RequestWithUser = Request & {
  user: AuthenticatedUser;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const authorization = request.headers.authorization;
    const [scheme, token] = authorization?.split(' ') ?? [];

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Bearer token required');
    }

    let payload: { sub?: string };

    try {
      payload = await this.jwtService.verifyAsync<{ sub?: string }>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (!payload.sub) {
      throw new UnauthorizedException('Invalid token subject');
    }

    const users = (await this.dataSource.query(
      `SELECT id, email, display_name, is_admin
       FROM users
       WHERE id = $1 AND is_active = true`,
      [payload.sub],
    )) as Array<{
      id: string;
      email: string;
      display_name: string;
      is_admin: boolean;
    }>;

    const user = users[0];

    if (!user) {
      throw new UnauthorizedException('Account is no longer available');
    }

    request.user = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin,
    };

    return true;
  }
}
