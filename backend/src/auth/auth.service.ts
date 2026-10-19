import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { DataSource } from 'typeorm';

type DatabaseUser = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  is_admin: boolean;
  is_active: boolean;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string) {
    const users = (await this.dataSource.query(
      `SELECT id, email, display_name, password_hash, is_admin, is_active
       FROM users
       WHERE lower(email) = lower($1)
       LIMIT 1`,
      [email.trim()],
    )) as DatabaseUser[];

    const user = users[0];

    if (
      !user ||
      !user.is_active ||
      !(await compare(password, user.password_hash))
    ) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
    });

    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 3600,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        isAdmin: user.is_admin,
      },
    };
  }

  async getProfile(userId: string) {
    const users = (await this.dataSource.query(
      `SELECT id, email, display_name, is_admin, is_active
       FROM users
       WHERE id = $1`,
      [userId],
    )) as Array<{
      id: string;
      email: string;
      display_name: string;
      is_admin: boolean;
      is_active: boolean;
    }>;

    const user = users[0];

    if (!user || !user.is_active) {
      throw new UnauthorizedException('Account is no longer available');
    }

    const teams = await this.dataSource.query(
      `SELECT t.id, t.name, t.slug, tm.role
       FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = $1
       ORDER BY t.slug`,
      [user.id],
    );

    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      isAdmin: user.is_admin,
      teams,
    };
  }
}
