// ACBP-P2-001 — interview sessions (CDR-022; DISC-007; ADR-008 durability/checkpoint semantics;
// WORKFLOW-STATE-MACHINES §2). ADDITIVE expand migration — migrations 0001–0011 are untouched, NO SECURITY
// DEFINER function is added (the closed allowlist stays exactly three), and no existing table/policy changes.
//
// One company-owned, dual-keyed table:
//
//   - `interview_sessions` — the durable founder-discovery session envelope. ONE row per session; the mutable
//     `state` column carries the WORKFLOW §2 lifecycle (not_started → in_progress ⇄ waiting_for_user →
//     ready_for_review → confirmed → superseded). Server-enforced transitions live in @acbp/core; this table
//     enforces the CLOSED state set and the state/timestamp shape at the CHECK level, keeps IDENTITY columns
//     immutable at the PRIVILEGE level (no UPDATE grant on id/account/company/created_at), and — via a partial
//     unique index — allows AT MOST ONE open (non-superseded) session per company (CDR-022 §5). History of
//     transitions lives in `audit_events` (interview.started), not here.
//
// No backfill: existing companies have no interview session until one is started through the app. Because
// nothing is read from an existing FORCE-RLS table, this migration needs no BYPASSRLS guard (unlike 0009/0010).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1) interview_sessions — the durable session row ──────────────────────────────────────────────────────
  await db.schema
    .createTable('interview_sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('not_started'))
    .addColumn('started_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('interview_sessions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('interview_sessions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // The CLOSED canonical state set (WORKFLOW §2). The full set is pinned now (the interview lifecycle is fully
    // decided), so later tickets add transitions/effects, not new states — no CHECK churn.
    .addCheckConstraint('interview_sessions_state_valid', sql`state in ('not_started', 'in_progress', 'waiting_for_user', 'ready_for_review', 'confirmed', 'superseded')`)
    // Shape: `started_at` is set IFF the session has left `not_started` (a session in `not_started` has never
    // started; any other state has a start timestamp).
    .addCheckConstraint('interview_sessions_started_shape', sql`(state = 'not_started' and started_at is null) or (state <> 'not_started' and started_at is not null)`)
    .execute();

  // ── 2) At most ONE open (non-superseded) session per company (CDR-022 §5). Superseded sessions accumulate as
  //    history; a company has a single current session at any time. ─────────────────────────────────────────
  await sql`
    create unique index interview_sessions_one_open_per_company
      on public.interview_sessions (company_id)
      where state <> 'superseded'
  `.execute(db);

  // A supporting index for the common "the sessions of this company" read (keyset-friendly, newest first).
  await sql`
    create index interview_sessions_company_created_idx
      on public.interview_sessions (company_id, created_at desc, id desc)
  `.execute(db);

  // ── 3) Least-privilege grants ────────────────────────────────────────────────────────────────────────────
  //    SELECT + INSERT + COLUMN-LEVEL UPDATE on exactly the mutable columns. Identity columns
  //    (id, account_id, company_id, created_at) have NO update privilege → immutable to the app role. No
  //    DELETE/TRUNCATE.
  await sql`grant select, insert on public.interview_sessions to ${APP_ROLE}`.execute(db);
  await sql`grant update (state, started_at, updated_at) on public.interview_sessions to ${APP_ROLE}`.execute(db);

  // ── 4) Enable + FORCE RLS (applies to the owner too; only BYPASSRLS/superusers bypass) ───────────────────
  await sql`alter table public.interview_sessions enable row level security`.execute(db);
  await sql`alter table public.interview_sessions force row level security`.execute(db);

  // ── 5) Dual-keyed fail-closed policies: every command requires the caller resolved into BOTH the account AND
  //    the specific company (a validated CompanyScope). No account-only authority, no FOR ALL policy, no DELETE
  //    policy (and no delete grant either). ──────────────────────────────────────────────────────────────────
  await sql`
    create policy interview_sessions_select on public.interview_sessions for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy interview_sessions_insert on public.interview_sessions for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy interview_sessions_update on public.interview_sessions for update
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of ['interview_sessions_select', 'interview_sessions_insert', 'interview_sessions_update'] as const) {
    await sql`drop policy if exists ${sql.ref(p)} on public.interview_sessions`.execute(db);
  }
  await sql`revoke all on public.interview_sessions from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('interview_sessions').ifExists().execute();
}
