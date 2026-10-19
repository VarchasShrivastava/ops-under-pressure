import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DataSource } from 'typeorm';
import { IdempotencyService } from './idempotency.service.js';
import { requestHash } from './request-hash.js';

describe('IdempotencyService integration', () => {
  let db: DataSource;
  let service: IdempotencyService;
  let teamId: string;
  let leadId: string;
  let memberId: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL_OWNER;
    if (!url) throw new Error('DATABASE_URL_OWNER is missing');

    db = new DataSource({
      type: 'postgres',
      url,
      synchronize: false,
      logging: false,
    });

    await db.initialize();
    service = new IdempotencyService(db);

    const teams = await db.query(
      "SELECT id FROM teams WHERE slug = 'operations'",
    );
    const leads = await db.query(
      "SELECT id FROM users WHERE email = 'lead@ops.local'",
    );
    const members = await db.query(
      "SELECT id FROM users WHERE email = 'member@ops.local'",
    );

    teamId = teams[0].id;
    leadId = leads[0].id;
    memberId = members[0].id;
  });

  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
  });

  async function createAssignedItem() {
    return db.transaction(async (manager) => {
      const inserted = await manager.query(
        `INSERT INTO work_items (team_id, title, created_by)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [teamId, `Idempotency test ${randomUUID()}`, leadId],
      );

      const itemId = inserted[0].id;

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         SELECT id, version, $2, 'created', $3::jsonb
         FROM work_items WHERE id = $1`,
        [itemId, leadId, JSON.stringify({})],
      );

      await manager.query(
        `UPDATE work_items
         SET assignee_id = $1, status = 'in_progress'
         WHERE id = $2`,
        [memberId, itemId],
      );

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         SELECT id, version, $2, 'assigned', $3::jsonb
         FROM work_items WHERE id = $1`,
        [
          itemId,
          leadId,
          JSON.stringify({ from: null, to: memberId }),
        ],
      );

      return itemId;
    });
  }

  it('replays a stored 409 after the item state changes', async () => {
    const itemId = await createAssignedItem();
    const key = `conflict-${randomUUID()}`;
    const hash = requestHash(
      'POST',
      `/work-items/${itemId}/claim`,
      { itemId },
    );

    const first = await service.execute(
      leadId,
      key,
      hash,
      async (manager) => {
        const rows = await manager.query(
          `SELECT id, assignee_id, status, version
           FROM work_items WHERE id = $1`,
          [itemId],
        );

        const item = rows[0];

        return {
          status: 409,
          body: {
            code: 'ALREADY_ASSIGNED',
            item: {
              id: item.id,
              assigneeId: item.assignee_id,
              status: item.status,
              version: item.version,
            },
          },
        };
      },
    );

    expect(first.status).toBe(409);

    await db.transaction(async (manager) => {
      await manager.query(
        `UPDATE work_items
         SET status = 'resolved'
         WHERE id = $1`,
        [itemId],
      );

      await manager.query(
        `INSERT INTO item_events
           (item_id, seq, actor_id, event_type, payload)
         SELECT id, version, $2, 'status_changed', $3::jsonb
         FROM work_items WHERE id = $1`,
        [
          itemId,
          leadId,
          JSON.stringify({
            from: 'in_progress',
            to: 'resolved',
          }),
        ],
      );
    });

    let callbackRan = false;

    const retry = await service.execute(
      leadId,
      key,
      hash,
      async () => {
        callbackRan = true;
        return {
          status: 200,
          body: { message: 'This must not run' },
        };
      },
    );

    expect(retry).toEqual(first);
    expect(retry.status).toBe(409);
    expect(callbackRan).toBe(false);

    const records = await db.query(
      `SELECT response_status
       FROM idempotency_records
       WHERE user_id = $1 AND idempotency_key = $2`,
      [leadId, key],
    );

    expect(records).toHaveLength(1);
    expect(Number(records[0].response_status)).toBe(409);
  });

  it('rolls back the idempotency key after an unexpected server error', async () => {
    const key = `server-error-${randomUUID()}`;
    const hash = requestHash(
      'POST',
      '/work-items/test-failure',
      { failure: true },
    );

    await expect(
      service.execute(leadId, key, hash, async () => {
        throw new Error('forced server failure');
      }),
    ).rejects.toThrow('forced server failure');

    const records = await db.query(
      `SELECT idempotency_key
       FROM idempotency_records
       WHERE user_id = $1 AND idempotency_key = $2`,
      [leadId, key],
    );

    expect(records).toHaveLength(0);
  });
});
