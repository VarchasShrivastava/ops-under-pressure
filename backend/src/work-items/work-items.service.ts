import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AuthenticatedUser } from '../auth/jwt-auth.guard.js';
import { PolicyService } from '../authorization/policy.service.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { requestHash } from '../idempotency/request-hash.js';
import type { ListWorkItemsDto } from './dto/list-work-items.dto.js';
import type { CreateWorkItemDto } from './dto/create-work-item.dto.js';

type WorkItemRow = {
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
  approvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const ITEM_COLUMNS = `
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
  w.updated_at AS "updatedAt"
`;

@Injectable()
export class WorkItemsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly policy: PolicyService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async create(
    user: AuthenticatedUser,
    dto: CreateWorkItemDto,
    idempotencyKey: string,
  ) {
    const teams = await this.dataSource.query(
      'SELECT id FROM teams WHERE id = $1',
      [dto.teamId],
    );

    if (!teams.length) {
      throw new NotFoundException('Team not found');
    }

    const allowed = await this.policy.can(user, 'create', {
      teamId: dto.teamId,
    });

    if (!allowed) {
      throw new ForbiddenException('You cannot create work in this team');
    }

    const normalized = {
      teamId: dto.teamId,
      title: dto.title.trim(),
      description: dto.description ?? '',
      type: dto.type ?? 'operational_task',
      priority: dto.priority ?? 'medium',
    };

    const hash = requestHash('POST', '/work-items', normalized);

    return this.idempotency.execute(
      user.id,
      idempotencyKey,
      hash,
      async (manager) => {
        const rows = (await manager.query(
          `INSERT INTO work_items
             (team_id, title, description, type, priority, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING
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
             updated_at AS "updatedAt"`,
          [
            normalized.teamId,
            normalized.title,
            normalized.description,
            normalized.type,
            normalized.priority,
            user.id,
          ],
        )) as WorkItemRow[];

        const item = rows[0];

        await manager.query(
          `INSERT INTO item_events
             (item_id, seq, actor_id, event_type, payload)
           VALUES ($1, $2, $3, 'created', $4::jsonb)`,
          [
            item.id,
            item.version,
            user.id,
            JSON.stringify({
              title: item.title,
              teamId: item.teamId,
            }),
          ],
        );

        return { status: 201, body: item };
      },
    );
  }

  async list(user: AuthenticatedUser, filters: ListWorkItemsDto) {
    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      return { items: [], nextCursor: null };
    }

    if (filters.teamId && !teamIds.includes(filters.teamId)) {
      return { items: [], nextCursor: null };
    }

    const params: unknown[] = [teamIds];
    const conditions = ['w.team_id = ANY($1::uuid[])'];

    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.teamId) {
      conditions.push(`w.team_id = ${addParam(filters.teamId)}::uuid`);
    }

    if (filters.status) {
      conditions.push(`w.status = ${addParam(filters.status)}`);
    }

    if (filters.priority) {
      conditions.push(`w.priority = ${addParam(filters.priority)}`);
    }

    if (filters.q?.trim()) {
      const searchParam = addParam(filters.q.trim());
      conditions.push(
        `w.search_document @@ websearch_to_tsquery('english', ${searchParam})`,
      );
    }

    if (filters.cursor) {
      const cursor = this.decodeCursor(filters.cursor);
      const dateParam = addParam(cursor.createdAt);
      const idParam = addParam(cursor.id);

      conditions.push(
        `(w.created_at, w.id) < (${dateParam}::timestamptz, ${idParam}::uuid)`,
      );
    }

    const limitParam = addParam((filters.limit ?? 25) + 1);

    const fetched = (await this.dataSource.query(
      `SELECT ${ITEM_COLUMNS}
       FROM work_items w
       WHERE ${conditions.join(' AND ')}
       ORDER BY w.created_at DESC, w.id DESC
       LIMIT ${limitParam}`,
      params,
    )) as WorkItemRow[];

    const hasMore = fetched.length > (filters.limit ?? 25);
    const items = fetched.slice(0, filters.limit ?? 25);
    const last = items[items.length - 1];

    return {
      items,
      nextCursor: hasMore && last ? this.encodeCursor(last) : null,
    };
  }

  async findOne(user: AuthenticatedUser, id: string) {
    const teamIds = await this.policy.accessibleTeamIds(user);

    if (!teamIds.length) {
      throw new NotFoundException('Work item not found');
    }

    const rows = (await this.dataSource.query(
      `SELECT ${ITEM_COLUMNS}
       FROM work_items w
       WHERE w.id = $1
         AND w.team_id = ANY($2::uuid[])`,
      [id, teamIds],
    )) as WorkItemRow[];

    const item = rows[0];

    if (!item) {
      throw new NotFoundException('Work item not found');
    }

    const allowed = await this.policy.can(user, 'view', {
      teamId: item.teamId,
      createdBy: item.createdBy,
      status: item.status,
      approvalStatus: item.approvalStatus,
    });

    if (!allowed) {
      throw new NotFoundException('Work item not found');
    }

    const timeline = await this.dataSource.query(
      `SELECT
         e.id,
         'event'::text AS "entryType",
         e.event_type AS "type",
         e.payload AS "payload",
         NULL::text AS "body",
         e.actor_id AS "actorId",
         u.display_name AS "actorName",
         e.created_at AS "createdAt"
       FROM item_events e
       JOIN users u ON u.id = e.actor_id
       WHERE e.item_id = $1

       UNION ALL

       SELECT
         c.id,
         'comment'::text AS "entryType",
         'comment'::text AS "type",
         NULL::jsonb AS "payload",
         c.body AS "body",
         c.user_id AS "actorId",
         u.display_name AS "actorName",
         c.created_at AS "createdAt"
       FROM comments c
       JOIN users u ON u.id = c.user_id
       WHERE c.item_id = $1

       ORDER BY "createdAt" ASC, id ASC`,
      [item.id],
    );

    return { ...item, timeline };
  }

  private encodeCursor(item: WorkItemRow): string {
    const createdAt =
      item.createdAt instanceof Date
        ? item.createdAt.toISOString()
        : item.createdAt;

    return Buffer.from(
      JSON.stringify({ createdAt, id: item.id }),
    ).toString('base64url');
  }

  private decodeCursor(cursor: string): {
    createdAt: string;
    id: string;
  } {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );

      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Invalid cursor');
      }

      const value = parsed as Record<string, unknown>;

      if (
        typeof value.createdAt !== 'string' ||
        Number.isNaN(Date.parse(value.createdAt)) ||
        typeof value.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value.id,
        )
      ) {
        throw new Error('Invalid cursor');
      }

      return { createdAt: value.createdAt, id: value.id };
    } catch {
      throw new BadRequestException('Invalid pagination cursor');
    }
  }
}
