# Audit event foundation (ACBP-P1-008)

Status: implemented for the **account-scoped** first cut (CDR-014 Option A). This is the "audit README" for the
ticket. Governing: ADR-015; EVENT-CATALOG.md (envelope); TECHNICAL-ARCHITECTURE-v1.md invariant 11 (audit
immutability); FAILURE-AND-RECOVERY.md row 14 (fail-closed); ENGINEERING-STANDARDS §Transaction/Audit; CDR-009
(retention); CDR-014 (scope decision).

## Logging vs. durable audit — two separate systems

| | Operational logging (`@acbp/observability`) | Durable audit (`audit_events`) |
|---|---|---|
| Purpose | human/operations visibility, telemetry | non-repudiable evidence for high-risk operations |
| Delivery | best-effort, stdout/structured, may be sampled | mandatory, append-only DB row |
| Durability | ephemeral | permanent (retention ≥ product data; 7-yr class, CDR-009) |
| On failure | never blocks the business operation | **rolls back the operation (fail closed)** |
| Transaction | none | **same transaction as the mutation it records** |

The two are NOT the same system and are not merged: the Logger is never redirected into `audit_events`, and a
durable audit row is never treated as a log line. For the two migrated operations both are emitted — the
`logger.info` for operations, and the durable `audit_events` row as the authoritative record.

## Data model — `audit_events` (migration 0007)

One **append-only, account-scoped** table (CDR-014 Option A). Columns (EVENT-CATALOG envelope):

| Column | Notes |
|---|---|
| `event_id` (text PK) | server-generated **ULID** (time-sortable; NOT a causal-ordering guarantee) |
| `name` | dot-namespaced, past-tense; validated against the closed `@acbp/contracts` registry |
| `schema_version` (int) | per event name |
| `account_id` (uuid, NOT NULL) | tenant stamp; **no FK** (a redacted trace can survive account deletion) |
| `actor_type` | `user` \| `worker` \| `system` \| `admin` (CHECK) |
| `actor_id` (uuid, null) | null for system/provider actors |
| `subject_type` / `subject_id` | bounded reference to the resource the event is about |
| `outcome` | `success` \| `denied` \| `blocked` (CHECK) |
| `correlation_id` / `causation_id` | request/job correlation |
| `idempotency_key` (unique when present) | producer dedupe |
| `payload` (jsonb) | bounded metadata — references/digests only, **no secrets/tokens/PII** |
| `occurred_at` (timestamptz) | immutable server clock (default now()) |

### Immutability (invariant 11) and RLS

`ENABLE` + `FORCE ROW LEVEL SECURITY`, keyed to the per-transaction `app.current_account` GUC (fail-closed text
comparison). The restricted `acbp_app` role is granted **INSERT + SELECT only** — there is **no UPDATE/DELETE
grant and no UPDATE/DELETE policy**, and it cannot ALTER/DROP/TRUNCATE the table, drop/alter its policies,
disable/un-force RLS, grant itself privileges, `SET ROLE`, or create a role (all proven in
`audit.integration.test.ts`). Immutability is thus enforced by **persistence constraint**, not a runtime guard.
The migration/owner role owns the table; the migration grants BYPASSRLS to no one and adds **no** SECURITY
DEFINER function (the P1-006 allowlist stays exactly three).

## Write path — same-transaction, fail-closed, unforgeable

`writeAuditEvent(scope, event, ctx)` (`@acbp/database`) is the only write path. It runs on the caller's
`AccountScope` **inside `withAccountTransaction`**, i.e. in the same transaction as the business mutation. It
binds `account_id`, `actor_id`, `event_id`, and `occurred_at` **server-side from the validated scope and the
server clock** — a caller cannot supply them (they are not parameters), so an audit row's account, actor,
identity, and time cannot be forged through the API. The caller supplies only a typed `AuditEvent` built by a
registered factory (`membershipInvited` / `membershipRevoked` / `companyCreated` / `companyUpdated` /
`companyPaused` / `companyResumed`) — there are no free-form event objects, and an unregistered name cannot be
constructed. A write failure throws, rolling the whole transaction back so the business mutation is undone and
the action is blocked. Since P1-010 the writer also accepts a **company (tenant) scope**; when given one it
binds `company_id` server-side from that scope (see "Extended in P1-010").

## Implemented in P1-008 (durable, in-transaction)

- `membership.invited` — on a successful invite (owner-gated lifecycle transition).
- `membership.revoked` — on a successful revocation only (a conditional `WHERE status='active'` transition;
  `RevokeResult.changed` gates the write so an idempotent no-op / last-owner denial / missing or cross-account
  target / rolled-back mutation / racing revoke produces **no** success audit).

### Completeness

`@acbp/core` `audit/audit-operations.ts` holds `AUDITED_OPERATIONS` (approved operation → event) with a
compile-time-**exhaustive** `factoryFor`, so a new approved high-risk operation cannot be registered without a
factory, and a unit test asserts every registered contract event is produced by an operation (no orphan). The
real-PostgreSQL producer tests then prove each operation actually writes its event in-transaction, so a use case
that loses its durable write fails CI. This is structural — not a source-grep.

## Extended in P1-010 (company-scoped events; CDR-015)

Migration `0008` adds a **nullable** `company_id` (uuid, no FK — a redacted trace survives company deletion) to
`audit_events` — an additive expand that preserves the append-only immutability (still INSERT + SELECT only; no
UPDATE/DELETE grant or policy). The two policies become **dual-scope**: an **account event** has `company_id
IS NULL` and is visible under `app.current_account`; a **company event** carries `company_id` and is visible /
insertable only when **both** `app.current_account` **and** `app.current_company` match (fail-closed text
comparison). No policy lets an account member read or forge another company's events by matching only the
account, and a company event cannot be stamped with a `company_id` other than the current company (proven in
`company.integration.test.ts`). The allowlist stays exactly three SECURITY DEFINER functions.

Four durable, in-transaction company events (written via `writeAuditEvent` under a resolved **CompanyScope**,
which binds `company_id`/`account_id`/`actor_id`/`event_id`/`occurred_at` server-side):

- `company.created` — on a successful create bootstrap (payload: `creation_mode`).
- `company.updated` — on a profile/name edit that actually changes a field (payload: `changed_fields` — the
  changed field **names** only, never values; an idempotent no-op edit writes nothing).
- `company.paused` / `company.resumed` — on a legal owner-driven `active⇄paused` transition (the transition
  asserts the specific expected prior status, so an owner resume can only apply to a `paused` company and the
  event is never mislabeled). The payload is **empty**: no caller-supplied free-text `reason` is accepted or
  persisted into the immutable store (data minimization; security review LOW-1). The contract factories retain an
  optional coarse `reason`/`held_work_count` for a future SERVER-set value; they are not populated from request
  input. An illegal/no-op transition writes nothing.

Six durable, in-transaction **workspace-provisioning** events (ACBP-P1-012; CDR-018 §8) — AUDIT-ONLY, never
activity-projected; written under a resolved CompanyScope atomically with the state change they record:

- `provisioning.started` (`{step_count}`) — checkpoints seeded (creation bootstrap, or the once-only
  backfilled-draft bring-up).
- `provisioning.step_started` (`{step, attempt}`) / `provisioning.step_completed` (`{step, attempt,
  result_code}`) / `provisioning.step_failed` (outcome `blocked`; `{step, attempt, failure_code}`) — one
  started+outcome pair per COMMITTED attempt (an interrupted attempt commits nothing). Closed result/failure
  codes only — never exception text, SQL, or free-form reasons. SYSTEM actor (the scope-bound `actor_id`
  records whose request drove the execution — provenance, not authority).
- `provisioning.retry_requested` (`{step, next_attempt}`) — the only USER-actor provisioning event; the retry
  run's system events reference it via `causation_id`.
- `provisioning.completed` (`{step_count}`) — written atomically with the `onboarding→active` transition.

One durable, in-transaction **platform-admin** event (ACBP-P1-013; CDR-019) — AUDIT-ONLY, never
activity-projected:

- `admin.tenant_read` (`{reason, scope='company_overview'}`) — THE admin-action record for the one sanctioned
  cross-tenant company-overview read. Written into the TARGET tenant's trail (target account/company ids) with
  `actor_type='admin'` and the REAL administrator's internal user id (never a tenant user — no impersonation).
  The `reason` is the caller's mandatory justification retained VERBATIM (validated: ≥1 non-whitespace char,
  ≤512 Unicode code points, no NUL; never trimmed/normalized). Audit-or-nothing: the overview is returned ONLY
  after this event committed in the same transaction — an audit failure rolls back and delivers no data. To
  admit a 512-code-point astral-plane reason (up to 1024 UTF-16 units), the per-value metadata bound was raised
  512→1024 UTF-16 units (total-payload bound unchanged; boundary tests pin both).

One durable, in-transaction **interview** event (ACBP-P2-001; CDR-022) — `interview.started`, emitted on
`not_started→in_progress` in the session-start transaction.

Three durable, in-transaction **typed-memory** events (ACBP-P2-006; ACBP-P2-010; CDR-024/CDR-025) — AUDIT-ONLY,
never activity-projected. Each is written in the SAME transaction as its mutation (audit-or-nothing: a write
failure rolls the mutation back, so no memory change is ever unaudited); subject = the memory item id;
actor/account/company stamped server-side from the CompanyScope; metadata carries ONLY bounded references —
never the founder content or the raw `source_ref` value (data minimization):

- `memory.item_created` (`{item_type, source_type}`) — a typed memory item was created (P2-006; MEM-003).
- `understanding.generated` (`{version, status, item_count}`) — a classified understanding document version was
  generated (P2-008; CDR-029). Written in the SAME transaction as the versioned document + items insert
  (audit-or-nothing); subject = the document id; bounded metadata, NO generated content. Activity fan-out deferred.
- `memory.item_superseded` (`{item_type, source_type}` of the NEW version) — an item was corrected by a
  versioned supersede (P2-010; owner-only `memory:edit`). Subject = the superseded (old) item.
- `memory.item_deleted` (`{item_type, source_type, transition:'active_to_deleted'}`) — an item was soft-deleted
  (P2-010; owner-only `memory:delete`). Subject = the deleted item.

The M3 domain fan-out (`understanding.corrected` → memory) and the `interview.question_answered` → memory
consumer remain deferred (no outbox yet); the deletion-propagation to dependent understanding/plans is likewise
M3/M4 (CDR-025 §7).

Completeness is enforced the same way: `AUDITED_OPERATIONS` is partitioned into membership, company,
provisioning, admin, interview, and memory subsets, each domain's real-PostgreSQL producer test provides a
**compile-exhaustive** driver over its subset, and a compile-time guard asserts the partition covers exactly the
full operation set.

## Explicitly deferred (still interim structured logs — NOT durable)

Recorded here and in CDR-014; these names are deliberately **not** in the audit registry, so nothing claims
them durable:

- **Denials:** `authz.denied`, `tenant.context_denied` — a denial has no business transaction to bundle with;
  whether denial audits persist independently of rollback is a later decision.
- **Pre-context bootstrap:** `account.created`, `membership.accepted` — run outside `withAccountTransaction`
  (SECURITY DEFINER bootstraps); co-writing durably is a later decision (never a 4th SECURITY DEFINER function).
- **Lower-risk:** `account.profile_updated` — ADR-015 routes it through the transactional **outbox**, not built
  here.
- **Global events:** `webhook.*`, `reconcile.*` — no tenant predicate under FORCE RLS; a global-audit isolation
  model is a later decision.
- **Company-scoped audit:** ✅ implemented in P1-010 (see "Extended in P1-010") — the four `company.*` events
  are durable and dual-scope; the interim-log deferral above no longer applies to them.

## Out of P1-008 scope (later tickets)

Audit **read/export/admin API** (separate API-CONTRACTS contract); **retention/purge** enforcement worker
(CDR-009 / later); customer-visible history. The **activity feed** is implemented in **P1-009** (CDR-016): the four
durable `company.*` events project SYNCHRONOUSLY, in the same CompanyScope transaction, into an append-only,
company-scoped `activity_events` table (`audit_events` stays authoritative; the projection is redacted +
rebuildable, keyed by the source audit `event_id`) — see `docs/architecture/ACTIVITY.md`. The transactional
**outbox** + async projector remain deferred (later, with higher-volume event sources).

## Recovery / operations

An audit-write failure on a high-risk op fails the action closed (the user sees a safe error; no partial state).
Audit-write failure is a page-level operational alert (OBSERVABILITY §2). No mutation of audit rows is possible
through product paths; retention/redaction on account deletion is a controlled non-product path (later).

## Residual risks (accepted; from independent review)

- **`name`/`subject_type` are enforced at the app layer, not by a DB CHECK.** The closed event registry lives in
  `@acbp/contracts` and the only write path is the typed `writeAuditEvent` (registered factories only). A DB
  CHECK on `name` is deliberately omitted so the registry can grow without a per-event migration; the residual —
  a hypothetical compromised app path appending a spurious own-account row with an unregistered name — is
  inherent to granting the app role INSERT, is RLS-bound to the caller's own account, and does not affect the
  immutability of existing rows.
- **`correlation_id`/`causation_id`/`idempotency_key` are opaque server identifiers** — the writer now rejects
  any that exceed 200 chars (defense against a future caller routing user-derived data into these columns).
- **`actor_type` is caller-supplied** (defaults `'user'`, DB-CHECK-bound to the enum); `actor_id`/`account_id`
  remain server-bound from the scope, so this is not a forgery vector. The two P1-008 producers never override it.
- **Completeness for FUTURE operations** is enforced by a compile-time-exhaustive per-operation producer test
  plus the no-orphan/`factoryFor` checks — a new approved op cannot be registered without a driver that proves
  its in-transaction write.
- **The operational `logger.info` fires before the in-tx audit write commits**; on an audit-write failure the
  stdout log persists though the transaction rolls back (best-effort log; the durable `audit_events` row is the
  authoritative record and correctly shows nothing).
- **No live authenticated web-route acceptance was performed** (owner/external gate); hosted CI (zero-skip
  PostgreSQL) is the authoritative evidence. Out-of-scope P1-004 finding flagged separately: a last-owner
  concurrency race in `revokeMemberWithStore` (two concurrent revokes of different owners) — its own ticket.

## Supply-chain note (not a P1-008 feature)

A cross-cutting remediation landed on this branch because it blocked the repo-wide `pnpm audit --audit-level
high` gate: a `pnpm-workspace.yaml` override forcing transitive `sharp` to `>=0.35.0` (GHSA-f88m-g3jw-g9cj). It
is a separate commit; `sharp` is an **unused optional** transitive dependency of Next.js (apps/web does not use
`next/image`); `next build` compatibility was verified locally. This is not an audit feature.
