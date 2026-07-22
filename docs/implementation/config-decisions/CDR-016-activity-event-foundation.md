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
   paginated + filtered, typed JSON with an honest `as_of`. NO rendered web page.
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

### Read path (`activity:read`)
- New authz action `activity:read` → **owner|viewer** company member (account membership alone is insufficient; the
  fresh company role governs). Runs under `runInCompanyScope`. **Keyset pagination**: order `occurred_at DESC,
  event_id DESC`; opaque, versioned cursor bound to `(account, company)`, integrity-checked; default page 25, max 100;
  forward pagination; no OFFSET. DTO exposes activity_type + occurred_at + actor internal id + subject + bounded safe
  fields + `proposed_vs_executed`; NEVER raw payload/correlation/causation/account events. `as_of` = the latest returned
  activity `occurred_at` (synchronous projection ⇒ always caught up; honest lag, no fabricated freshness; `null` when
  empty).

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
