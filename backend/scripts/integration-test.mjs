import 'dotenv/config';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const ownerUrl = process.env.DATABASE_URL_OWNER;

if (!ownerUrl) {
  throw new Error('DATABASE_URL_OWNER is missing from backend/.env');
}

const pool = new Pool({ connectionString: ownerUrl });

async function request(
  path,
  { method = 'GET', token, body, headers: extraHeaders = {} } = {},
) {
  const headers = { ...extraHeaders };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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

async function login(email, password) {
  const result = await request('/auth/login', {
    method: 'POST',
    body: { email, password },
  });

  assert.equal(result.status, 200, `Login failed for ${email}`);
  assert.ok(result.data.accessToken, 'Login should return a JWT');

  return result.data.accessToken;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}`);
    throw error;
  }
}

async function main() {
  const adminToken = await login(
    'admin@ops.local',
    'AdminLocal123!',
  );

  const [teamResult, adminResult] = await Promise.all([
    pool.query(`SELECT id FROM teams WHERE slug = 'operations'`),
    pool.query(`SELECT id FROM users WHERE email = 'admin@ops.local'`),
  ]);

  assert.ok(teamResult.rows[0], 'Operations team must be seeded');
  assert.ok(adminResult.rows[0], 'Admin user must be seeded');

  const teamId = teamResult.rows[0].id;
  const adminId = adminResult.rows[0].id;
  const uniqueTitle = `Integration test ${Date.now()}`;

  let item;

  await test('Invalid credentials are rejected', async () => {
    const result = await request('/auth/login', {
      method: 'POST',
      body: {
        email: 'admin@ops.local',
        password: 'DefinitelyWrong123!',
      },
    });

    assert.equal(result.status, 401);
  });

  await test('Protected endpoint rejects missing token', async () => {
    const result = await request('/auth/me');
    assert.equal(result.status, 401);
  });

  await test('Authorized user can create a work item', async () => {
    const result = await request('/work-items', {
      method: 'POST',
      token: adminToken,
      headers: {
        'Idempotency-Key': `integration-create-${Date.now()}`,
      },
      body: {
        teamId,
        title: uniqueTitle,
        description: 'Integration test item',
        type: 'operational_task',
        priority: 'high',
      },
    });

    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.version, 1);
    assert.equal(result.data.status, 'open');

    item = result.data;
  });

  await test('Creation and event are stored consistently', async () => {
    const result = await pool.query(
      `SELECT
         w.version,
         e.seq,
         e.event_type
       FROM work_items w
       JOIN item_events e ON e.item_id = w.id
       WHERE w.id = $1`,
      [item.id],
    );

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].version, 1);
    assert.equal(result.rows[0].seq, 1);
    assert.equal(result.rows[0].event_type, 'created');
  });

  await test('List and detail endpoints return the created item', async () => {
    const list = await request('/work-items?limit=100', {
      token: adminToken,
    });

    assert.equal(list.status, 200);
    assert.ok(list.data.items.some((entry) => entry.id === item.id));

    const detail = await request(`/work-items/${item.id}`, {
      token: adminToken,
    });

    assert.equal(detail.status, 200);
    assert.equal(detail.data.id, item.id);
    assert.ok(
      detail.data.timeline.some((entry) => entry.type === 'created'),
      'Timeline should contain the creation event',
    );
  });

  await test('Operations member can access Operations work', async () => {
    const token = await login('member@ops.local', 'MemberLocal123!');

    const result = await request(`/work-items/${item.id}`, { token });
    assert.equal(result.status, 200);
  });

  await test('Payments lead cannot access Operations work', async () => {
    const token = await login(
      'payments.lead@ops.local',
      'PaymentsLead123!',
    );

    const result = await request(`/work-items/${item.id}`, { token });
    assert.equal(result.status, 404);
  });

  await test('Work item without a creation event cannot commit', async () => {
    const client = await pool.connect();
    const title = `Missing event test ${Date.now()}`;
    let itemId;

    try {
      await client.query('BEGIN');

      const inserted = await client.query(
        `INSERT INTO work_items (team_id, title, created_by)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [teamId, title, adminId],
      );

      itemId = inserted.rows[0].id;

      let commitError;

      try {
        await client.query('COMMIT');
      } catch (error) {
        commitError = error;
      }

      assert.ok(commitError, 'Commit should fail without a matching event');
      assert.equal(commitError.code, '23514');

      await client.query('ROLLBACK');

      const check = await pool.query(
        'SELECT id FROM work_items WHERE id = $1',
        [itemId],
      );

      assert.equal(check.rowCount, 0, 'Failed transaction must leave no item');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  await test('Event history cannot be updated', async () => {
    await assert.rejects(
      pool.query(
        'UPDATE item_events SET payload = payload WHERE item_id = $1',
        [item.id],
      ),
      (error) => error.code === '55000',
    );
  });

  console.log('\nAll integration tests passed.');
}

main()
  .catch((error) => {
    console.error('\nIntegration tests failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
