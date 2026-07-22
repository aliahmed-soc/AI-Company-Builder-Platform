# Activity event foundation (ACBP-P1-009)

Status: implemented (company-scoped first cut; CDR-016). This is the "activity README" for the tenant-facing
company activity feed. Sources: ADR-015 (audit source-of-record + activity projection, honest "as of" lag,
proposed-vs-executed); diagrams/11 (audit → in-process bus → activity projection → feed); DATA-ARCHITECTURE
(Activity event = C-tenant, append-only, redacted); EVENT-CATALOG; CDR-016 (owner decisions); CDR-015 (company
tenancy, dual-scope audit, CompanyScope, the closed 3-function SECURITY DEFINER allowlist).

## Model — a materialized, synchronous, company-scoped projection

`audit_events` is the **authoritative source of record**. `activity_events` is a **separate, append-only,
company-scoped PROJECTION** of the four durable company events. It is written **synchronously in the SAME
transaction** as the company lifecycle mutation + audit write, under the caller's `CompanyScope` on the restricted
`acbp_app` role — **no outbox, no async projector, no worker, no polling/checkpoint/lease, no owner connection, and
no fourth SECURITY DEFINER function** (the allowlist stays exactly three). A projection-write failure rolls the
whole lifecycle operation back (fail-closed, like the audit write).

`activity_events.event_id` is the **primary key AND the source audit `event_id`** (a ULID), so the projection is:
idempotent (a retried projection of the same audit event conflicts, never duplicates a feed item), **traceable**
to its authoritative audit row, and **rebuildable** — the single-event projector `projectCompanyActivity` derives
the row purely from the authoritative audit row (`occurred_at`/actor) + the typed event (activity type / subject /
redacted payload), so a rebuild = re-running it over the audit company rows. No running rebuild worker is added.

## Data model — `activity_events` (migration 0009)

| Column | Notes |
|---|---|
| `event_id` (text PK) | = source audit `event_id` (idempotency + traceability + rebuildability) |
| `account_id` / `company_id` (uuid, NOT NULL) | tenant stamps; **no FK** (a redacted trace survives deletion) |
| `activity_type` | one of `company.created`/`.updated`/`.paused`/`.resumed` (CHECK) — **company events only** |
| `occurred_at` (timestamptz) | copied from the authoritative audit `occurred_at` (millisecond-precise; the feed ordering field) |
| `actor_type` / `actor_id` | from the source audit row |
| `subject_type` / `subject_id` | the company |
| `payload` (jsonb) | **redacted** display fields only (`creation_mode`, `changed_fields`) — no correlation/causation/raw |
| `schema_version` (int) / `projected_at` (timestamptz) | |

**FORCE ROW LEVEL SECURITY, dual-keyed** to BOTH `app.current_account` and `app.current_company` (fail-closed text
comparison). `acbp_app` is granted **INSERT + SELECT only** — no UPDATE/DELETE/TRUNCATE grant or policy, so the
projection is append-only by persistence constraint. Keyset index `(company_id, occurred_at DESC, event_id DESC)`.

## Visible taxonomy — company events only

The feed renders EXACTLY the four company events. Account-level audit events (`membership.invited`/`.revoked`,
`company_id` NULL), Logger-only events (`authz.denied`, `tenant.context_denied`, `account.created`,
`membership.accepted`, `webhook.*`, `reconcile.*`), and any undeclared future event are **not projectable** and
can never appear (the projector no-ops on non-company events AND the type CHECK rejects them). All four company
events are **executed** facts → `executionState = 'executed'` (ACT-003 marking present, trivially executed here).

## Read path — `GET /api/companies/{companyId}/activity` (API-only; no UI, no SSE)

Authenticated; **owner|viewer company member** (`activity:read`; account membership alone is insufficient — the
fresh company role governs). Runs under `runInCompanyScope`, RLS-confined to the current account+company. The
`companyId` is a membership-validated **selector**; `cursor`/`limit` are query-string inputs the domain validates
and clamps. **Keyset pagination**: `occurred_at DESC, event_id DESC`; an **opaque, versioned, company-bound**
cursor (a bad or foreign cursor → `400 invalid_cursor`, never a silent unbounded scan); **default page 25, max
100**; forward pagination; no OFFSET. The DTO exposes activity type + `occurredAt` + actor internal id + subject +
the redacted `details` + `executionState` — **never** raw payload, correlation/causation ids, or account events.

## "As of" / lag honesty

`asOf` is the **newest returned event's `occurredAt`** (or `null` when the feed is empty). Because the projection
is written synchronously in the source transaction, the feed is **always caught up** — `asOf` never claims
freshness beyond the latest projected event and never uses wall-clock request time. There is no backlog to hide;
if/when an async projector is introduced later, `asOf` becomes the projector checkpoint (still honest).

## Trust boundaries

Identity Clerk-only; internal memberships/roles authoritative; active account + active company membership both
required; company role loaded fresh; `AccountScope`/`CompanyScope` type-distinct; requested `companyId` a selector;
runtime uses `acbp_app` (`DATABASE_APP_URL`); owner connection never exposed; FORCE RLS; no BYPASSRLS; exactly three
SECURITY DEFINER functions; `audit_events` append-only and **never mutated** by the activity system; no generic
activity-write endpoint (the only writer is the in-tx projector).

## Out of scope (deferred)

Transactional outbox + async projector/worker (later, with the higher-volume task/tool event sources); **SSE / live
feed (P6-008)**; rendered activity UI; broad search/export; audit/activity retention/purge; proposed-vs-executed
evidence joins for task/tool events; account-level/portfolio activity (P1-011+).

## Residual risks (accepted)

- `activity_type` / redaction are enforced at the app layer + the DB CHECK; the only write path is the typed in-tx
  projector, so a spurious row would require a compromised app path and is still RLS-bound + type-constrained.
- No live authenticated web-route acceptance was performed (owner/external gate); hosted zero-skip PostgreSQL CI is
  the authoritative gate; the Next build ran locally.
