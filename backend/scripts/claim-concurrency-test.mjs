import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const connectionString = process.env.DATABASE_URL_OWNER;

if (!connectionString) {
  throw new Error('DATABASE_URL_OWNER is missing from backend/.env');
}

const pool = new Pool({ connectionString });
const password = 'ClaimRace123!';

async function api(path, options = {}) {
  const headers = {};

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.key) {
    headers['Idempotency-Key'] = options.key;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body:
      options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: response.status, data };
}

async function login(email, userPassword) {
  const result = await api('/auth/login', {
    method: 'POST',
    body: { email, password: userPassword },
  });

  assert.equal(
    result.status,
    200,
    `Login failed for ${email}: ${JSON.stringify(result.data)}`,
  );

  return result.data;
}

async function createItem(token, teamId, title) {
  const result = await api('/work-items', {
    method: 'POST',
    token,
    key: `create-${randomUUID()}`,
    body: {
      teamId,
      title,
      description: 'Automated concurrency test',
      type: 'operational_task',
      priority: 'high',
    },
  });

  assert.equal(
    result.status,
    201,
    `Item creation failed: ${JSON.stringify(result.data)}`,
  );

  return result.data;
}

async function seedClaimUsers(teamId) {
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const users = [];

    for (let i = 1; i <= 20; i++) {
      const email = `claim-race-${String(i).padStart(2, '0')}@ops.local`;
      const displayName = `Claim Race User ${String(i).padStart(2, '0')}`;

      const existing = await client.query(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [email],
      );

      let id;

      if (existing.rowCount > 0) {
        id = existing.rows[0].id;

        await client.query(
          `UPDATE users
           SET display_name = $1,
               password_hash = $2,
               is_admin = false,
               is_active = true
           WHERE id = $3`,
          [displayName, hash, id],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO users
             (email, display_name, password_hash, is_admin, is_active)
           VALUES ($1, $2, $3, false, true)
           RETURNING id`,
          [email, displayName, hash],
        );

        id = inserted.rows[0].id;
      }

      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET role = 'member'`,
        [teamId, id],
      );

      users.push({ id, email });
    }

    await client.query('COMMIT');
    return users;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function verifyEvents(itemId) {
  const itemResult = await pool.query(
    `SELECT id, assignee_id, status, version
     FROM work_items
     WHERE id = $1`,
    [itemId],
  );

  const eventResult = await pool.query(
    `SELECT seq, event_type
     FROM item_events
     WHERE item_id = $1
     ORDER BY seq`,
    [itemId],
  );

  assert.equal(itemResult.rowCount, 1);

  const item = itemResult.rows[0];
  const events = eventResult.rows;

  assert.equal(Number(item.version), 2, 'Item should finish at version 2');
  assert.equal(events.length, 2, 'Expected exactly two events');
  assert.deepEqual(
    events.map((event) => event.event_type),
    ['created', 'claimed'],
  );
  assert.deepEqual(
    events.map((event) => Number(event.seq)),
    [1, 2],
  );

  return item;
}

async function main() {
  const teamResult = await pool.query(
    "SELECT id FROM teams WHERE slug = 'operations'",
  );
  assert.equal(teamResult.rowCount, 1, 'Operations team must exist');

  const teamId = teamResult.rows[0].id;
  const admin = await login('admin@ops.local', 'AdminLocal123!');
  const users = await seedClaimUsers(teamId);

  const tokens = await Promise.all(
    users.map(async (user) => ({
      ...user,
      token: (await login(user.email, password)).accessToken,
    })),
  );

  // Case 1: 20 different users race for the same unassigned item.
  {
    const item = await createItem(
      admin.accessToken,
      teamId,
      `Different-user claim race ${randomUUID()}`,
    );

    const results = await Promise.all(
      tokens.map((user) =>
        api(`/work-items/${item.id}/claim`, {
          method: 'POST',
          token: user.token,
          key: `claim-${randomUUID()}`,
        }),
      ),
    );

    const winners = results.filter((result) => result.status === 200);
    const conflicts = results.filter(
      (result) =>
        result.status === 409 &&
        result.data?.code === 'ALREADY_ASSIGNED',
    );

    if (winners.length !== 1 || conflicts.length !== 19) {
      console.error('Unexpected claim responses:', results);
    }

    assert.equal(winners.length, 1, 'Exactly one user must win');
    assert.equal(conflicts.length, 19, 'Nineteen users must conflict');
    assert.equal(
      winners[0].data.item.assigneeId,
      tokens.find((user) => user.id === winners[0].data.item.assigneeId)?.id,
      'Winner must be one of the seeded Operations users',
    );

    const persisted = await verifyEvents(item.id);

    assert.ok(tokens.some((user) => user.id === persisted.assignee_id));

    console.log(
      'PASS: 20 different users -> one 200, nineteen ALREADY_ASSIGNED 409s',
    );
    console.log(
      `PASS: item version ${persisted.version}, two events, one winning assignee`,
    );
  }

  // Case 2: one user submits twenty claims with different idempotency keys.
  {
    const user = tokens[0];
    const item = await createItem(
      admin.accessToken,
      teamId,
      `Same-user claim race ${randomUUID()}`,
    );

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        api(`/work-items/${item.id}/claim`, {
          method: 'POST',
          token: user.token,
          key: `same-user-${randomUUID()}`,
        }),
      ),
    );

    const unexpected = results.filter(
      (result) => result.status !== 200,
    );

    if (unexpected.length) {
      console.error('Unexpected same-user responses:', unexpected);
    }

    assert.equal(
      unexpected.length,
      0,
      'Every same-user retry should return 200',
    );

    const persisted = await verifyEvents(item.id);
    assert.equal(persisted.assignee_id, user.id);

    console.log(
      'PASS: same user, 20 parallel claims -> twenty 200 responses',
    );
    console.log(
      'PASS: same-user race produced one assignment event and version 2',
    );
  }

  console.log('\nAll claim concurrency tests passed.');
}

main()
  .catch((error) => {
    console.error('\nClaim concurrency tests failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
