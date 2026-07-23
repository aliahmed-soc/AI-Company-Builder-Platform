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

## Historical backfill + rebuild

Migration 0009 **backfills** the projection from the existing durable audit history in the same migration that
creates the table (before RLS is enabled, on the migration connection): exactly the four company events with
`company_id IS NOT NULL`, `event_id` preserved as the projection identity, `occurred_at` on the projection's
**millisecond grid** (`date_trunc('milliseconds', …)` — the runtime projector's JS-Date round-trip has the same
effect, so live == backfill == rebuild and cursor timestamps compare exactly), actor/tenant columns copied as
server evidence, and the payload REDACTED to the per-type allowlist (correlation/causation/idempotency ids are
never copied; account events, Logger-only names, and unknown company events are excluded structurally). The
backfill is **idempotent** (`ON CONFLICT (event_id) DO NOTHING`) and down/up reapply is deterministic. A future
full rebuild = re-running the same mapping over the audit company rows (no product/runtime rebuild endpoint and
no owner-connected worker exist — a rebuild is a migration-connection operation).

## Read path — `GET /api/companies/{companyId}/activity` (API-only; no UI, no SSE)

Authenticated; **owner|viewer company member** (`activity:read`; account membership alone is insufficient — the
fresh company role governs). Runs under `runInCompanyScope`, RLS-confined to the current account+company. The
`companyId` is a membership-validated **selector**; `cursor` and `limit` are the ONLY supported query parameters
(anything else → 400); the domain validates and clamps them. **Keyset pagination**: `occurred_at DESC, event_id
DESC`; **default page 25, max 100**; forward only; no OFFSET (the query matches `activity_events_feed_idx`).

**Cursor**: opaque **unpadded base64url** (pure-ECMAScript codec — URL-safe alphabet, no `+`/`/`/`=`) of a
versioned ASCII JSON payload **bound to the account AND company**, carrying the exclusive keyset-after position
**and the immutable traversal upper bound**. Decoding STRICTLY validates version, tenant binding, field shapes,
ISO timestamps, and ULID event ids; any malformed/foreign token → `400 invalid_cursor` (never a fallback scan).
No signing secret: a tampered-but-well-formed cursor can only move the traversal position INSIDE the
already-authorized, RLS-confined company — it can never change scope or disclose another company.

**Traversal consistency**: the FIRST page captures the upper bound (the newest event at traversal start); later
pages apply both the upper bound and the keyset-after predicate, so an event inserted after page 1 is EXCLUDED
from that traversal (a fresh traversal includes it). No snapshot isolation across requests is claimed beyond this.

**DTO** (tightened redaction): each item exposes ONLY `id` (the source audit event id), `type`, `occurredAt`,
`state: 'executed'`, the coarse `actorType`, and the per-type allowlisted `summary` (`company.created` →
`creation_mode`; `company.updated` → `changed_fields` names; paused/resumed → **empty**). It never exposes actor
internal ids, account/company ids, raw audit payload, correlation/causation/idempotency ids, or free-text fields.
The allowlist is applied at projection time AND re-applied at DTO mapping (defense in depth); an out-of-taxonomy
stored type is dropped, never emitted as a generic raw event.

## "As of" / lag honesty

Response metadata: `projectionMode: 'synchronous'`; **`asOf` = the PostgreSQL read timestamp of the feed query's
transaction** (never application wall-clock); `sourceThrough` = the traversal upper-bound tuple (constant across
the traversal's pages; `null` for an empty feed); `lagSeconds: 0` — the supported taxonomy commits atomically with
its source, so projection lag is structurally zero. This claims visibility of committed transactions only and
implies no SSE/push delivery; if/when an async projector is introduced later, `asOf`/lag become the projector
checkpoint (still honest).

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
