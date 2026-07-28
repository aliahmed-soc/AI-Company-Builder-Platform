// ACBP-P5-003b — tool calls (CDR-054; TOOL-002/003; WORK-005; NFR-006; ADR-012; trust-critical #4/#11).
//
// The 100%-coverage surface of the enforcement chokepoint. Every proposed tool call gets a row here, INCLUDING the
// ones that are refused — TOOL-001's failure clause is "Unknown tools cannot be invoked; attempts are audited", and
// an attempt with no record is not audited.
//
// Company-owned and dual-keyed exactly like every other tenant table; that argument is inherited, not repeated.
// No new SECURITY DEFINER (the closed allowlist stays three), no new role.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // `task_runs` needs an additive (id, company_id) UNIQUE so the call FK can be TENANT-PINNED. RI checks ALWAYS
  // bypass RLS, so a single-column FK would let a call reference ANOTHER company's run and the reference itself would
  // never be policy-checked. Guarded by name, matching the 0035 idiom.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_constraint where conname = 'task_runs_id_company_uq') then
        alter table public.task_runs add constraint task_runs_id_company_uq unique (id, company_id);
      end if;
    end $$;
  `.execute(db);

  await db.schema
    .createTable('tool_calls')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // A CALL BELONGS TO A RUN (DATA-ARCHITECTURE). NOT NULL: a nullable, FK-less run reference would make "a tool call
    // belonging to nothing" a legal state on the one surface that must account for everything (CDR-052 §1).
    .addColumn('run_id', 'uuid', (col) => col.notNull())
    // DELIBERATELY NOT A FOREIGN KEY to `tool_definitions`. A refused call must still be recorded, and the commonest
    // refusal is a tool that is not registered — an FK here would make the required record impossible to write. The
    // registry lookup is the dispatcher's job; this column records what was ASKED FOR, registered or not.
    .addColumn('tool_id', 'text', (col) => col.notNull())
    // WHICH REGISTERED VERSION was in force (review pass 2). EVENT-CATALOG names `tool_id+version` on
    // `tool.call_requested`, and without it a re-registration at v2 makes every past record ambiguous about which
    // definition - and so which risk class - actually applied. NULL only when the tool was not registered at all.
    .addColumn('tool_version', 'integer')
    // The class the gate actually applied, SNAPSHOT at dispatch. The registry can be re-classified afterwards, and a
    // record that re-read the registry would misreport which gate a past call passed through.
    .addColumn('risk_class', 'text', (col) => col.notNull())
    // Whether that class means an EXTERNAL effect. A boolean rather than a list of class names in the CHECK below, so
    // the receipt rule survives a re-shaping of the risk-class set (CDR-051 §0.1 flags one as open).
    .addColumn('external_effect', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('outcome', 'text', (col) => col.notNull().defaultTo('requested'))
    .addColumn('denial_reason', 'text')
    // TOOL-002 says "arguments DIGEST". sha256 hex of a canonical encoding — never the arguments, which is both the
    // charter's standing rule and what keeps a 100%-coverage table from becoming where secrets accumulate.
    .addColumn('arguments_digest', 'text', (col) => col.notNull())
    // NFR-006 duplicate suppression. Per COMPANY (see the partial unique below), never global.
    .addColumn('idempotency_key', 'text')
    // TOOL-002: an external write may only claim success with a stored receipt. Enforced by CHECK, not just by code.
    .addColumn('receipt_ref', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('tool_calls_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('tool_calls_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // TENANT-PINNED composite: a call can only reference a run in its OWN company.
    .addForeignKeyConstraint('tool_calls_run_fk', ['run_id', 'company_id'], 'task_runs', ['id', 'company_id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('tool_calls_outcome_valid', sql`outcome in ('requested', 'denied', 'succeeded', 'failed', 'unconfirmed')`)
    .addCheckConstraint('tool_calls_risk_class_valid', sql`risk_class in ('informational', 'internal_reversible', 'external_reversible', 'external_irreversible')`)
    // ONE-DIRECTIONAL, the P5-009/P5-001c lesson: a reason implies a denial, but the constraint never claims the
    // reverse, so history predating a later vocabulary change stays legal.
    .addCheckConstraint(
      'tool_calls_denial_reason_valid',
      sql`denial_reason is null or (denial_reason in ('not_registered', 'no_allowlist', 'not_allowlisted', 'emergency_stopped', 'stop_unavailable', 'policy_denied', 'policy_unavailable', 'approval_invalid', 'approval_required') and outcome = 'denied')`,
    )
    .addCheckConstraint('tool_calls_version_positive', sql`tool_version is null or tool_version >= 1`)
    .addCheckConstraint('tool_calls_digest_shape', sql`arguments_digest ~ '^[0-9a-f]{64}$'`)
    // TOOL-002's failure clause, made structural: an external effect cannot be reported as `succeeded` without a
    // receipt. The honest outcome for that case is `unconfirmed`, which this leaves available.
    //
    // BLANK COUNTS AS MISSING (review pass 1). `is null` alone would accept a whitespace receipt — a value that
    // satisfies the constraint while evidencing nothing, which is exactly the hollow success this rule exists to
    // prevent. The use case rejects it too; this is the layer that holds when something skips the use case.
    .addCheckConstraint('tool_calls_receipt_required', sql`not (outcome = 'succeeded' and external_effect and coalesce(btrim(receipt_ref), '') = '')`)
    .execute();

  // PER-COMPANY idempotency (CDR-049 §4 precedent): a global unique would let one tenant's key collide with — and so
  // reveal the existence of — another's. PARTIAL, because most calls carry no key; `ON CONFLICT` must restate this
  // predicate, since PostgreSQL will not infer a partial index from a bare column list (42P10).
  await sql`
    create unique index tool_calls_idempotency_uq on public.tool_calls (company_id, tool_id, idempotency_key)
    where idempotency_key is not null
  `.execute(db);

  // The two reads: a run's calls, and a company's recent calls for the completeness check.
  await sql`create index tool_calls_run_idx on public.tool_calls (run_id, created_at desc)`.execute(db);
  await sql`create index tool_calls_company_outcome_idx on public.tool_calls (company_id, outcome, created_at desc)`.execute(db);

  // LEAST PRIVILEGE. SELECT + INSERT + a COLUMN-SCOPED update of exactly the outcome columns. Tenancy, run linkage,
  // tool id, risk class and the arguments digest are IMMUTABLE to the app role — a call cannot be re-pointed at
  // another run, re-labelled with a gentler class, or have its arguments swapped after the gate passed it.
  // NO DELETE: a call record is the evidence the call happened.
  await sql`grant select, insert on public.tool_calls to ${APP_ROLE}`.execute(db);
  await sql`grant update (outcome, denial_reason, receipt_ref, updated_at) on public.tool_calls to ${APP_ROLE}`.execute(db);

  await sql`alter table public.tool_calls enable row level security`.execute(db);
  await sql`alter table public.tool_calls force row level security`.execute(db);
  await sql`create policy tool_calls_select on public.tool_calls for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy tool_calls_insert on public.tool_calls for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy tool_calls_update on public.tool_calls for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists tool_calls_update on public.tool_calls`.execute(db);
  await sql`drop policy if exists tool_calls_insert on public.tool_calls`.execute(db);
  await sql`drop policy if exists tool_calls_select on public.tool_calls`.execute(db);
  await sql`revoke all on public.tool_calls from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.tool_calls_company_outcome_idx`.execute(db);
  await sql`drop index if exists public.tool_calls_run_idx`.execute(db);
  await sql`drop index if exists public.tool_calls_idempotency_uq`.execute(db);
  await db.schema.dropTable('tool_calls').ifExists().execute();
  // The additive UNIQUE on `task_runs` IS dropped here, unlike 0035's on `tasks`: this migration is the only thing
  // that created it, and nothing else references it.
  await sql`alter table public.task_runs drop constraint if exists task_runs_id_company_uq`.execute(db);
}
