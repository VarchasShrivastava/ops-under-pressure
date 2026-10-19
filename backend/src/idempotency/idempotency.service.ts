import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

export type StoredResponse = {
  status: number;
  body: unknown;
};

class RollbackResponse extends Error {
  constructor(readonly result: StoredResponse) {
    super('Response must be returned after transaction rollback');
  }
}

@Injectable()
export class IdempotencyService {
  constructor(private readonly dataSource: DataSource) {}

  async execute(
    userId: string,
    key: string,
    hash: string,
    operation: (manager: EntityManager) => Promise<StoredResponse>,
  ): Promise<StoredResponse> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        // Expired keys may be reused.
        await manager.query(
          `DELETE FROM idempotency_records
           WHERE user_id = $1
             AND idempotency_key = $2
             AND expires_at <= now()`,
          [userId, key],
        );

        // A concurrent duplicate waits on the unique key until the
        // first transaction commits or rolls back.
        const inserted = await manager.query(
          `INSERT INTO idempotency_records
             (user_id, idempotency_key, request_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, idempotency_key) DO NOTHING
           RETURNING idempotency_key`,
          [userId, key, hash],
        );

        if (inserted.length === 0) {
          const rows = await manager.query(
            `SELECT request_hash, response_status, response_body
             FROM idempotency_records
             WHERE user_id = $1 AND idempotency_key = $2`,
            [userId, key],
          );

          const previous = rows[0];

          if (!previous) {
            throw new Error('Idempotency record disappeared unexpectedly');
          }

          if (previous.request_hash !== hash) {
            return {
              status: 422,
              body: {
                code: 'IDEMPOTENCY_KEY_REUSED',
                message: 'This key was already used for a different request',
              },
            };
          }

          if (
            previous.response_status === null ||
            previous.response_body === null
          ) {
            throw new Error('Stored idempotency response is incomplete');
          }

          // Replay exactly the previously stored HTTP status and body.
          return {
            status: Number(previous.response_status),
            body: previous.response_body,
          };
        }

        const result = await operation(manager);

        // Persist only successful responses and expected conflicts.
        // Roll back keys for 404, other 4xx, and all 5xx responses.
        const shouldPersist =
          (result.status >= 200 && result.status < 300) ||
          result.status === 409;

        if (!shouldPersist) {
          throw new RollbackResponse(result);
        }

        await manager.query(
          `UPDATE idempotency_records
           SET response_status = $3,
               response_body = $4::jsonb,
               completed_at = now(),
               expires_at = now() + interval '24 hours'
           WHERE user_id = $1 AND idempotency_key = $2`,
          [
            userId,
            key,
            result.status,
            JSON.stringify(result.body),
          ],
        );

        return result;
      });
    } catch (error) {
      if (error instanceof RollbackResponse) {
        return error.result;
      }

      throw error;
    }
  }
}
