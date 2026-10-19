import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { PolicyService } from '../authorization/policy.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { requestHash } from '../idempotency/request-hash.js';
import type { StoredResponse } from '../idempotency/idempotency.service.js';

type ClaimItem = {
  id: string;
  teamId: string;
  title: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  createdBy: string;
  assigneeId: string | null;
  assigneeName?: string | null;
  version: number;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const RETURNING_COLUMNS = `
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
  // Defensive handling for drivers which wrap RETURNING rows with a count.
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
export class ClaimService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async claim(
    user: AuthenticatedUser,
    itemId: string,
    idempotencyKey: string,
  ): Promise<StoredResponse> {
    const teamIds = await this.policy.accessibleTeamIds(user);
    const path = `/work-items/${itemId}/claim`;
    const hash = requestHash('POST', path, {});

    return this.idempotency.execute(
      user.id,
      idempotencyKey,
      hash,
      async (manager: EntityManager): Promise<StoredResponse> => {
        const raw = await manager.query(
          `UPDATE work_items
           SET assignee_id = $1
           WHERE id = $2
             AND assignee_id IS NULL
             AND team_id = ANY($3::uuid[])
             AND status IN ('open', 'in_progress')
           RETURNING ${RETURNING_COLUMNS}`,
          [user.id, itemId, teamIds],
        );

        const updated = normalizeRows<ClaimItem>(raw);

        if (updated.length > 0) {
          const item = updated[0];

          await manager.query(
            `INSERT INTO item_events
               (item_id, seq, actor_id, event_type, payload)
             VALUES ($1, $2, $3, 'claimed', $4::jsonb)`,
            [
              item.id,
              item.version,
              user.id,
              JSON.stringify({ from: null, to: user.id }),
            ],
          );

          return { status: 200, body: { item } };
        }

        // The UPDATE already determined the winner. This query only
        // establishes which response the losing request should receive.
        const currentRows = normalizeRows<ClaimItem>(
          await manager.query(
            `SELECT
               w.id,
               w.team_id AS "teamId",
               w.title,
               w.description,
               w.type,
               w.status,
               w.priority,
               w.created_by AS "createdBy",
               w.assignee_id AS "assigneeId",
               w.version,
               w.approval_status AS "approvalStatus",
               w.approved_by AS "approvedBy",
               w.approved_at AS "approvedAt",
               w.created_at AS "createdAt",
               w.updated_at AS "updatedAt",
               u.display_name AS "assigneeName"
             FROM work_items w
             LEFT JOIN users u ON u.id = w.assignee_id
             WHERE w.id = $1
               AND w.team_id = ANY($2::uuid[])`,
            [itemId, teamIds],
          ),
        );

        const current = currentRows[0];

        if (!current) {
          return { status: 404, body: { message: 'Not found' } };
        }

        if (current.assigneeId === user.id) {
          return { status: 200, body: { item: current } };
        }

        if (current.assigneeId) {
          return {
            status: 409,
            body: {
              code: 'ALREADY_ASSIGNED',
              currentAssignee: current.assigneeName,
              item: current,
            },
          };
        }

        return {
          status: 409,
          body: {
            code: 'NOT_CLAIMABLE',
            status: current.status,
            item: current,
          },
        };
      },
    );
  }
}
