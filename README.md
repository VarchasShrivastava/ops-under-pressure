# ShiftOps — Operations Under Pressure

ShiftOps is a team-based work-item management application built around safe state transitions, team-level authorization, concurrency control, idempotent requests, and auditable event history.

The project contains a React + TypeScript frontend, a NestJS API, and a PostgreSQL database.

## Features

- JWT authentication with bcrypt password verification.
- Team-scoped access with explicit administrator permissions.
- Work-item creation, listing, searching, filtering, and detail views.
- Atomic claims so competing users cannot both claim the same unassigned item.
- Optimistic concurrency control for edits using version ETags and `If-Match`.
- Idempotency keys for work-item creation and claims.
- A controlled workflow for starting work, requesting approval, and approving or rejecting work.
- Append-only work-item event history, shown in each item's timeline.
- Database checks that keep work-item versions and event sequence numbers consistent.
- PostgreSQL full-text search and indexes for common list queries.
- Cursor-based pagination in the work-item API.
- Docker Compose for local PostgreSQL development.

## Technology stack

| Area | Technology |
|---|---|
| Frontend | React, TypeScript, Vite |
| API | NestJS, TypeScript |
| Database | PostgreSQL 17 |
| ORM and migrations | TypeORM |
| Authentication | JWT, bcryptjs |
| Request validation | class-validator, class-transformer |
| Tests | Vitest and Node.js integration/concurrency scripts |
| Local infrastructure | Docker Compose |

## Architecture at a glance

The frontend calls the NestJS API over HTTP. Protected endpoints validate the JWT and apply server-side team-access policy before reading or mutating work items.

PostgreSQL enforces important persistence invariants. Work-item versions are incremented by a database trigger; a deferred database constraint requires a matching event for a committed item mutation. The normal application connection uses a restricted database role. The owner connection is reserved for migrations, seeding, and tests that need database-level assertions.

## Prerequisites

Install:

- Node.js and npm compatible with the versions declared by the project.
- Docker Desktop with Docker Compose support.
- Git.

The commands below use PowerShell and assume they are run from the repository root unless otherwise indicated.

## Local setup

### 1. Create local environment files

```powershell
Copy-Item .env.example .env
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
```

The example files contain local-development placeholders. The connection strings in `backend/.env` must use the same database name and passwords configured in the root `.env`. Do not commit real `.env` files or production secrets.

If you already have a PostgreSQL Docker volume initialized, changing the root password variables will not automatically change the passwords stored in that existing database. For a fresh local setup, Docker initializes the role and database using the environment values when the volume is first created.

### 2. Start PostgreSQL

From the repository root:

```powershell
docker compose up -d db
docker compose ps
```

Wait until PostgreSQL is healthy before continuing. The service binds to `127.0.0.1:5432` on the host.

On the first initialization of an empty database volume, the scripts under `database/init` create the restricted application role. PostgreSQL does not rerun those initialization scripts every time the container restarts.

### 3. Install backend dependencies, migrate, and seed

```powershell
cd backend
npm install
npm run migration:run
node scripts/seed.mjs
```

The migration command uses `DATABASE_URL_OWNER`. The seed script creates or updates the local demo users, teams, and memberships.

### 4. Start the backend

In the backend terminal:

```powershell
npm run start:dev
```

The API listens at `http://localhost:3000`. Keep this terminal running.

### 5. Install and start the frontend

Open a second PowerShell terminal:

```powershell
cd C:\Users\<your-user>\Projects\ops-under-pressure\frontend
npm install
npm run dev
```

Alternatively, navigate to your own repository's `frontend` directory instead of using the example path.

Open the local URL printed by Vite, normally `http://localhost:5173`. The frontend reads `VITE_API_BASE_URL` from `frontend/.env`.

## Local demo accounts

The seed script supplies these development accounts:

| Role | Email | Password |
|---|---|---|
| Administrator | `admin@ops.local` | `AdminLocal123!` |
| Operations lead | `lead@ops.local` | `LeadLocal123!` |
| Operations member | `member@ops.local` | `MemberLocal123!` |
| Payments lead | `payments.lead@ops.local` | `PaymentsLead123!` |

These credentials are only for local development. Do not reuse them in a deployed environment.

## Work-item lifecycle

A typical workflow is:

1. A team member creates a work item in an accessible team.
2. An eligible user claims the item.
3. The assignee starts work.
4. The assignee requests approval.
5. A different authorized team lead reviews the request.
6. The lead approves or rejects the work.

Approval resolves the item. Rejection returns it to active work. The API enforces lifecycle and permission rules; frontend visibility is not the security boundary.

## API overview

All work-item and team endpoints below require authentication.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/login` | Authenticate and obtain a JWT |
| `GET` | `/auth/me` | Get the authenticated profile |
| `GET` | `/teams` | List teams accessible to the user |
| `GET` | `/work-items` | List and filter work items |
| `POST` | `/work-items` | Create a work item |
| `GET` | `/work-items/:id` | Get item details and timeline |
| `POST` | `/work-items/:id/claim` | Claim an unassigned item |
| `PATCH` | `/work-items/:id` | Edit an item using `If-Match` |
| `POST` | `/work-items/:id/start` | Start work |
| `POST` | `/work-items/:id/request-approval` | Submit work for approval |
| `POST` | `/work-items/:id/approval-decision` | Approve or reject work |

Creation and claim requests require an `Idempotency-Key` header. Item edits require a strong version ETag in the `If-Match` header. Successful item responses expose the version through the `ETag` response header.

The list endpoint supports team, status, priority, full-text search, result limits, and a pagination cursor.

## Running tests and quality checks

Run backend commands from `backend/`.

### Automated unit tests

```powershell
npm test
```

The idempotency tests use the configured local database, so set up the database and backend environment first. Treat test scripts as development-only and do not point them at production data.

### Production build

```powershell
npm run build
```

### Lint

```powershell
npm run lint
```

### Integration tests

Start PostgreSQL and the API, then run:

```powershell
npm run test:integration
```

The integration script uses the owner database connection for assertions and writes test data. Run it only against a local development database.

### Concurrent-claim test

With PostgreSQL and the API running:

```powershell
node scripts/claim-concurrency-test.mjs
```

This script creates test users and work items and exercises simultaneous claims. It is intended for local development testing.

### Optional performance dataset

The following script seeds 5,000 sample work items and their creation events:

```powershell
node scripts/seed-large.mjs
```

Run it only against a local development database. It uses a fixed prefix to identify its dataset and refuses to seed that same prefix again.

During development, list filtering and full-text search were checked with PostgreSQL query plans on this dataset. Those local checks demonstrate index use for the tested queries; they are not a production load test.

## Repository layout

```text
.
├── backend/
│   ├── scripts/             # Seed, integration, and concurrency scripts
│   └── src/
│       ├── auth/            # Login and JWT authentication
│       ├── authorization/   # Access policies
│       ├── database/        # TypeORM data source and migrations
│       ├── idempotency/     # Request hashing and stored responses
│       ├── teams/           # Team endpoint
│       └── work-items/      # Work-item workflows and API
├── database/
│   └── init/                # Initial PostgreSQL role setup
├── frontend/
│   └── src/                 # React application
├── docker-compose.yml
├── .env.example
├── README.md
└── ENGINEERING_DECISIONS.md
```

## Security and operational notes

- Real environment files are ignored by Git; commit only the example templates.
- Local demo credentials and JWT secrets are not suitable for production.
- TypeORM automatic schema synchronization is disabled; apply explicit migrations.
- Integration and concurrency scripts mutate the local database.
- The local 5,000-record dataset and query plans do not establish performance under production-scale traffic.
- A production deployment needs environment-specific secret management, TLS, backups, monitoring, and operational hardening.

## Validation status during development

The following checks were observed to pass during development; rerun them on the exact revision you submit:

- Backend production build.
- Backend lint with zero warnings and zero errors.
- Three existing Vitest tests across two test files.
- Integration test script after updating the creation test to send its required idempotency header.
- Concurrent-claim test.
- Manual UI verification of creation, claim, start, approval request, and approval by a separate team lead.
