import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1792195200000 implements MigrationInterface {
  name = 'InitialSchema1792195200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL,
        display_name text NOT NULL,
        password_hash text NOT NULL,
        is_admin boolean NOT NULL DEFAULT false,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT users_email_nonempty CHECK (length(trim(email)) > 0),
        CONSTRAINT users_display_name_nonempty
          CHECK (length(trim(display_name)) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX users_email_lower_unique
      ON users (lower(email))
    `);

    await queryRunner.query(`
      CREATE TABLE teams (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT teams_name_nonempty CHECK (length(trim(name)) > 0),
        CONSTRAINT teams_slug_format
          CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE team_memberships (
        team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role text NOT NULL DEFAULT 'member'
          CHECK (role IN ('member', 'lead')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (team_id, user_id)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX team_memberships_user_team_idx
      ON team_memberships (user_id, team_id)
    `);

    await queryRunner.query(`
      CREATE TABLE work_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        team_id uuid NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        type text NOT NULL DEFAULT 'operational_task'
          CHECK (type IN (
            'customer_issue',
            'engineering',
            'payment_investigation',
            'production_incident',
            'compliance',
            'operational_task'
          )),
        status text NOT NULL DEFAULT 'open'
          CHECK (status IN (
            'open',
            'in_progress',
            'awaiting_approval',
            'resolved',
            'closed'
          )),
        priority text NOT NULL DEFAULT 'medium'
          CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        approval_status text NOT NULL DEFAULT 'not_required'
          CHECK (approval_status IN (
            'not_required', 'pending', 'approved', 'rejected'
          )),
        approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
        approved_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        search_document tsvector GENERATED ALWAYS AS (
          setweight(
            to_tsvector('english'::regconfig, coalesce(title, '')),
            'A'
          ) ||
          setweight(
            to_tsvector('english'::regconfig, coalesce(description, '')),
            'B'
          )
        ) STORED,
        CONSTRAINT work_items_title_nonempty
          CHECK (length(trim(title)) > 0),
        CONSTRAINT work_items_approval_metadata_check CHECK (
          (
            approval_status IN ('approved', 'rejected')
            AND approved_by IS NOT NULL
            AND approved_at IS NOT NULL
          )
          OR
          (
            approval_status IN ('not_required', 'pending')
            AND approved_by IS NULL
            AND approved_at IS NULL
          )
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX work_items_team_created_id_idx
      ON work_items (team_id, created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX work_items_team_status_created_id_idx
      ON work_items (team_id, status, created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX work_items_team_priority_created_id_idx
      ON work_items (team_id, priority, created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX work_items_assignee_status_idx
      ON work_items (assignee_id, status, created_at DESC, id DESC)
    `);

    await queryRunner.query(`
      CREATE INDEX work_items_search_gin_idx
      ON work_items USING GIN (search_document)
    `);

    await queryRunner.query(`
      CREATE TABLE item_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
        seq integer NOT NULL CHECK (seq >= 1),
        actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        event_type text NOT NULL
          CHECK (event_type IN (
            'created',
            'updated',
            'assigned',
            'claimed',
            'status_changed',
            'approval_requested',
            'approved',
            'rejected'
          )),
        payload jsonb NOT NULL DEFAULT '{}'::jsonb
          CHECK (jsonb_typeof(payload) = 'object'),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT item_events_item_seq_unique UNIQUE (item_id, seq)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX item_events_item_created_idx
      ON item_events (item_id, created_at, seq)
    `);

    await queryRunner.query(`
      CREATE INDEX item_events_actor_created_idx
      ON item_events (actor_id, created_at DESC)
    `);

    await queryRunner.query(`
      CREATE TABLE comments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        body text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT comments_body_nonempty
          CHECK (length(trim(body)) > 0)
      )
    `);

    await queryRunner.query(`
      CREATE INDEX comments_item_created_idx
      ON comments (item_id, created_at, id)
    `);

    await queryRunner.query(`
      CREATE TABLE idempotency_records (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key text NOT NULL,
        request_hash text NOT NULL
          CHECK (request_hash ~ '^[0-9a-f]{64}$'),
        response_status smallint,
        response_body jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
        completed_at timestamptz,
        PRIMARY KEY (user_id, idempotency_key),
        CONSTRAINT idempotency_key_nonempty
          CHECK (length(trim(idempotency_key)) > 0),
        CONSTRAINT idempotency_response_consistency CHECK (
          (
            response_status IS NULL
            AND response_body IS NULL
            AND completed_at IS NULL
          )
          OR
          (
            response_status BETWEEN 100 AND 599
            AND response_body IS NOT NULL
            AND completed_at IS NOT NULL
          )
        )
      )
    `);

    await queryRunner.query(`
      CREATE INDEX idempotency_records_expires_idx
      ON idempotency_records (expires_at)
    `);

    // The database owns version increments, not the application.
    await queryRunner.query(`
      CREATE FUNCTION set_work_item_version()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          NEW.version := 1;
        ELSE
          NEW.version := OLD.version + 1;
          NEW.updated_at := clock_timestamp();
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER work_items_set_version
      BEFORE INSERT OR UPDATE ON work_items
      FOR EACH ROW EXECUTE FUNCTION set_work_item_version()
    `);

    // An event must describe the item's current version.
    await queryRunner.query(`
      CREATE FUNCTION enforce_item_event_current_version()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        current_version integer;
      BEGIN
        SELECT version INTO current_version
        FROM work_items
        WHERE id = NEW.item_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Work item % does not exist', NEW.item_id
            USING ERRCODE = '23503';
        END IF;

        IF NEW.seq <> current_version THEN
          RAISE EXCEPTION
            'Event sequence % must equal current work item version %',
            NEW.seq, current_version
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER item_events_check_current_version
      BEFORE INSERT ON item_events
      FOR EACH ROW EXECUTE FUNCTION enforce_item_event_current_version()
    `);

    // At commit, every inserted/updated work-item version must have an event.
    await queryRunner.query(`
      CREATE FUNCTION require_work_item_event()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM item_events
          WHERE item_id = NEW.id AND seq = NEW.version
        ) THEN
          RAISE EXCEPTION
            'Work item % version % requires exactly one event',
            NEW.id, NEW.version
            USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER work_items_require_event
      AFTER INSERT OR UPDATE ON work_items
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION require_work_item_event()
    `);

    // History can be appended, but never rewritten or removed.
    await queryRunner.query(`
      CREATE FUNCTION reject_item_event_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'item_events are append-only; % is forbidden', TG_OP
          USING ERRCODE = '55000';
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE TRIGGER item_events_no_update_delete
      BEFORE UPDATE OR DELETE ON item_events
      FOR EACH ROW EXECUTE FUNCTION reject_item_event_mutation()
    `);

    await queryRunner.query(`
      CREATE TRIGGER item_events_no_truncate
      BEFORE TRUNCATE ON item_events
      FOR EACH STATEMENT EXECUTE FUNCTION reject_item_event_mutation()
    `);

    // An idempotency record cannot be committed without a stored response.
    await queryRunner.query(`
      CREATE FUNCTION require_idempotency_result()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        current_status smallint;
      BEGIN
        SELECT response_status INTO current_status
        FROM idempotency_records
        WHERE user_id = NEW.user_id
          AND idempotency_key = NEW.idempotency_key;

        IF FOUND AND current_status IS NULL THEN
          RAISE EXCEPTION
            'Idempotency record must have a completed response'
            USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
      END;
      $$
    `);

    await queryRunner.query(`
      CREATE CONSTRAINT TRIGGER idempotency_record_requires_result
      AFTER INSERT OR UPDATE ON idempotency_records
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION require_idempotency_result()
    `);

    // Runtime role: restricted privileges; migrations continue as ops_owner.
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO app_user`);

    await queryRunner.query(`
      GRANT SELECT ON users, teams, team_memberships TO app_user
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE ON work_items TO app_user
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT ON item_events TO app_user
    `);

    await queryRunner.query(`
      REVOKE UPDATE, DELETE, TRUNCATE ON item_events FROM app_user
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT ON comments TO app_user
    `);

    await queryRunner.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE
      ON idempotency_records TO app_user
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_records`);
    await queryRunner.query(`DROP TABLE IF EXISTS comments`);
    await queryRunner.query(`DROP TABLE IF EXISTS item_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS work_items`);
    await queryRunner.query(`DROP TABLE IF EXISTS team_memberships`);
    await queryRunner.query(`DROP TABLE IF EXISTS teams`);
    await queryRunner.query(`DROP TABLE IF EXISTS users`);

    await queryRunner.query(
      `DROP FUNCTION IF EXISTS require_idempotency_result() CASCADE`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS reject_item_event_mutation() CASCADE`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS require_work_item_event() CASCADE`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS enforce_item_event_current_version() CASCADE`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS set_work_item_version() CASCADE`,
    );
  }
}
