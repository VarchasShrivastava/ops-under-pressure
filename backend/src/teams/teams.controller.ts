import { Controller, Get, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Req } from '@nestjs/common';
import type { RequestWithUser } from '../auth/jwt-auth.guard.js';

@Controller('teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly dataSource: DataSource) {}

  @Get()
  async list(@Req() request: RequestWithUser) {
    const user: AuthenticatedUser = request.user;

    if (user.isAdmin) {
      return this.dataSource.query(
        `SELECT id, name, slug, 'admin'::text AS role
         FROM teams
         ORDER BY name`,
      );
    }

    return this.dataSource.query(
      `SELECT t.id, t.name, t.slug, tm.role
       FROM teams t
       JOIN team_memberships tm ON tm.team_id = t.id
       WHERE tm.user_id = $1
       ORDER BY t.name`,
      [user.id],
    );
  }
}
