// ACBP-P5-004 — worker definitions and the per-company pause state (CDR-056; WORK-001/006; ADR-012;
// trust-critical #4; AI-AND-WORKER-ARCHITECTURE §2).
//
// TWO TABLES, because they answer to two different owners:
//   `worker_definitions`    — GLOBAL platform configuration. What a worker IS. SELECT-only for the app role, exactly
//                             like `tool_definitions` (P5-003a): a definition the product could rewrite at runtime is
//                             not a control. Canon is explicit that workers are "versioned configuration + prompts
//                             over one shared execution runtime — not independent agent services".
//   `company_worker_states` — TENANT data. Whether a worker may run HERE. WORK-006 is per company, by the owner.
//
// No new SECURITY DEFINER (the closed allowlist stays three), no new role.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('worker_definitions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // `research@1` — the id and version together are the identity (canon's own example).
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    // Declared task types it may accept. CHECKed against P4-003's closed set, so a definition cannot claim a
    // capability the task model has no name for.
    .addColumn('capabilities', sql`text[]`, (col) => col.notNull())
    // THE ALLOWLIST (WORK-005; invariant 4). Its home, at last: CDR-054 §1-G3 and CDR-055 both deferred to here.
    .addColumn('allowed_tools', sql`text[]`, (col) => col.notNull())
    // The task-type input contract and the artifact contract, by REFERENCE. Storing the schemas themselves would make
    // this table a second source of truth for something the code already owns.
    .addColumn('input_schema_ref', 'text', (col) => col.notNull())
    .addColumn('output_schema_ref', 'text', (col) => col.notNull())
    // NFR-015 budgets. Integer micro-units, matching `usage_events.estimated_cost_micros` — never a float.
    // The VALUES are IOQ-12's, interim and revisit-bound (CDR-056 §3); columns rather than constants precisely so
    // changing one is a data change, not a deploy.
    .addColumn('max_spend_micros', 'integer', (col) => col.notNull())
    .addColumn('max_duration_ms', 'integer', (col) => col.notNull())
    // TASK-010: which failure categories auto-retry. A subset of the run failure categories.
    .addColumn('retry_categories', sql`text[]`, (col) => col.notNull())
    // The approval profile as a THRESHOLD (CDR-056 §2-G3). NULL = nothing this worker does is approval-gated.
    .addColumn('approval_threshold_risk_class', 'text')
    // Which gateway task-class config it uses (ADR-011).
    .addColumn('model_task_class', 'text', (col) => col.notNull())
    // Redaction class for its prompts/outputs.
    .addColumn('logging_redaction_class', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('worker_definitions_id_version_uq', ['worker_id', 'version'])
    .addCheckConstraint('worker_definitions_status_valid', sql`status in ('active', 'retired')`)
    .addCheckConstraint('worker_definitions_version_positive', sql`version >= 1`)
    // A worker with no capability accepts nothing and a worker with no tools can do nothing; both are definitions
    // that would silently never work, which is worse than a refusal at registration time.
    .addCheckConstraint('worker_definitions_capabilities_present', sql`cardinality(capabilities) > 0`)
    .addCheckConstraint('worker_definitions_tools_present', sql`cardinality(allowed_tools) > 0`)
    // EXACTLY P4-003's `TASK_TYPES`. A capability naming a type the task model does not have could never match a
    // task, so it would be a definition that silently never runs. Asserted set-equal in the integration suite.
    .addCheckConstraint('worker_definitions_capabilities_valid', sql`capabilities <@ array['market_research', 'competitor_research', 'customer_segment_analysis', 'business_model_comparison', 'business_plan_generation', 'landing_page_copy', 'internal_product_requirements']::text[]`)
    .addCheckConstraint('worker_definitions_retry_categories_valid', sql`retry_categories <@ array['worker_lost', 'timeout', 'provider_error', 'policy_blocked', 'internal_error']::text[]`)
    .addCheckConstraint('worker_definitions_approval_threshold_valid', sql`approval_threshold_risk_class is null or approval_threshold_risk_class in ('informational', 'internal_reversible', 'external_reversible', 'external_irreversible')`)
    .addCheckConstraint('worker_definitions_model_task_class_valid', sql`model_task_class in ('interactive', 'extraction', 'classification', 'generation')`)
    .addCheckConstraint('worker_definitions_budgets_positive', sql`max_spend_micros > 0 and max_duration_ms > 0`)
    .execute();

  await sql`create index worker_definitions_lookup_idx on public.worker_definitions (worker_id, status, version desc)`.execute(db);
  // SELECT ONLY. The registry is platform configuration; there is no runtime write path, which is what makes an
  // allowlist a control rather than a suggestion.
  await sql`grant select on public.worker_definitions to ${APP_ROLE}`.execute(db);

  // ── the per-company state (WORK-006) ─────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('company_worker_states')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // The worker ID only, NOT a version: an owner pauses "the research worker", not "research@1". Pinning the state
    // to a version would silently un-pause the worker the moment a new version was registered.
    .addColumn('worker_id', 'text', (col) => col.notNull())
    .addColumn('state', 'text', (col) => col.notNull().defaultTo('enabled'))
    // Why the owner paused it. Bounded; never surfaced into an audit payload as free text.
    .addColumn('reason', 'text')
    .addColumn('changed_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('company_worker_states_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('company_worker_states_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // One state per worker per company. The upsert arbiter.
    .addUniqueConstraint('company_worker_states_company_worker_uq', ['company_id', 'worker_id'])
    .addCheckConstraint('company_worker_states_state_valid', sql`state in ('enabled', 'paused', 'disabled')`)
    .addCheckConstraint('company_worker_states_reason_bounded', sql`reason is null or char_length(reason) <= 500`)
    .execute();

  // SELECT + INSERT + a COLUMN-scoped UPDATE of exactly the mutable state. Tenancy and the worker id are immutable:
  // a pause cannot be re-pointed at a different worker or a different company after the fact.
  await sql`grant select, insert on public.company_worker_states to ${APP_ROLE}`.execute(db);
  await sql`grant update (state, reason, changed_by_user_id, updated_at) on public.company_worker_states to ${APP_ROLE}`.execute(db);

  await sql`alter table public.company_worker_states enable row level security`.execute(db);
  await sql`alter table public.company_worker_states force row level security`.execute(db);
  await sql`create policy company_worker_states_select on public.company_worker_states for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy company_worker_states_insert on public.company_worker_states for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy company_worker_states_update on public.company_worker_states for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists company_worker_states_update on public.company_worker_states`.execute(db);
  await sql`drop policy if exists company_worker_states_insert on public.company_worker_states`.execute(db);
  await sql`drop policy if exists company_worker_states_select on public.company_worker_states`.execute(db);
  await sql`revoke all on public.company_worker_states from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('company_worker_states').ifExists().execute();
  await sql`revoke all on public.worker_definitions from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.worker_definitions_lookup_idx`.execute(db);
  await db.schema.dropTable('worker_definitions').ifExists().execute();
}
