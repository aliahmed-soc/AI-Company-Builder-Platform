// ACBP-P7-013 — the API request-limit buckets (CDR-082 §3.1; CDR-008 §8; NFR-010).
//
// ── WHY A TABLE AND NOT A PROCESS-LOCAL MAP ──────────────────────────────────────────────────────────────────
//
// An in-memory counter is not a rate limit under more than one instance; it is a per-process courtesy that
// degrades silently, in the attacker's favour, exactly when load makes a second instance appear. The deployment
// topology is unknown — there is no deployment configuration anywhere in this repository (CDR-082 §1.4) — so
// assuming one process would be assuming the most convenient fact available.
//
// ── WHY THIS TABLE CARRIES NO RLS, WHICH IS A DEPARTURE THAT NEEDS A REASON ──────────────────────────────────
//
// Migration 0005 established the precedent in its own words: *"Global identity tables (users,
// identity_webhook_receipts) carry no RLS."* This is the same class. A SESSION bucket must be consultable
// BEFORE any account is known — that is the entire point of checking it ahead of the Clerk Backend API call
// (CDR-082 §3.3) — so there is no tenant context to scope it by, and a tenant-scoped table would be unreadable
// at the moment it is needed.
//
// ── WHY THE KEY IS HASHED ────────────────────────────────────────────────────────────────────────────────────
//
// The raw key is a Clerk session id or an internal account id. Neither is a secret, but this platform's standing
// rule is that raw identifying payloads are not persisted where a sha256 will do (the identity-webhook receipts
// store a digest for exactly this reason), and a global unscoped table is the worst place to keep the one thing
// that would make its rows attributable. A counter does not need to know whose it is. Hashing costs nothing,
// removes the only identifying column, and leaves the table exactly as useful: `sha256(kind + ':' + key)`,
// computed in the application (no pgcrypto dependency), so a row is a number and a timestamp and nothing else.
//
// ── WHY THERE IS NO CLEANUP JOB ──────────────────────────────────────────────────────────────────────────────
//
// A fully-refilled bucket is arithmetically indistinguishable from an absent one, so a stale row is inert rather
// than wrong, and expiring rows is a storage decision rather than a correctness one. There is no scheduler in
// this repository to run a sweep from. Recorded as open in CDR-082 §8.6 rather than left unsaid.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');

/** The two keys CDR-008 §8 rules, and the only two. A third would need a value decision, not a code change. */
const SCOPE_KINDS = "'session', 'account'";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('api_rate_limit_buckets')
    // sha256 hex of `${kind}:${key}` — 64 chars, never the raw session or account id (see header).
    .addColumn('scope_key_hash', 'text', (c) => c.primaryKey())
    .addColumn('scope_kind', 'text', (c) => c.notNull())
    // Milli-tokens. INTEGER, never a float: a fractional refill accumulated in floating point drifts, and a
    // limit that drifts is a limit nobody can reason about (CDR-082 §3.2).
    .addColumn('tokens_milli', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull())
    .execute();

  await sql
    .raw(`alter table public.api_rate_limit_buckets add constraint api_rate_limit_buckets_scope_kind_valid check (scope_kind in (${SCOPE_KINDS}))`)
    .execute(db);

  // The bucket arithmetic clamps at zero on the way in; this refuses a negative that arrived any other way.
  // A negative balance would read as debt and refuse a client for longer than the rule says.
  await sql`alter table public.api_rate_limit_buckets add constraint api_rate_limit_buckets_tokens_non_negative check (tokens_milli >= 0)`.execute(db);

  // A 64-character lowercase-hex digest. Pins the column to what the application actually writes, so a raw
  // session id inserted by mistake is refused by the database rather than persisted.
  await sql`alter table public.api_rate_limit_buckets add constraint api_rate_limit_buckets_key_hash_shape check (scope_key_hash ~ '^[0-9a-f]{64}$')`.execute(db);

  // No RLS — see the header. Global, unscoped, and granted only the verbs the consume statement uses. There is
  // no DELETE grant: nothing in the product deletes a bucket, and a limiter that can drop its own state is a
  // limiter an attacker can reset.
  await sql`grant select, insert, update on public.api_rate_limit_buckets to ${APP_ROLE}`.execute(db);

  await sql`comment on table public.api_rate_limit_buckets is
    'ACBP-P7-013: CDR-008 section 8 request limits. Global and un-RLSed by design (migration 0005 precedent) because a session bucket is consulted before any tenant context exists. Keys are sha256 digests, never raw session or account ids.'`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Dropping is safe and lossless in the way that matters: the table holds only transient counters, so a
  // rollback costs at most one refill window of leniency. It does NOT hold anything anyone could need later.
  await sql`revoke all on public.api_rate_limit_buckets from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('api_rate_limit_buckets').ifExists().execute();
}
