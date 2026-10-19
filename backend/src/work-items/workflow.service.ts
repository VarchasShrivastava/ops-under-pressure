import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { PolicyService } from '../authorization/policy.service.js';
import type { ApprovalDecisionDto } from './dto/approval-decision.dto.js';

type WorkflowItem = {
  id: string;
  teamId: string;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  createdBy: string;
  assigneeId: string | null;
  version: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const ITEM_COLUMNS = `
  id,
  team_id AS "teamId",
  title,
  description,
  type,
  status,
  priority,
  created_by AS "createdBy",
  assignee_id AS "assigneeId",
  version,
  approval_status AS "approvalStatus",
  approved_by AS "approvedBy",
  approved_at AS "approvedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function rowsOf<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }

  return Array.isArray(result) ? (result as T[]) : [];
}

@Injectable()
export class WorkflowService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
  ) {}

  async startWork(user: AuthenticatedUser, itemId: string) {
    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      throw new NotFoundException('Work item not found');
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        `SELECT ${ITEM_COLUMNS}
         FROM work_items
         WHERE id = $1 AND team_id = ANY($2::uuid[])
         FOR UPDATE`,
        [itemId, teamIds],
      );

      const item = rowsOf<WorkflowItem>(result)[0];

      if (!item) {
        throw new NotFoundException('Work item not found');
      }

      const allowed = await this.policy.can(user, 'edit', {
        teamId: item.teamId,
        createdBy: item.createdBy,
        status: item.status,
        approvalStatus: item.approvalStatus,
      });

      if (!allowed) {
        throw new ForbiddenException('You cannot start this work item');
      }

      // Treat repeated start requests as a no-op.
      if (item.status === 'in_progress') {
        return item;
      }

      if (item.status !== 'open') {
        throw new ConflictException({
          code: 'INVALID_WORKFLOW_TRANSITION',
          message: 'Only open work items can be started',
          currentItem: item,
        });
      }

      if (item.assigneeId !== user.id) {
        throw new ForbiddenException(
          'Only the assigned user can start this work item',
        );
      }

      const updatedResult = await manager.query(
        `UPDATE work_items
         SET status = 'in_progress'
         WHERE id = $1 AND status = 'open'
         RETURNING ${ITEM_COLUMNS}`,
        [item.id],
      );

      const updated = rowsOf<WorkflowItem>(updatedResult)[0];

      if (!updated?.id || updated.version == null) {
        throw new Error('Unexpected start-work UPDATE result');
      }

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         VALUES ($1, $2, $3, 'status_changed', $4::jsonb)`,
        [
          updated.id,
          updated.version,
          user.id,
          JSON.stringify({ from: 'open', to: 'in_progress' }),
        ],
      );

      return updated;
    });
  }
  async requestApproval(user: AuthenticatedUser, itemId: string) {
    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      throw new NotFoundException('Work item not found');
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        `SELECT ${ITEM_COLUMNS}
         FROM work_items
         WHERE id = $1 AND team_id = ANY($2::uuid[])
         FOR UPDATE`,
        [itemId, teamIds],
      );

      const item = rowsOf<WorkflowItem>(result)[0];

      if (!item) {
        throw new NotFoundException('Work item not found');
      }

      const allowed = await this.policy.can(user, 'edit', {
        teamId: item.teamId,
        createdBy: item.createdBy,
        status: item.status,
        approvalStatus: item.approvalStatus,
      });

      if (!allowed) {
        throw new ForbiddenException(
          'You cannot request approval for this item',
        );
      }

      // Repeating the request while already pending does not create
      // another version or another event.
      if (
        item.status === 'awaiting_approval' &&
        item.approvalStatus === 'pending'
      ) {
        return item;
      }

      if (item.status !== 'in_progress') {
        throw new ConflictException({
          code: 'INVALID_WORKFLOW_TRANSITION',
          message: 'Only in-progress items can be submitted for approval',
          currentItem: item,
        });
      }

      const updatedResult = await manager.query(
        `UPDATE work_items
         SET status = 'awaiting_approval',
             approval_status = 'pending',
             approved_by = NULL,
             approved_at = NULL
         WHERE id = $1
         RETURNING ${ITEM_COLUMNS}`,
        [item.id],
      );

      const updated = rowsOf<WorkflowItem>(updatedResult)[0];

      if (!updated?.id || updated.version == null) {
        throw new Error('Unexpected workflow UPDATE result');
      }

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         VALUES ($1, $2, $3, 'approval_requested', $4::jsonb)`,
        [
          updated.id,
          updated.version,
          user.id,
          JSON.stringify({
            from: item.status,
            to: 'awaiting_approval',
          }),
        ],
      );

      return updated;
    });
  }

  async decideApproval(
    user: AuthenticatedUser,
    itemId: string,
    dto: ApprovalDecisionDto,
  ) {
    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      throw new NotFoundException('Work item not found');
    }

    return this.dataSource.transaction(async (manager) => {
      const result = await manager.query(
        `SELECT ${ITEM_COLUMNS}
         FROM work_items
         WHERE id = $1 AND team_id = ANY($2::uuid[])
         FOR UPDATE`,
        [itemId, teamIds],
      );

      const item = rowsOf<WorkflowItem>(result)[0];

      if (!item) {
        throw new NotFoundException('Work item not found');
      }

      if (
        item.status !== 'awaiting_approval' ||
        item.approvalStatus !== 'pending'
      ) {
        throw new ConflictException({
          code: 'NOT_AWAITING_APPROVAL',
          message: 'This item has no pending approval decision',
          currentItem: item,
        });
      }

      const allowed = await this.policy.can(user, 'approve', {
        teamId: item.teamId,
        createdBy: item.createdBy,
        status: item.status,
        approvalStatus: item.approvalStatus,
      });

      if (!allowed) {
        throw new ForbiddenException(
          'Approval requires a team lead who did not create the item',
        );
      }

      const approved = dto.decision === 'approve';
      const nextStatus = approved ? 'resolved' : 'in_progress';
      const nextApprovalStatus = approved ? 'approved' : 'rejected';
      const eventType = approved ? 'approved' : 'rejected';

      const updatedResult = await manager.query(
        `UPDATE work_items
         SET status = $2,
             approval_status = $3,
             approved_by = $4,
             approved_at = now()
         WHERE id = $1
         RETURNING ${ITEM_COLUMNS}`,
        [item.id, nextStatus, nextApprovalStatus, user.id],
      );

      const updated = rowsOf<WorkflowItem>(updatedResult)[0];

      if (!updated?.id || updated.version == null) {
        throw new Error('Unexpected approval UPDATE result');
      }

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          updated.id,
          updated.version,
          user.id,
          eventType,
          JSON.stringify({
            decision: dto.decision,
            from: item.status,
            to: nextStatus,
          }),
        ],
      );

      return updated;
    });
  }
}
