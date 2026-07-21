# CDR-014 — Audit event foundation: account-scoped first cut (ACBP-P1-008)

Status: **Accepted** (owner decision 2026-07-22, Option A). Governs ACBP-P1-008.
Sources: ADR-015 (accepted); EVENT-CATALOG.md envelope; DATA-ARCHITECTURE.md §2 + audit-event object (`:41`);
TECHNICAL-ARCHITECTURE-v1.md invariant 11 (`:156`); FAILURE-AND-RECOVERY.md row 14 (`:20`); ENGINEERING-STANDARDS
`:20-21,35,47`; TENANCY.md / CDR-013 (RLS + restricted role + the closed 3-function SECURITY DEFINER allowlist);
CDR-009 (audit retention). Backlog ACBP-P1-008 (`Append-only audit store; in-tx write pattern for high-risk ops`).

## Decision (Option A — account-scoped foundation)

ADR-015 mandates ONE append-only audit store spanning company/account/global (`C/A/G`) rows, but the P1-006 RLS
model keys only on `app.current_account` — `app.current_company` is never set until P1-010 (company rows fail
closed) and global rows (webhook/reconcile, pre-account events) have no tenant predicate under FORCE RLS, so
inserting them under the restricted `acbp_app` role would require either a cross-tenant-leaky permissive policy
or a **prohibited 4th SECURITY DEFINER function**. Canon is also silent on global-row `account_id` nullability
and on whether denial audits persist independently of a rolled-back business transaction. The owner therefore
scoped the P1-008 **first cut** as follows:

1. **One append-only `audit_events` table, account-scoped now.** `account_id` is `NOT NULL` (no `company_id`
   column yet — added by an expand-migration at P1-010; no FK to `accounts`, so a redacted audit trace can
   survive account deletion per SECURITY-ARCHITECTURE `:20`). Envelope columns from EVENT-CATALOG: server-
   generated ULID `event_id` (PK), registered `name` + `schema_version`, `account_id`, `actor_type`
   (`user|worker|system|admin`) + nullable `actor_id`, `subject_type`/`subject_id`, bounded `outcome`,
   `correlation_id`, `causation_id`, `idempotency_key` (unique when present), bounded JSON `payload`
   (references/digests only — no secrets/PII), immutable server `occurred_at`.
2. **FORCE RLS keyed to `app.current_account`; append-only.** `acbp_app` gets `INSERT` (WITH CHECK
   `account_id = current_account`, fail-closed text compare) + `SELECT` (same predicate) — and **NO UPDATE,
   DELETE, or TRUNCATE** grant or policy. The owner/migration role owns the table. This realizes invariant 11
   (no product-API mutation path) by persistence constraint, not a runtime guard. The migration grants
   BYPASSRLS to no one and adds **no** SECURITY DEFINER function (the allowlist stays exactly three).
3. **In-transaction write pattern proven.** An account-scoped audit writer inserts the row using the caller's
   `AccountScope` inside `withAccountTransaction`; `account_id`/`actor_id`/`event_id`/`occurred_at` are bound
   **server-side** from the scope (never caller-supplied → unforgeable). A write failure rolls back the whole
   transaction, so the business mutation is undone and the action is blocked (ADR-015; FAILURE row 14).
4. **Events durably persisted now (high-risk, account-scoped, in-tx):** `membership.invited`,
   `membership.revoked` — authorization-gated account **lifecycle transitions** already emitted inside
   `withAccountTransaction`. Actor = `{type:'user', id: server-verified scope actor}`.
5. **Explicitly deferred (stay interim structured logs, as today), with rationale:**
   - **Denials** (`authz.denied`, `tenant.context_denied`): a denial has no business mutation to bundle with;
     whether denial audits persist despite rollback is canonically unresolved (later decision).
   - **Global events** (`webhook.*`, `reconcile.*`): no tenant predicate under FORCE RLS; a global-audit
     isolation model (and any privileged path) is a later decision — never a 4th SECURITY DEFINER function.
   - **Pre-context bootstrap events** (`account.created`, `membership.accepted`): run outside
     `withAccountTransaction` (SECURITY DEFINER bootstraps); co-writing durably is a later decision.
   - **Lower-risk events** (`account.profile_updated`): ADR-015 routes these through the transactional
     **outbox**, which is not built in P1-008.
6. **Out of scope for P1-008 (canon-aligned):** company-scoped audit (P1-010), the transactional outbox and
   activity feed (P1-009+), the audit read/export/admin API (separate API-CONTRACTS contract), and the
   retention/purge job (CDR-009 / later). No customer-visible history in this ticket.

## Rejected alternatives
- **Option B (single C/A/G table with nullable tenant + global rows now):** requires inserting tenant-less
  global rows under `acbp_app` + FORCE RLS — a permissive global policy (cross-tenant disclosure risk) or a
  prohibited 4th SECURITY DEFINER function. Rejected: too much blast radius on the foundational isolation model
  before P1-010, edges into a prohibited privileged path.
- **Option C (A + audit the two bootstrap events via the existing 3 SECURITY DEFINER functions):** avoids a
  new function but expands elevated SQL surface and changes those functions' contracts/tests. Rejected for the
  first cut; may return as a scoped follow-up.

## Consequences
- The append-only immutability + in-transaction write pattern + completeness check (the P1-008 acceptance
  criteria) are fully satisfied for the account-scoped high-risk lifecycle path — the dominant real case today.
- The schema extends forward under expand-migrate-contract (add `company_id` and any global-scope strategy in
  later tickets) without reworking the account path.
- Some events previously tagged "durable store is P1-008" remain interim structured logs past P1-008; this CDR
  is the canonical record of that deferral and its rationale.
