# Engineering Decisions

This document records the principal engineering choices in ShiftOps and the trade-offs they address.

## 1. PostgreSQL enforces critical invariants

**Decision.** Use explicit database migrations and PostgreSQL triggers/constraints for invariants that must remain true even when a code path is incorrect.

Work-item versions are incremented by a database trigger. Event insertion checks that the event sequence aligns with the current item version. A deferred constraint trigger verifies that a committed work-item mutation has a corresponding event. Event history is append-only for the restricted application role.

**Rationale.** Application-only checks can be bypassed by alternate code paths and can race under concurrency. PostgreSQL is the final authority for persistent consistency.

**Trade-off.** The schema is more sophisticated and requires database changes to be reviewed alongside application changes. Tests must validate the application behavior and database enforcement together.

## 2. Separate application and owner database roles

**Decision.** The API connects through a restricted application role. Migrations and seeding use the owner connection.

**Rationale.** Normal request handling does not need broad administrative privileges. In particular, the application role cannot update or delete event history.

**Trade-off.** Local setup has two connection strings and depends on correct role initialization. PostgreSQL initialization scripts run when the data volume is first initialized, not on every restart.

## 3. Atomic work-item claims

**Decision.** Claiming uses a conditional SQL update that succeeds only while the item is unassigned, claimable, and in a team accessible to the authenticated user. The update returns the row that was changed.

**Rationale.** A read followed by an unconditional write would allow competing requests to both believe they claimed the same item. A conditional update turns the claim into a single database operation with one winner.

**Observed behavior.** The concurrency test exercises 20 competing users: one request successfully claims the item and the others receive conflicts.

**Trade-off.** Some unsuccessful claims require a scoped read after the attempted update so the API can distinguish an inaccessible/missing item from a conflict in the item's current state.

## 4. Optimistic concurrency for edits

**Decision.** Each work item has a version. The API exposes that version as an ETag and requires a strong `If-Match` header for edits. The SQL update is conditional on the version the client observed.

**Rationale.** This prevents an old form from silently overwriting a newer edit. A stale client receives a conflict and must refresh or reconcile.

**Trade-off.** The frontend must preserve the current item version and communicate conflicts clearly. Edits are rejected if the required precondition is absent or stale.

## 5. Idempotency for creation and claims

**Decision.** Creation and claim requests require an `Idempotency-Key`. The implementation records the user, key, request hash, stored response, and expiration in the transactional workflow.

A repeated key with the same request replays the stored result. Reusing that key for a different request is rejected. Stored conflict results can be replayed, while failed server operations do not retain a completed result.

**Rationale.** Clients may retry after a network timeout without knowing whether the original request completed. Idempotency makes retry behavior deterministic and reduces duplicate mutations.

**Trade-off.** This adds persistent records, transactional handling, request canonicalization, and expiry rules. Idempotency is implemented for creation and claims; it should not be assumed to apply automatically to every endpoint.

## 6. Event history is transactional and append-only

**Decision.** State transitions write the corresponding event in the same transaction as the work-item mutation. Event sequence values align with item versions, and database permissions deny the application role event updates and deletes.

**Rationale.** A committed state change should have a corresponding audit event. Storing the mutation and event in one transaction avoids a successful mutation being committed without its audit record.

**Trade-off.** Every state-changing workflow must use the same transaction protocol. Triggers and append-only permissions add implementation complexity but make accidental inconsistencies harder to introduce.

## 7. Explicit workflow transitions and approval policy

**Decision.** The API exposes dedicated operations to start work, request approval, and decide approval, rather than accepting arbitrary status values from the frontend.

The server checks team access and approval eligibility. The creator cannot approve their own work, and approval requires the appropriate team lead permissions.

**Rationale.** Workflow rules are business invariants and must be enforced server-side. A user should not be able to bypass the intended lifecycle by constructing a custom HTTP request.

**Trade-off.** Workflow rules span dedicated services and require tests for both valid and invalid transitions. UI controls help usability but are not the authorization boundary.

## 8. Team scoping at the API layer

**Decision.** Accessible team IDs are derived from the authenticated user and applied to work-item reads and mutations. Administrator access is handled explicitly by the policy layer.

**Rationale.** Hiding other teams in the UI does not protect data. Team scoping must be enforced server-side for lists, details, and mutations.

**Trade-off.** Scoped lookups and policy checks are required on several paths. Inaccessible item details return not-found, avoiding disclosure of whether an item exists outside the caller's scope.

## 9. Indexed filtering, full-text search, and keyset pagination

**Decision.** PostgreSQL indexes support common team/status/date queries, while a GIN index supports full-text search over a generated search document. List pagination uses the `(created_at, id)` key rather than relying on large offsets.

**Rationale.** These choices support common operational queries and traversal through large result sets. Search is executed in PostgreSQL instead of loading all rows into the application.

**Trade-off.** Indexes consume storage and add write overhead. Query plans need review using representative data. The 5,000-record local dataset demonstrates index use for the queries tested, but it is not evidence of production throughput or sustained concurrent-load performance.

## 10. Explicit migrations instead of automatic synchronization

**Decision.** TypeORM schema synchronization is disabled. Schema changes are delivered using explicit migrations.

**Rationale.** Implicit schema changes at application startup are difficult to review and control. Explicit migrations make database evolution observable and reproducible.

**Trade-off.** Developers must run migrations when the schema changes and keep migration history aligned with the application code.

## 11. Testing strategy

**Decision.** Vitest runs the existing automated unit tests. Separate Node.js scripts exercise database-backed integration and concurrency behavior.

**Rationale.** Unit tests provide a quick feedback loop. Integration scripts use a real local PostgreSQL database to verify HTTP contracts, database constraints, transaction behavior, and competing mutations.

**Observed status.** During development, the production build and lint passed, the existing suite of three Vitest tests passed, the integration script passed after its creation request was updated to send an idempotency key, and the concurrent-claim test passed.

**Trade-offs and limitations.** The unit-test suite is small. Integration scripts need a running API/database and modify local test data. More negative-path tests, automated clean-environment testing, and realistic sustained-load tests would improve confidence.

## 12. Local-first development setup

**Decision.** Docker Compose runs PostgreSQL, while NestJS and Vite run locally during development.

**Rationale.** This keeps development and debugging straightforward without adding deployment infrastructure that is not required for the local application.

**Trade-off.** This is a development setup, not a production deployment architecture. Production needs deployment-specific secret management, TLS, backups, monitoring, and operational hardening.
