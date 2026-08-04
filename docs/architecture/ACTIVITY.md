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
| `occurred_at` (timestamptz) | copied **bit-exactly** from the authoritative audit `occurred_at` (sub-millisecond microseconds included — no truncation; the feed ordering field) |
| `actor_type` / `actor_id` | from the source audit row |
| `subject_type` / `subject_id` | the company |
| `payload` (jsonb) | **redacted** display fields only (`creation_mode`, `changed_fields`) — no correlation/causation/raw |
| `schema_version` (int) / `projected_at` (timestamptz) | |

**FORCE ROW LEVEL SECURITY, dual-keyed** to BOTH `app.current_account` and `app.current_company` (fail-closed text
comparison). `acbp_app` is granted **INSERT + SELECT only** — no UPDATE/DELETE/TRUNCATE grant or policy, so the
projection is append-only by persistence constraint. Keyset index `(company_id, occurred_at DESC, event_id DESC)`.

## Visible taxonomy — company-scoped events

The feed renders the four company lifecycle events **plus the execution events added by ACBP-P6-008**
(CDR-076 §7): `task.created`, `task.started`, `task.completed`, `task.failed`, `approval.requested`,
`approval.approved`, `approval.rejected`. Account-level audit events (`membership.invited`/`.revoked`,
`company_id` NULL), Logger-only events (`authz.denied`, `tenant.context_denied`, `account.created`,
`membership.accepted`, `webhook.*`, `reconcile.*`), and any undeclared future event are **not projectable** and
can never appear (the projector no-ops on non-company events AND the type CHECK rejects them).

**ACT-003 marking is load-bearing now.** `approval.requested` projects as `proposed`; every other type reports a
completed state transition and projects as `executed`. Before P6-008 `executionStateFor` returned a constant,
because the taxonomy contained nothing that had not already happened.

**Widening this taxonomy is four changes, not one** — the contract's `ACTIVITY_TYPES`, the
`activity_events_type_valid` CHECK (a migration), the per-type summary allowlist, and a production call site
that projects inside the source transaction. ACBP-P5-013 made only the first and the divergence was silent until
INSERT; a set-equality test now reads the live constraint out of `pg_constraint` and compares it to the
contract.

## Historical backfill + rebuild

Migration 0009 **backfills** the projection from the existing durable audit history in the same migration that
creates the table (before RLS is enabled, on the migration connection — the migration asserts loudly that its
role has BYPASSRLS/superuser): exactly the four company events with `company_id IS NOT NULL`, `event_id`
preserved as the projection identity, `occurred_at` preserved **bit-exactly** (sub-millisecond microseconds
included; NO truncation — identical to the runtime projector's SQL copy, so live == backfill == rebuild
bit-identically), actor/tenant columns copied as server evidence, and the payload REDACTED to the per-type
allowlist (correlation/causation/idempotency ids are never copied; account events, Logger-only names, and unknown
company events are excluded structurally). The backfill is **idempotent** (`ON CONFLICT (event_id) DO NOTHING`)
and down/up reapply is deterministic. A future full rebuild = re-running the same mapping over the audit company
rows (no product/runtime rebuild endpoint and no owner-connected worker exist — a rebuild is a
migration-connection operation).

## Read path — `GET /api/companies/{companyId}/activity` (API-only; no UI, no SSE)

Authenticated; **owner|viewer company member** (`activity:read`; account membership alone is insufficient — the
fresh company role governs). Runs under `runInCompanyScope`, RLS-confined to the current account+company. The
`companyId` is a membership-validated **selector**; `cursor` and `limit` are the ONLY supported query parameters
(anything else → 400); the domain validates and clamps them. **Keyset pagination**: `occurred_at DESC, event_id
DESC`; **default page 25, max 100**; forward only; no OFFSET (the query matches `activity_events_feed_idx`).

**Cursor**: opaque **unpadded base64url** (pure-ECMAScript codec — URL-safe alphabet, no `+`/`/`/`=`) of a
versioned ASCII JSON payload **bound to the account AND company**, carrying the exclusive keyset-after position
**and the immutable traversal upper bound**. Position timestamps are the EXACT stored instants (canonical
microsecond ISO, validated against a strict shape — Date.parse-permissive forms like `2026` are rejected) and
bind into the keyset via `::timestamptz` casts, so sub-millisecond ordering round-trips with no skip/duplicate.
Decoding STRICTLY validates version, tenant binding, field shapes, timestamps, and ULID event ids; any
malformed/foreign token → `400 invalid_cursor` (never a fallback scan).
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

Transactional outbox + async projector/worker (the live channel shipped in ACBP-P6-008 is **poll-backed** for
exactly this reason — there is no outbox and no LISTEN/NOTIFY, so it re-reads on an interval and says so in its
own payload); rendered activity UI; broad search/export; audit/activity retention/purge; account-level/portfolio
activity (P1-011+). **No historical backfill of the execution events**: migration 0053 widens the CHECK going
forward only, because replaying pre-P6-008 audit rows would present today's redaction allowlist as though it had
governed yesterday's events (the audit trail remains complete for everything before it).

## Residual risks (accepted; from independent review)

- `activity_type` / redaction are enforced at the app layer + the DB CHECK; the only write path is the typed in-tx
  projector, so a spurious row would require a compromised app path and is still RLS-bound + type-constrained.
- **The cursor is opaque by convention, not encryption** (base64url of plaintext JSON): it contains the CALLER'S
  OWN account/company ids and event tuples — values the same principal already receives through the URL path,
  the members API, and the feed items themselves. The binding check guarantees a cursor can only ever be minted
  for (and used by) the requester's own resolved tenant pair, so nothing foreign is disclosed (review LOW-1).
- If an entire fetched page consisted of out-of-taxonomy stored rows (unreachable behind the DB CHECK), the
  read-side drop-filter would end the traversal early rather than skip past them — fail-safe direction: rows are
  dropped, never emitted (review LOW-3).
- **Keyset shape is an OR-form filter, not a row-constructor seek** (review L2): PostgreSQL walks the
  `activity_events_feed_idx` from the company's newest entry applying the predicates as filters with an early-exit
  LIMIT — page *k* scans ~k·limit index entries rather than seeking directly. Negligible at company-lifecycle
  event volumes; a row-constructor seek is a deliberate later optimization if higher-volume sources land.
- **`asOf` is the transaction read timestamp (`now()`), captured just before the feed SELECT** (review L3): under
  READ COMMITTED an event committing in that sliver may appear with `occurredAt > asOf` — the conservative,
  honest direction (freshness is under-claimed, never over-claimed). Likewise an event committing in the same
  millisecond as the traversal upper bound with a smaller ULID can surface on a later page of that traversal —
  both are covered by the documented "committed-transaction visibility; no snapshot isolation across requests".
- **Migration 0009's backfill requires a BYPASSRLS/superuser migration role** (audit_events is under FORCE RLS);
  the migration asserts this precondition loudly rather than silently backfilling nothing (review F3).
- No live authenticated web-route acceptance was performed (owner/external gate); hosted zero-skip PostgreSQL CI is
  the authoritative gate; the Next build ran locally.
