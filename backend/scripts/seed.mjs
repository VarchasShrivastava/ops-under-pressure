import 'dotenv/config';
import { Pool } from 'pg';
import bcrypt from 'bcryptjs';

const connectionString = process.env.DATABASE_URL_OWNER;

if (!connectionString) {
  throw new Error('DATABASE_URL_OWNER is missing from backend/.env');
}

const pool = new Pool({ connectionString });

const demoUsers = [
  {
    email: 'admin@ops.local',
    name: 'System Administrator',
    password: 'AdminLocal123!',
    isAdmin: true,
  },
  {
    email: 'lead@ops.local',
    name: 'Operations Lead',
    password: 'LeadLocal123!',
    isAdmin: false,
  },
  {
    email: 'member@ops.local',
    name: 'Operations Member',
    password: 'MemberLocal123!',
    isAdmin: false,
  },
  {
    email: 'payments.lead@ops.local',
    name: 'Payments Lead',
    password: 'PaymentsLead123!',
    isAdmin: false,
  },
];

async function main() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const teams = new Map();

    for (const [name, slug] of [
      ['Operations', 'operations'],
      ['Payments', 'payments'],
    ]) {
      const result = await client.query(
        `INSERT INTO teams (name, slug)
         VALUES ($1, $2)
         ON CONFLICT (slug)
         DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, slug],
      );

      teams.set(slug, result.rows[0].id);
    }

    const users = new Map();

    for (const user of demoUsers) {
      const passwordHash = await bcrypt.hash(user.password, 10);

      const existing = await client.query(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [user.email],
      );

      let userId;

      if (existing.rowCount > 0) {
        userId = existing.rows[0].id;

        await client.query(
          `UPDATE users
           SET display_name = $1,
               password_hash = $2,
               is_admin = $3,
               is_active = true
           WHERE id = $4`,
          [user.name, passwordHash, user.isAdmin, userId],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO users
             (email, display_name, password_hash, is_admin, is_active)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id`,
          [user.email, user.name, passwordHash, user.isAdmin],
        );

        userId = inserted.rows[0].id;
      }

      users.set(user.email, userId);
    }

    const memberships = [
      ['lead@ops.local', 'operations', 'lead'],
      ['member@ops.local', 'operations', 'member'],
      ['payments.lead@ops.local', 'payments', 'lead'],
    ];

    for (const [email, slug, role] of memberships) {
      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [teams.get(slug), users.get(email), role],
      );
    }

    await client.query('COMMIT');

    console.log('\nDemo users seeded successfully.');
    console.log('Development-only credentials:\n');

    for (const user of demoUsers) {
      console.log(`${user.email} / ${user.password}`);
    }
  } catch (error) {
    await client.query('ROLLBACK');
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
