// ACBP-P6-004b — payload binding, expiry, revocation, single-use consumption (CDR-069; ADR-009; APPR-004/005/006/009).
//
// 0047 ended with an explicit note: *"No payload hash, no expiry column, no revocation state… a request here is not
// yet a bound, consumable token, and no column implies otherwise."* This migration is the ticket that makes it one.
//
// ALTER-ONLY. `approval_requests` grows five facts and two statuses; `approval_decisions` is untouched, because a
// decision is still exactly what a human said and none of this changes that.
//
// ── THE STATE MACHINE, AFTER THIS MIGRATION ──────────────────────────────────────────────────────────────────
//
//   pending ──decide──> decided ──consume──> consumed        (terminal: single-use, APPR-009)
//      │                   │
//      │                   └──revoke───────> revoked         (terminal: APPR-006)
//      └──edit_then_approve─> superseded                     (terminal: invariant 7)
//
// `revoked` and `consumed` are BOTH reachable only from `decided`, and that is the substantive rule rather than a
// tidiness one. Revoking withdraws an authorization; a `pending` request has none to withdraw (the answer there is
// to reject it), and a `superseded` one was already replaced. Consuming spends an authorization, so it needs one.
//
// ── WHY EXPIRY IS NOT NULL AND CARRIES NO DEFAULT ────────────────────────────────────────────────────────────
// ADR-009 §15 leaves *"expiry defaults per risk class"* an OPEN OWNER QUESTION (AOQ-14-adjacent). The mechanism
// ships; the policy does not. `expires_at` is NOT NULL with no column default, so every request states its own
// expiry and the owner's eventual per-risk-class values land in one place without touching enforcement.
//
// A nullable "no expiry" column was rejected in CDR-069 §1-G3: it would make the ABSENCE of an owner decision read
// as permission to never expire, which is the exact shape this phase exists to prevent.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── THE BINDING (APPR-004) ─────────────────────────────────────────────────────────────────────────────────
  //
  // Added NULLABLE, backfilled, then constrained — the standard three-step, because a NOT NULL column cannot be
  // added to a table that might hold rows without one.
  //
  // THE BACKFILL IS FAIL-CLOSED BY CONSTRUCTION, and it uses the versioning mechanism rather than a magic hash:
  // `binding_version = 0` is not a ruleset that exists, and `bindingMatches` in @acbp/contracts refuses any version
  // it does not recognise. So a pre-binding request can never match any payload — not because its hash is unlikely
  // to collide, but because there is no ruleset under which it could be recomputed.
  await sql`alter table public.approval_requests add column payload_hash text`.execute(db);
  await sql`alter table public.approval_requests add column binding_version integer`.execute(db);
  await sql`update public.approval_requests set payload_hash = repeat('0', 64), binding_version = 0 where payload_hash is null`.execute(db);
  await sql`alter table public.approval_requests alter column payload_hash set not null`.execute(db);
  await sql`alter table public.approval_requests alter column binding_version set not null`.execute(db);

  // ── EXPIRY (APPR-005) ──────────────────────────────────────────────────────────────────────────────────────
  //
  // Backfilled to `created_at`, which is already in the past for every existing row — so a request that predates
  // binding is expired at any instant it could be evaluated. Fail-closed again, and for the same reason: the safe
  // reading of "we do not know when this should expire" is "it already has".
  await sql`alter table public.approval_requests add column expires_at timestamptz`.execute(db);
  await sql`update public.approval_requests set expires_at = created_at where expires_at is null`.execute(db);
  await sql`alter table public.approval_requests alter column expires_at set not null`.execute(db);

  // ── REVOCATION (APPR-006) ──────────────────────────────────────────────────────────────────────────────────
  await sql`alter table public.approval_requests add column revoked_at timestamptz`.execute(db);
  await sql`alter table public.approval_requests add column revoked_by_user_id uuid`.execute(db);
  // Users are GLOBAL (no tenant column), so a single-column FK is correct here — the same shape
  // `approval_decisions_user_fk` uses. Everything tenant-scoped below is composite.
  await sql`alter table public.approval_requests
            add constraint approval_requests_revoked_by_fk
            foreign key (revoked_by_user_id) references public.users (id) on delete no action on update no action`.execute(db);

  // ── CONSUMPTION (APPR-009) ─────────────────────────────────────────────────────────────────────────────────
  await sql`alter table public.approval_requests add column consumed_at timestamptz`.execute(db);
  await sql`alter table public.approval_requests add column consumed_by_call_id uuid`.execute(db);

  // TENANT-PINNED, because RI checks ALWAYS bypass RLS: without the company in the FK, one company's approval could
  // cite another company's tool call and no row-level policy would catch it.
  //
  // The composite target ALREADY EXISTS — 0045 created `tool_calls_id_company_uq` as a unique index for exactly this
  // class of reference. This migration first tried to add it again and the real database refused; the assumption
  // that it was missing came from reading one migration file instead of measuring the schema.
  await sql`alter table public.approval_requests
            add constraint approval_requests_consumed_by_fk
            foreign key (consumed_by_call_id, company_id) references public.tool_calls (id, company_id) on delete no action on update no action`.execute(db);

  // ── THE BINDING'S OWN SHAPE ────────────────────────────────────────────────────────────────────────────────
  // A sha256 hex digest, exactly. Not a length check: a 64-character string of anything is not a hash, and the
  // column is the last place a malformed one can be caught before it is compared against a real digest.
  await sql`alter table public.approval_requests add constraint approval_requests_payload_hash_shape check (payload_hash ~ '^[0-9a-f]{64}$')`.execute(db);
  // Version 0 is the backfill sentinel and is deliberately INSIDE the permitted range — the contract refuses it as
  // an unknown ruleset, which is a stronger and more honest guarantee than the database pretending it cannot exist.
  await sql`alter table public.approval_requests add constraint approval_requests_binding_version_valid check (binding_version >= 0)`.execute(db);

  // ── THE STATUS VOCABULARY, WIDENED ─────────────────────────────────────────────────────────────────────────
  // Mirrors the statuses @acbp/database's schema types name, and a test asserts the two agree in BOTH directions —
  // widening here without widening the contract is exactly the divergence that test now catches.
  await sql`alter table public.approval_requests drop constraint approval_requests_status_valid`.execute(db);
  await sql`alter table public.approval_requests
            add constraint approval_requests_status_valid
            check (status in ('pending', 'decided', 'superseded', 'revoked', 'consumed'))`.execute(db);

  // ── THE STATUS AND ITS TIMESTAMPS STILL CANNOT DISAGREE ────────────────────────────────────────────────────
  //
  // Extended rather than replaced in spirit: every status names exactly which timestamps must and must not be set.
  // A `consumed` row with no consuming call, or a `revoked` row that was never decided, is a record that cannot be
  // read truthfully later — and "who authorized this, and was it still valid?" is the only question this table
  // exists to answer.
  //
  // REVOKED AND CONSUMED ARE MUTUALLY EXCLUSIVE, which is the schema-level statement of CDR-069 §1-G6: exactly one
  // of the two racing operations wins, and the row records which.
  await sql`alter table public.approval_requests drop constraint approval_requests_status_consistent`.execute(db);
  await sql`alter table public.approval_requests
            add constraint approval_requests_status_consistent
            check (
              (status = 'pending'    and decided_at is null     and superseded_at is null and superseded_by_request_id is null
                                     and revoked_at is null     and consumed_at is null)
              or (status = 'decided' and decided_at is not null and superseded_at is null
                                     and revoked_at is null     and consumed_at is null)
              or (status = 'superseded' and superseded_at is not null
                                     and revoked_at is null     and consumed_at is null)
              or (status = 'revoked'  and decided_at is not null and revoked_at is not null and revoked_by_user_id is not null
                                     and consumed_at is null    and superseded_at is null)
              or (status = 'consumed' and decided_at is not null and consumed_at is not null and consumed_by_call_id is not null
                                     and revoked_at is null     and superseded_at is null)
            )`.execute(db);

  // Consumption is SINGLE-USE, and this is that claim as a constraint rather than as a code path: one approval can
  // be spent on at most one tool call. Without it, two rows could name the same consuming call and the "single" in
  // single-use would rest entirely on the conditional UPDATE being written correctly forever.
  await sql`create unique index approval_requests_consumed_call_uq on public.approval_requests (consumed_by_call_id) where consumed_by_call_id is not null`.execute(db);

  // The verify-and-consume predicate's index (CDR-069 §1-G5): the one statement that decides whether an action runs.
  await sql`create index approval_requests_consumable_idx on public.approval_requests (company_id, run_id, tool_id) where status = 'decided'`.execute(db);

  // ── THE GRANT, WIDENED TO EXACTLY THE NEW LIFECYCLE COLUMNS ────────────────────────────────────────────────
  // Column-scoped, as before. The binding and expiry columns are NOT here: `payload_hash`, `binding_version` and
  // `expires_at` are set once at INSERT and are content, not lifecycle. An approval whose expiry could be pushed
  // out after a human read it, or whose hash could be re-pointed at a different payload, is the material-change
  // hole invariant 7 exists to close — and it would defeat this entire ticket from inside the product role.
  await sql`grant update (status, decided_at, superseded_at, superseded_by_request_id, revoked_at, revoked_by_user_id, consumed_at, consumed_by_call_id) on public.approval_requests to ${APP_ROLE}`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`revoke update on public.approval_requests from ${APP_ROLE}`.execute(db);
  await sql`grant update (status, decided_at, superseded_at, superseded_by_request_id) on public.approval_requests to ${APP_ROLE}`.execute(db);

  await sql`drop index if exists public.approval_requests_consumable_idx`.execute(db);
  await sql`drop index if exists public.approval_requests_consumed_call_uq`.execute(db);

  // NORMALIZE BEFORE NARROWING (review pass 2, F6). PostgreSQL validates `ADD CONSTRAINT ... CHECK` against
  // existing rows, so re-adding the pre-P6-004 status vocabulary while any row is `consumed` or `revoked` fails
  // with 23514 — proven against the real database. The repo's "migrations reverse fully and re-apply" test only
  // ever ran against EMPTY tables, so it could not see this; 0047's `down()` drops the whole table, which is why
  // this is the first ALTER-only migration on `approval_requests` where the hazard exists at all.
  //
  // `consumed` and `revoked` both collapse to `decided`, which is the state they were reached from and the only
  // one the old vocabulary can express. The terminal facts themselves survive in the columns dropped below, so
  // nothing is silently rewritten — the columns go, and with them the states that needed them.
  await sql`update public.approval_requests set status = 'decided' where status in ('consumed', 'revoked')`.execute(db);
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_status_consistent`.execute(db);
  await sql`alter table public.approval_requests
            add constraint approval_requests_status_consistent
            check ((status = 'pending' and decided_at is null and superseded_at is null and superseded_by_request_id is null)
                or (status = 'decided' and decided_at is not null and superseded_at is null)
                or (status = 'superseded' and superseded_at is not null))`.execute(db);
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_status_valid`.execute(db);
  await sql`alter table public.approval_requests add constraint approval_requests_status_valid check (status in ('pending', 'decided', 'superseded'))`.execute(db);

  await sql`alter table public.approval_requests drop constraint if exists approval_requests_binding_version_valid`.execute(db);
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_payload_hash_shape`.execute(db);
  // `tool_calls_id_company_uq` is NOT dropped here — 0045 owns it, and dropping another migration's object on the
  // way down is how a reversal takes something unrelated with it.
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_consumed_by_fk`.execute(db);
  await sql`alter table public.approval_requests drop constraint if exists approval_requests_revoked_by_fk`.execute(db);

  for (const column of ['consumed_by_call_id', 'consumed_at', 'revoked_by_user_id', 'revoked_at', 'expires_at', 'binding_version', 'payload_hash']) {
    await sql`alter table public.approval_requests drop column if exists ${sql.ref(column)}`.execute(db);
  }
}
