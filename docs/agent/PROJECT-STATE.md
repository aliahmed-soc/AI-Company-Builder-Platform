# PROJECT-STATE.md — factual state (autonomous lead)

_Read this first on resume, then continue automatically to "Next executable action". No secrets/PII here._

## Active
- Ticket: **ACBP-P1-008** — Audit event foundation (status: **Planned/Ready**; owner-gated to Done).
- Branch: `p1-008-audit-event-foundation` (from `main` @ `340f9c2`).
- PR: **draft, open, unmerged**, base `main` (opened in Slice 1).
- Base main: `340f9c2b11f5019b26ff8563aa4dbd4505866d49` (P1-007 squash-merge PR #8; main CI green run 29867863044).
- **STATUS: owner decision made (CDR-014 Option A). Slice 1 complete + local-green. Implementing autonomously.**
  Do NOT self-authorize: backlog→Done, PR ready, merge, branch delete, or begin P1-009.

## Prior tickets (closed)
- **ACBP-P1-001..P1-007 — DONE & MERGED.** P1-007 squash `340f9c2` (PR #8). Main CI green on each squash.
- Residual non-blocking owner cleanup: delete the inert P1-002 Clerk **Development** webhook endpoint. Do NOT touch it.

## P1-008 scope (canonical) — CDR-014 (owner-accepted 2026-07-22, Option A)
- ONE append-only **`audit_events`** table, **account-scoped now** (`account_id` NOT NULL; no `company_id`
  column yet — expand-migration at P1-010; no FK to accounts so a redacted trace survives deletion). Envelope
  columns (EVENT-CATALOG): server ULID `event_id` (PK), registered `name` + `schema_version`, `account_id`,
  `actor_type`(user|worker|system|admin)+nullable `actor_id`, `subject_type`/`subject_id`, bounded `outcome`,
  `correlation_id`, `causation_id`, `idempotency_key` (unique when present), bounded JSON `payload`, immutable
  server `occurred_at`.
- **FORCE RLS keyed to `app.current_account`; append-only.** `acbp_app` gets INSERT (WITH CHECK
  account_id=current_account) + SELECT only — NO UPDATE/DELETE/TRUNCATE grant or policy (invariant 11 by
  persistence constraint). Owner owns the table. Grants BYPASSRLS to no one; adds NO SECURITY DEFINER function
  (allowlist stays exactly 3).
- **In-tx write pattern**: an account-scoped audit writer inserts using the caller's `AccountScope` inside
  `withAccountTransaction`; account/actor/event_id/occurred_at bound SERVER-SIDE (unforgeable). Write failure
  rolls back the business tx → action blocked (ADR-015; FAILURE row 14).
- **Events durably persisted now (high-risk, account-scoped, in-tx):** `membership.invited`, `membership.revoked`.
- **Deferred (stay interim structured logs; CDR-014):** denials (authz.denied, tenant.context_denied — no
  business tx / persistence-vs-rollback unresolved); global events (webhook.*, reconcile.* — no tenant predicate);
  pre-context bootstrap events (account.created, membership.accepted — outside withAccountTransaction);
  lower-risk (account.profile_updated — outbox is P1-009+).
- **Out of P1-008 (canon):** company audit (P1-010), transactional outbox + activity feed (P1-009+), audit
  read/export/admin API (separate contract), retention/purge job (CDR-009/later).

## Slices
1. **DONE (local-green).** Audit contract in `@acbp/contracts` (`audit/`): server ULID `generateEventId`/`isUlid`;
   `AuditActorType`, `AuditOutcome`, closed `AUDIT_EVENTS` registry (membership.invited/revoked, schema v1) +
   `isAuditEventName` (deny unregistered); `boundedMetadata` (flat scalars only — rejects nesting/arrays/Error/
   null/bigint/symbol/non-finite/over-long/too-many/over-large; key-name-only errors); typed factories
   `membershipInvited`/`membershipRevoked` (no free-form events). 17 unit tests; static gate all EXIT 0.
   + CDR-014 + agent state + draft PR.
2. **DONE (local-green; Slice 1 CI 29872934993 success).** Migration `0007_audit_events` (append-only table,
   ULID text PK, jsonb payload, check constraints on actor_type/outcome/schema_version, account+time index,
   partial-unique idempotency_key; ENABLE+FORCE RLS; INSERT+SELECT policies keyed to app.current_account
   fail-closed; grant INSERT+SELECT only to acbp_app — no UPDATE/DELETE/TRUNCATE; adds no SECURITY DEFINER fn,
   no BYPASSRLS, no FK on account_id). `AuditEventsTable` schema type (Updateable=never per column). `writeAuditEvent`
   (`audit-repository.ts`) appends under the caller's AccountScope in-tx; account/actor bound server-side, event_id
   server ULID, occurred_at DB clock. Real-PG suite `audit.integration.test.ts` (write+server-bound fields+cross-
   account isolation; UPDATE/DELETE/TRUNCATE denied; fail-closed no-GUC; forged-account WITH CHECK; catalog/ACL
   INSERT+SELECT-only+FORCE-RLS+2-policies+no-BYPASSRLS; idempotency-key unique). Static gate + boundary tests EXIT 0.
3. **DONE (local-green).** `inviteMember`/`revokeMember` write `membership.invited`/`membership.revoked` via
   `writeAuditEvent` INSIDE `runInAccountScope` (same tx + AccountScope; account/actor/event_id/occurred_at
   server-bound). Revoke made concurrency-safe (`MembershipRepository.revokeIfActive` conditional
   `WHERE status='active'`; `RevokeResult.changed` distinguishes real revoke from idempotent no-op). Test-seam
   `auditWriter?` on `MembershipOpOptions` (production never sets it; tests force failure). Completeness registry
   `@acbp/core` `audit/audit-operations.ts` (`AUDITED_OPERATIONS` op→event, compile-exhaustive `factoryFor`,
   no-orphan-registered-event test). Real-PG tests: invite/revoke each write exactly one server-bound PII-free
   row; audit-write failure rolls back the mutation (fail-closed, no invite/revoke, no audit); write-then-throw
   rolls BOTH back (atomicity); mutation-fail/last-owner/missing/no-op/cross-account write no success audit;
   concurrent revoke → exactly one audit. Full local suite 528 pass / 0 fail.
4. **IN PROGRESS (adversarial + docs done; reviews pending).** Adversarial suite extends `audit.integration.test.ts`:
   ALTER/DROP/TRUNCATE/DISABLE-RLS denied; DROP/ALTER/permissive-ALL policy denied; self-GRANT/SET-ROLE/CREATE-ROLE
   denied; pooled-context isolation (sequential + concurrent accounts don't cross-see); catalog (non-app owner,
   acbp_app NOCREATEROLE/NOINHERIT/member-of-no-role, exactly 2 policies INSERT+SELECT, exactly 3 SECURITY DEFINER
   fns). Docs: `docs/architecture/AUDIT.md` (logging-vs-audit, data model, write path, implemented/deferred,
   supply-chain note), EVENT-CATALOG implementation-status note, TENANCY/AUTHORIZATION P1-008 pointers. Static gate
   + boundary tests EXIT 0; full local suite 528 pass / 0 fail. — remaining: independent reviews (audit-integrity,
   RLS/ACL/append-only, tx-atomicity, producer/completeness, architecture/scope, sharp-override) + apply fixes.

## Guards (must stay green every slice)
- `check:static` (typecheck, lint, secrets 0, encoding 0 BOM, boundaries 0, boundary tests) + full `vitest` incl.
  real-PostgreSQL integration on hosted CI (zero-skip preflight) + `pnpm audit --audit-level high`. `next build`
  only if web runtime changes. Immutability (append-only) tests are trust-critical.

## Blockers / owner decisions
- **RESOLVED:** audit-store scope & shape → CDR-014 Option A (owner-accepted 2026-07-22). Account-scoped first cut.
- Future owner gates (do NOT self-authorize): P1-008 backlog→Done, PR ready, merge, branch delete. Begin P1-009
  only on separate authorization.

## Authority limits (this ticket)
- No production systems/credentials; no real customer data; no external DB; no public tunnel; no Clerk dashboard;
  do not touch the inert P1-002 Clerk endpoint; no unrelated refactors. Do NOT: add a 4th SECURITY DEFINER
  function; weaken/alter FORCE RLS or the P1-006 role model; grant BYPASSRLS; expose the owner connection to
  normal runtime; build company audit / outbox / activity feed / read-export-admin API / retention job; create a
  generic public audit-write API; persist arbitrary logger metadata, secrets, tokens, emails, SQL, or raw errors.

## Test baselines
- Inherited from merged `main` (`340f9c2`): hosted CI green (zero-skip PG preflight + aggregate + audit).
  Integration files run serially (`vitest fileParallelism:false`) on one shared DB — keep new suites' cleanup
  drop-lists inclusive (add `audit_events`).
- Local Windows→WSL PG forwarding unstable; hosted CI is the authoritative zero-skip integration gate.
- The `_lc` shell hook intermittently emits false exit-127; verify state via git/gh/CI/filesystem re-reads (PowerShell).

## Next executable action
Continue **Slice 3** (wire `writeAuditEvent` into `membership.invited`/`membership.revoked` inside
`runInAccountScope`, in-tx with the mutation; real-PG tests: atomic success writes one row; a forced audit-write
failure rolls back the membership mutation → action blocked; idempotency/concurrency; no pooled-context leak;
completeness check that each high-risk op writes exactly one audit row). Keep the existing operational
`logger.info` (separate system). Add `audit_events` to integration-suite cleanup drop-lists. Commit + push each
green slice; verify hosted CI on the exact pushed commit. Stop only at the owner gate or a new owner decision.
