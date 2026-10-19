import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { PolicyService } from '../authorization/policy.service.js';
import type { UpdateWorkItemDto } from './dto/update-work-item.dto.js';

type EditedWorkItem = {
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

const COLUMNS = `
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

function normalizeRows<T>(result: unknown): T[] {
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
export class WorkItemEditsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
  ) {}

  async update(
    user: AuthenticatedUser,
    itemId: string,
    expectedVersion: number,
    dto: UpdateWorkItemDto,
  ) {
    if (Object.values(dto).some((value) => value === null)) {
      throw new BadRequestException('Fields cannot be null');
    }

    const changes: Record<string, string> = {};

    if (dto.title !== undefined) {
      const title = dto.title.trim();
      if (!title) {
        throw new BadRequestException('Title cannot be empty');
      }
      changes.title = title;
    }

    if (dto.description !== undefined) {
      changes.description = dto.description;
    }

    if (dto.type !== undefined) {
      changes.type = dto.type;
    }

    if (dto.priority !== undefined) {
      changes.priority = dto.priority;
    }

    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('At least one field must be updated');
    }

    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      throw new NotFoundException('Work item not found');
    }

    return this.dataSource.transaction(async (manager) => {
      const updateResult = await manager.query(
        `UPDATE work_items
         SET title = COALESCE($4, title),
             description = COALESCE($5, description),
             type = COALESCE($6, type),
             priority = COALESCE($7, priority)
         WHERE id = $1
           AND team_id = ANY($2::uuid[])
           AND version = $3
         RETURNING ${COLUMNS}`,
        [
          itemId,
          teamIds,
          expectedVersion,
          changes.title ?? null,
          changes.description ?? null,
          changes.type ?? null,
          changes.priority ?? null,
        ],
      );

      const rows = normalizeRows<EditedWorkItem>(updateResult);

      if (rows.length > 0) {
        const item = rows[0];

        if (!item.id || item.version == null) {
          throw new Error('Unexpected UPDATE RETURNING result shape');
        }

        await manager.query(
          `INSERT INTO item_events
             (item_id, seq, actor_id, event_type, payload)
           VALUES ($1, $2, $3, 'updated', $4::jsonb)`,
          [
            item.id,
            item.version,
            user.id,
            JSON.stringify({ changedFields: Object.keys(changes) }),
          ],
        );

        return item;
      }

      const currentResult = await manager.query(
        `SELECT ${COLUMNS}
         FROM work_items
         WHERE id = $1 AND team_id = ANY($2::uuid[])`,
        [itemId, teamIds],
      );

      const currentRows = normalizeRows<EditedWorkItem>(currentResult);
      const current = currentRows[0];

      if (!current) {
        throw new NotFoundException('Work item not found');
      }

      throw new ConflictException({
        code: 'STALE_VERSION',
        message: 'This work item changed since you last viewed it',
        currentItem: current,
      });
    });
  }
}
