import 'dotenv/config';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL_OWNER;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL_OWNER is missing from backend/.env');
}

const TOTAL = 5000;
const PREFIX = 'OPS-SEED-20261019-';
const SEED = 20261019;
const BASE_EPOCH = Date.UTC(2026, 9, 19);
const DAY_MS = 24 * 60 * 60 * 1000;

const pool = new Pool({ connectionString: DATABASE_URL });

function createRng(initialSeed) {
  let state = initialSeed >>> 0;

  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;

    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

function timestamp(random, daysBack = 180) {
  const offset = Math.floor(random() * daysBack) * DAY_MS
    + Math.floor(random() * DAY_MS);

  return new Date(BASE_EPOCH - offset).toISOString();
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      `SELECT count(*)::int AS count
       FROM work_items
       WHERE title LIKE $1`,
      [`${PREFIX}%`],
    );

    if (existing.rows[0].count > 0) {
      throw new Error(
        `Found ${existing.rows[0].count} existing seed items. ` +
        'This seed is intentionally non-destructive and will not duplicate them.',
      );
    }

    const teamResult = await client.query(
      `SELECT id, slug
       FROM teams
       WHERE slug IN ('operations', 'payments')`,
    );

    const teams = Object.fromEntries(
      teamResult.rows.map((team) => [team.slug, team.id]),
    );

    if (!teams.operations || !teams.payments) {
      throw new Error('Both Operations and Payments teams must exist.');
    }

    const userResult = await client.query(
      `SELECT id, email
       FROM users
       WHERE email IN (
         'lead@ops.local',
         'member@ops.local',
         'payments.lead@ops.local'
       )`,
    );

    const users = Object.fromEntries(
      userResult.rows.map((user) => [user.email, user.id]),
    );

    if (
      !users['lead@ops.local'] ||
      !users['member@ops.local'] ||
      !users['payments.lead@ops.local']
    ) {
      throw new Error('Required seeded users are missing.');
    }

    const random = createRng(SEED);

    const titleTemplates = [
      'Payment failure investigation',
      'Customer refund request',
      'Production incident review',
      'Compliance verification',
      'Engineering incident analysis',
      'Payment reconciliation issue',
      'Customer account investigation',
      'Operational approval follow-up',
      'Transaction processing failure',
      'Service availability review',
    ];

    const descriptions = [
      'Investigate payment failure reports, review transaction logs, and document findings.',
      'Review customer refund requests and confirm the appropriate resolution.',
      'Investigate production incidents, establish impact, and document recovery actions.',
      'Verify compliance requirements and record the outcome of the investigation.',
      'Review engineering logs, reproduce the reported fault, and coordinate remediation.',
      'Reconcile transaction records and identify discrepancies requiring follow-up.',
      'Investigate customer account reports and determine the required operational action.',
      'Review outstanding operational work and identify the next action or approval.',
      'Examine processing errors and identify the root cause and corrective action.',
      'Review service availability reports and coordinate the follow-up with the responsible team.',
    ];

    const types = [
      'customer_issue',
      'engineering',
      'payment_investigation',
      'production_incident',
      'compliance',
      'operational_task',
    ];

    const statuses = [
      'open',
      'in_progress',
      'resolved',
      'closed',
    ];

    const priorities = [
      'low',
      'medium',
      'high',
      'urgent',
    ];

    const rows = [];

    for (let i = 1; i <= TOTAL; i++) {
      const isOperations = random() < 0.5;
      const teamId = isOperations ? teams.operations : teams.payments;

      const createdBy = isOperations
        ? pick(random, [
            users['lead@ops.local'],
            users['member@ops.local'],
          ])
        : users['payments.lead@ops.local'];

      const assigneeId = random() < 0.65
        ? (
            isOperations
              ? pick(random, [
                  users['lead@ops.local'],
                  users['member@ops.local'],
                ])
              : users['payments.lead@ops.local']
          )
        : null;

      const templateIndex = Math.floor(random() * titleTemplates.length);
      const createdAt = timestamp(random);
      const updatedAt = new Date(
        new Date(createdAt).getTime()
          + Math.floor(random() * 7) * DAY_MS,
      ).toISOString();

      rows.push({
        teamId,
        title: `${PREFIX}${String(i).padStart(5, '0')} ${titleTemplates[templateIndex]}`,
        description: `${descriptions[templateIndex]} Reference ${String(i).padStart(5, '0')}.`,
        type: pick(random, types),
        status: pick(random, statuses),
        priority: pick(random, priorities),
        createdBy,
        assigneeId,
        createdAt,
        updatedAt,
      });
    }

    // Batch inserts keep this fast while all work remains in one transaction.
    const batchSize = 250;

    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize);
      const parameters = [];
      const tuples = [];

      for (const row of batch) {
        const base = parameters.length;

        parameters.push(
          row.teamId,
          row.title,
          row.description,
          row.type,
          row.status,
          row.priority,
          row.createdBy,
          row.assigneeId,
          row.createdAt,
          row.updatedAt,
        );

        tuples.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, ` +
          `$${base + 4}, $${base + 5}, $${base + 6}, ` +
          `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
        );
      }

      await client.query(
        `INSERT INTO work_items
           (team_id, title, description, type, status, priority,
            created_by, assignee_id, created_at, updated_at)
         VALUES ${tuples.join(', ')}`,
        parameters,
      );
    }

    // Version triggers initialize seeded rows at version 1.
    // Insert a matching creation event for every seeded work item.
    const eventResult = await client.query(
      `INSERT INTO item_events
         (item_id, seq, actor_id, event_type, payload, created_at)
       SELECT
         id,
         version,
         created_by,
         'created',
         jsonb_build_object(
           'title', title,
           'teamId', team_id,
           'seeded', true
         ),
         created_at
       FROM work_items
       WHERE title LIKE $1
       RETURNING item_id`,
      [`${PREFIX}%`],
    );

    if (eventResult.rowCount !== TOTAL) {
      throw new Error(
        `Expected ${TOTAL} creation events, got ${eventResult.rowCount}`,
      );
    }

    await client.query('COMMIT');

    console.log(`Successfully seeded ${TOTAL} work items.`);
    console.log(`Creation events inserted: ${eventResult.rowCount}`);
    console.log(`Fixed PRNG seed: ${SEED}`);
    console.log(`Item title prefix: ${PREFIX}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
