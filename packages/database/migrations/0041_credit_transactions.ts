// ACBP-P5-014 — the credit ledger (CDR-058; BILL-002; TASK-004; ADR-013; invariant 10; trust-critical AT-025).
//
// APPEND-ONLY, STRUCTURALLY. SELECT + INSERT and nothing else: no UPDATE grant on any column, no DELETE. Invariant 10
// ("corrections use compensating entries") is then a property of the grants rather than of anyone's restraint.
//
// NO BALANCE COLUMN. Canon is explicit — *"Balance is always derived"* (`USAGE-AND-BILLING §2`). A stored total would
// be a second source of truth, and the moment it disagreed with the ledger nobody could say which was right. The
// balance is `SUM(credits)`, which works because the amounts are SIGNED and the signs are enforced below.
//
// ACCOUNT-OWNED, COMPANY-ATTRIBUTED (`DATA-ARCHITECTURE` line 354 scopes this `A/C`). The balance is per ACCOUNT —
// ADR-003's binding refinement, and a founder with three companies has one pool, not three — while each spend records
// WHICH company burned it. RLS therefore keys on `account_id` ALONE: putting `company_id` in the predicate would stop
// an owner ever seeing their own balance, because a balance spans companies and the GUC holds one at a time.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('credit_transactions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    // ATTRIBUTION, not isolation. NULL only for account-level grants (a plan reset belongs to no single company).
    .addColumn('company_id', 'uuid')
    .addColumn('kind', 'text', (col) => col.notNull())
    // SIGNED, and whole credits. The sign convention IS the arithmetic: with signed rows the balance is SUM(credits)
    // and nothing else, so no reader has to remember which kinds subtract.
    .addColumn('credits', 'integer', (col) => col.notNull())
    // The run this entry is about. Reservations and their settlements carry it; grants do not.
    .addColumn('run_id', 'uuid')
    // INVARIANT 10: a correction references the original it compensates, and a settlement references its reservation.
    .addColumn('references_txn_id', 'uuid')
    // BILL-002's race rule (`API-CONTRACTS` line 47): *"one credit spend per key"*.
    .addColumn('idempotency_key', 'text')
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('credit_transactions_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('credit_transactions_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite: an entry can only reference a run in the company it is attributed to. RI checks always
    // bypass RLS, so a single-column FK would let it point at another company's run and never be policy-checked.
    .addForeignKeyConstraint('credit_transactions_run_fk', ['run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addForeignKeyConstraint('credit_transactions_references_fk', ['references_txn_id'], 'credit_transactions', ['id'], (cb) => cb.onDelete('no action').onUpdate('no action'))
    .addCheckConstraint('credit_transactions_kind_valid', sql`kind in ('grant', 'reservation', 'consumption', 'release', 'correction')`)
    // THE SIGN CONVENTION, ENFORCED. A negative grant would be a spend wearing a grant's name; a positive reservation
    // would mint. The database refuses both rather than trusting every future writer to get the sign right.
    .addCheckConstraint(
      'credit_transactions_sign_valid',
      sql`(kind in ('grant', 'release') and credits > 0)
          or (kind in ('reservation', 'consumption') and credits < 0)
          or (kind = 'correction' and credits <> 0)`,
    )
    // A composite FK is MATCH SIMPLE: if ANY column is NULL it is not enforced at all. Without this, a row with a
    // `run_id` and no `company_id` would skip the tenant pin entirely — the hole the composite FK exists to close.
    .addCheckConstraint('credit_transactions_run_needs_company', sql`run_id is null or company_id is not null`)
    // A SPEND always names its company. Only a grant may be account-level.
    .addCheckConstraint('credit_transactions_spend_needs_company', sql`kind not in ('reservation', 'consumption', 'release') or company_id is not null`)
    // WHAT REFERENCES WHAT (invariant 10). A settlement points at its reservation and a correction at its original;
    // a grant and a reservation start their own chains and point at nothing.
    .addCheckConstraint(
      'credit_transactions_reference_shape',
      sql`(kind in ('consumption', 'release', 'correction') and references_txn_id is not null)
          or (kind in ('grant', 'reservation') and references_txn_id is null)`,
    )
    .addCheckConstraint('credit_transactions_no_self_reference', sql`references_txn_id is null or references_txn_id <> id`)
    .execute();

  // ONE SPEND PER KEY (BILL-002). Scoped to reservations: the consumption and release that follow legitimately share
  // a run, and it is the RESERVATION that must not happen twice.
  await sql`create unique index credit_transactions_reservation_key_uq on public.credit_transactions (account_id, idempotency_key) where kind = 'reservation' and idempotency_key is not null`.execute(db);
  // ONE SETTLEMENT PER RESERVATION (CDR-058 G8). Covering consumption AND release together is what stops a run being
  // consumed and then also released — which would mint a credit out of an ordinary retry.
  await sql`create unique index credit_transactions_settlement_uq on public.credit_transactions (references_txn_id) where kind in ('consumption', 'release')`.execute(db);
  // The balance read: every row for one account.
  await sql`create index credit_transactions_account_idx on public.credit_transactions (account_id, created_at)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT only — no UPDATE grant on any column, and no DELETE. There is no path by which
  // the app role can rewrite or remove a ledger row, which is what makes invariant 10 structural.
  await sql`grant select, insert on public.credit_transactions to ${APP_ROLE}`.execute(db);

  await sql`alter table public.credit_transactions enable row level security`.execute(db);
  await sql`alter table public.credit_transactions force row level security`.execute(db);
  await sql`create policy credit_transactions_select on public.credit_transactions for select using (account_id::text = ${CURRENT_ACCOUNT})`.execute(db);
  // MINTING IS NOT A PRODUCT OPERATION. The policy admits only the three run-lifecycle kinds, so the app role cannot
  // write a `grant` (which creates credits outright) or a `correction` (which may be positive, and so can also
  // create them). Both are platform/billing operations performed out of band. A table-level INSERT grant cannot
  // express this — an RLS WITH CHECK can, which is what makes "no minting path" structural rather than a convention.
  await sql`create policy credit_transactions_insert on public.credit_transactions for insert with check (account_id::text = ${CURRENT_ACCOUNT} and kind in ('reservation', 'consumption', 'release'))`.execute(db);
  // NO update or delete policy, deliberately, and no grant to pair one with.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists credit_transactions_insert on public.credit_transactions`.execute(db);
  await sql`drop policy if exists credit_transactions_select on public.credit_transactions`.execute(db);
  await sql`revoke all on public.credit_transactions from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.credit_transactions_account_idx`.execute(db);
  await sql`drop index if exists public.credit_transactions_settlement_uq`.execute(db);
  await sql`drop index if exists public.credit_transactions_reservation_key_uq`.execute(db);
  await db.schema.dropTable('credit_transactions').ifExists().execute();
}
