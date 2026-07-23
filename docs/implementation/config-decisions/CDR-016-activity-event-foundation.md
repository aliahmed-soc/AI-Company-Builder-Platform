# CDR-016 — Activity event foundation (ACBP-P1-009)

Status: **Accepted** (owner decision 2026-07-22). Governs ACBP-P1-009.
Sources: backlog ACBP-P1-009 (ACT-001; ADR-015; deps ACBP-P1-008;ACBP-P1-010); ADR-015 (audit source-of-record +
company-scoped activity projection, honest "as of" lag, proposed-vs-executed marking / invariant 20);
diagrams/11 (audit → in-process bus → activity_events projection → feed); DATA-ARCHITECTURE (Activity event = C-tenant,
PK event_id, append-only **A**, redacted content); EVENT-CATALOG (delivery via transactional outbox/bus; idempotent
consumers); API-CONTRACTS (Activity feed, paged/filtered, company-member read, proposed-vs-executed); CDR-014 (audit
account-scoped first cut; outbox/activity deferred to P1-009+); CDR-015 (company tenancy, dual-scope audit, company.*
events, CompanyScope, no 4th SECURITY DEFINER).

## Owner decisions (2026-07-22)

1. **Read model — a separate, append-only, company-scoped `activity_events` table.** NOT a presentation mutation of
   `audit_events`, and NOT a synchronous read-view. `activity_events` is the tenant-facing projection (DATA-ARCHITECTURE
   row): C-tenant, append-only, redacted content, PK = the **source audit `event_id`** (ULID) so the projection is
   idempotent, traceable, and rebuildable from the authoritative audit store.
2. **Synchronous in-process projection** for exactly the four durable company events: `company.created`,
   `company.updated`, `company.paused`, `company.resumed`. No async projector, no outbox table, no worker, no
   polling/checkpoint/lease, no owner/migration connection, and **no 4th SECURITY DEFINER function** (allowlist stays
   exactly three).
3. **One atomic transaction.** The company lifecycle mutation + the durable `audit_events` write + the `activity_events`
   projection row are written in the **same restricted `acbp_app` transaction under the same CompanyScope** (the P1-010
   lifecycle use cases are extended to project in-transaction, right after the audit write). A projection-write failure
   rolls back the whole operation (mutation + audit + activity) — fail-closed, exactly like the audit write.
4. **`audit_events` remains authoritative; `activity_events` is a redacted, rebuildable projection** keyed by the source
   audit `event_id`. The projection carries only safe display fields (no correlation/causation ids, no raw audit
   payload beyond the bounded whitelisted fields, no account-level events). Rebuild is a pure mapping from the
   authoritative audit company rows → activity rows (documented + unit-proven); no running rebuild worker is added.
5. **No** outbox, async projector, worker, checkpoint, lease, owner connection, or fourth SECURITY DEFINER function.
6. **API-only:** `GET /api/companies/[companyId]/activity` — authenticated, company-member (owner|viewer) read, keyset
   paginated (NO filters in P1-009 — `cursor` and `limit` are the only query parameters; anything else is rejected),
   typed JSON with honest response metadata. NO rendered web page.
7. **No SSE / live stream** (ACT-004/005 real-time is deferred to P6-008). P1-009 delivers the paged feed (ACT-001/003).

## Required model (invariants)

### Taxonomy (visible events — company events ONLY)
- The feed renders EXACTLY the four company events: `company.created` / `company.updated` / `company.paused` /
  `company.resumed`. Excluded: `membership.invited`/`membership.revoked` and every `company_id IS NULL` account event;
  `authz.denied`, `tenant.context_denied`, `account.created`, `membership.accepted`, `webhook.*`, `reconcile.*`, and any
  Logger-only or undeclared future event. All four company events are **executed** facts → `proposed_vs_executed =
  'executed'` (ACT-003 marking is present but trivially "executed" for P1-009's event set).

### `activity_events` schema (migration 0009; additive)
- `event_id` text PK (= source audit `event_id`; idempotent + rebuildable + traceable). `account_id`/`company_id` uuid
  NOT NULL (both server-bound). `activity_type` (the company event name). `occurred_at` timestamptz (copied from the
  authoritative audit `occurred_at`). `actor_type`/`actor_id`. `subject_type`/`subject_id`. `payload` jsonb (bounded,
  redacted display fields only — `creation_mode`, `changed_fields`; never correlation/causation/raw). `schema_version`
  int. `projected_at` timestamptz default now(). No FK (trace survives deletion, like audit).
- **FORCE RLS, dual-keyed** (`account_id = app.current_account AND company_id = app.current_company`, fail-closed).
  Grants to `acbp_app`: **INSERT + SELECT only** (append-only; no UPDATE/DELETE/TRUNCATE). Keyset index on
  `(company_id, occurred_at DESC, event_id DESC)`.

### Projection write path
- Written under the caller's CompanyScope on `acbp_app`, in the same transaction as the lifecycle mutation + audit. The
  activity row's `event_id` = the audit writer's returned event id; `account_id`/`company_id`/`actor_*`/`occurred_at`
  are server-bound (never caller-supplied). Idempotent by PK (a retried projection of the same audit event is a no-op /
  conflict, never a duplicate feed item).

### Historical backfill (owner-required; in migration 0009)
- 0009 backfills the projection from existing `audit_events` in the table-creating migration (before RLS, on the
  migration connection): the four company events with `company_id IS NOT NULL` only; `event_id` preserved as the
  projection identity; `occurred_at` on the **millisecond grid** (`date_trunc` — identical to the runtime
  projector's JS-Date round-trip, so live == backfill == rebuild); tenant/actor columns copied as server evidence;
  payload REDACTED to the per-type allowlist; account/Logger-only/unknown events excluded structurally; idempotent
  (`ON CONFLICT (event_id) DO NOTHING`); down/up reapply deterministic. Rebuild = the same mapping re-run over the
  audit rows via the migration connection (no product rebuild endpoint, no owner-connected worker).

### Read path (`activity:read`)
- New authz action `activity:read` → **owner|viewer** company member (account membership alone is insufficient; the
  fresh company role governs). Runs under `runInCompanyScope`. **Keyset pagination**: order `occurred_at DESC,
  event_id DESC`; default page 25, max 100; forward only; no OFFSET. `cursor`/`limit` are the ONLY query params.
- **Cursor**: opaque unpadded **base64url** (pure-ECMAScript codec; URL-safe alphabet, no `+`/`/`/`=`) of a
  versioned ASCII JSON payload bound to **account AND company**, carrying the exclusive keyset-after position AND
  the **immutable traversal upper bound** captured on the first page (later pages apply both predicates, so events
  inserted after page 1 are excluded from that traversal; a fresh traversal includes them). Strict validation
  (version/tenant-binding/shape/ISO-timestamp/ULID-event-id/bounds); malformed or foreign → `invalid_cursor` (400);
  no signing secret — tampering can only move the position inside the already-authorized RLS-confined company.
- **DTO** (tightened): items expose ONLY `id`/`type`/`occurredAt`/`state:'executed'`/coarse `actorType`/per-type
  allowlisted `summary` (`creation_mode`; `changed_fields` names; paused/resumed EMPTY). Never actor internal ids,
  account/company ids, raw payload, correlation/causation/idempotency ids, or free-text. Allowlist applied at
  projection AND re-applied at DTO mapping; an out-of-taxonomy stored type is dropped, never emitted raw.
- **Honest metadata**: `projectionMode:'synchronous'`; `asOf` = the POSTGRESQL read timestamp of the feed query's
  transaction (never app wall-clock); `sourceThrough` = the traversal upper bound (constant across pages; null when
  empty); `lagSeconds: 0` (atomic same-tx projection). Committed-transaction visibility only; no SSE implied.

### Trust boundaries (unchanged from P1-010; preserved)
- Identity Clerk-only; internal memberships/roles authoritative; active account + active company membership both
  required; company role loaded fresh; AccountScope/CompanyScope type-distinct; requested `companyId` is a selector;
  runtime uses `acbp_app` (`DATABASE_APP_URL`); owner connection never exposed; FORCE RLS; no BYPASSRLS; exactly three
  SECURITY DEFINER functions; `audit_events` append-only + never mutated by the activity system.

## Out of scope (deferred)
Outbox + async projector/worker (later, when the higher-volume task/tool event sources land); SSE/live feed (P6-008);
rendered activity UI; broad search/export; audit/activity retention/purge; proposed-vs-executed evidence joins for
task/tool events (only company "executed" events exist here); portfolio/account-level activity (P1-011+).

## Rejected alternatives
- **Synchronous read-model over `audit_events` (no table)** — rejected by owner in favor of a materialized projection
  table (DATA-ARCHITECTURE fidelity; clean redaction boundary; future async migration path).
- **Transactional outbox + async projector/worker now** — rejected as disproportionate to the "basic feed" (estimate S)
  and premature before a worker runtime + higher-volume sources exist; would also raise a cross-tenant projector
  credential question. Synchronous in-tx projection gives the same durable, atomic, rebuildable projection without any
  of that machinery.
- **A 4th SECURITY DEFINER / owner-connection projector** — rejected; synchronous in-tx projection runs under the
  existing CompanyScope on `acbp_app`, so no privileged path is needed.

## Independent review outcomes + accepted residual risks (2026-07-23)
Three independent reviews (security/tenant-isolation/privacy; projection-atomicity/idempotency/backfill; pagination/
cursor/codec/plan/scope) ran over the full `main..HEAD` diff. **No CRITICAL/HIGH/MEDIUM finding.** All Low/coverage
items fixed:
- **Projector time path (L1/F2):** the live projector now derives the row in a single `INSERT…SELECT` from the
  authoritative audit row with `date_trunc('milliseconds', …)` — the exact expression the 0009 backfill uses — so
  live == backfill == rebuild byte-identically (no JS float/date parsing in the time path). The live path has NO
  conflict handling by design (no live path replays an id; a duplicate is an internal bug and fails loudly); the
  canonical idempotent rebuild mapping is the 0009 SQL (`ON CONFLICT DO NOTHING`).
- **Backfill precondition (F3):** migration 0009 asserts loudly that the migration role has BYPASSRLS/superuser
  (audit_events is under FORCE RLS) instead of silently backfilling zero rows.
- **Coverage (F1 + tie-break):** added the rename projection-failure rollback proof (rename's projection call is a
  distinct inline path) and an equal-timestamp page-boundary tie-break test.
- **asOf fallback (LOW-2):** the unreachable app-wall-clock fallback now throws instead — `asOf` is unconditionally
  PostgreSQL time.
Accepted residuals (documented in ACTIVITY.md): the cursor is opaque-by-convention and contains the caller's OWN
tenant ids (nothing foreign disclosable; binding + RLS confine it); an all-dropped page (unreachable behind the DB
CHECK) would end a traversal early (fail-safe direction); the OR-form keyset is a filtered index walk, not a
row-constructor seek (negligible at company-event volume); `asOf` = transaction read timestamp (conservative under
READ COMMITTED); same-millisecond/late-commit edges are covered by the documented no-snapshot-across-requests
caveat; the backfill copies allowlisted values type-blind where the JS allowlist admits scalars only (unreachable
via the validated factories; the read-side allowlist re-application contains it).
