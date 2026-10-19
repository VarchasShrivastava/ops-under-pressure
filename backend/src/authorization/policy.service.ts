import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';

export type PolicyAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'claim'
  | 'comment'
  | 'approve';

export type PolicyItem = {
  teamId: string;
  createdBy?: string;
  status?: string;
  approvalStatus?: string;
};

@Injectable()
export class PolicyService {
  constructor(private readonly dataSource: DataSource) {}

  async accessibleTeamIds(user: AuthenticatedUser): Promise<string[]> {
    if (user.isAdmin) {
      const rows = await this.dataSource.query(
        'SELECT id FROM teams ORDER BY id',
      );

      return rows.map((row: { id: string }) => row.id);
    }

    const rows = await this.dataSource.query(
      `SELECT team_id
       FROM team_memberships
       WHERE user_id = $1
       ORDER BY team_id`,
      [user.id],
    );

    return rows.map((row: { team_id: string }) => row.team_id);
  }

  async can(
    user: AuthenticatedUser,
    action: PolicyAction,
    item: PolicyItem,
  ): Promise<boolean> {
    const memberships = await this.dataSource.query(
      `SELECT role
       FROM team_memberships
       WHERE user_id = $1 AND team_id = $2
       LIMIT 1`,
      [user.id, item.teamId],
    );

    const teamRole: string | undefined = memberships[0]?.role;

    // Global administrators may access team resources, but approval
    // still requires team-lead membership and cannot be self-approved.
    const hasTeamAccess = user.isAdmin || Boolean(teamRole);

    if (!hasTeamAccess) {
      return false;
    }

    if (action === 'approve') {
      return (
        teamRole === 'lead' &&
        item.createdBy !== user.id &&
        item.status === 'awaiting_approval' &&
        item.approvalStatus === 'pending'
      );
    }

    return true;
  }
}
