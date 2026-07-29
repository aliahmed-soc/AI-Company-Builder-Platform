// ACBP-P6-001b — policy storage and append-only evaluation records (CDR-066 §5; POL-005/006; ADR-010).
//
// TWO TABLES WITH DELIBERATELY DIFFERENT POSTURES, because canon gives them different lifecycles:
//
//   policies            — C (+G defaults), VERSIONED, `active→superseded`, "Permanent versions".
//                         SELECT + INSERT + a column-scoped UPDATE(status, superseded_at). NO DELETE.
//   policy_evaluations  — C, A/I (append-only/immutable), terminal, retention >= audit retention (POL-006).
//                         SELECT + INSERT only. NO UPDATE of any kind, NO DELETE.
//
// THE DENORMALIZED VERSION CANNOT DRIFT. `policy_evaluations` stores `policy_version` as well as `policy_id`,
// because POL-006 wants a record that stands on its own — and a copy that can disagree with its source is worse
// than no copy. So the FK is COMPOSITE over (policy_id, policy_version, company_id): PostgreSQL refuses any row
// whose stated version is not the version of the policy it names. The copy is guaranteed by construction rather
// than by whichever code path happened to write it.
//
// TENANT-PINNED FKs THROUGHOUT. RI checks ALWAYS bypass RLS, so a single-column FK would let one company's
// evaluation cite another company's policy and never be caught. On the table that records who was allowed to do
// what, that is the last place to leave that hole.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // A composite FK requires a UNIQUE on exactly the referenced columns, and `tool_calls` is keyed on `id` alone —
  // checked rather than assumed, because a missing unique here fails at migration time, not at review time.
  // Additive and index-only: no column, constraint or grant on `tool_calls` changes, so P5-003b's posture is intact.
  await sql`create unique index tool_calls_id_company_uq on public.tool_calls (id, company_id)`.execute(db);

  // ── policies ────────────────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('policies')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    // The rule-set version an evaluation cites. 1-based and monotonic per company; never reused, because a reused
    // version number would make two different rule sets indistinguishable in the audit trail.
    .addColumn('version', 'integer', (col) => col.notNull())
    // The decision when no rule restricts (CDR-066 §3-G9/G10). NOT NULL and CHECKed: a policy whose default posture
    // is unknown is not a policy we may act on, and the contract-level evaluator refuses one too.
    .addColumn('baseline', 'text', (col) => col.notNull())
    // The rules, as the contract's `PolicyRule[]`. `jsonb` because the rule language is a closed, validated shape
    // owned by @acbp/contracts — the database's job is to store it faithfully, not to re-implement its validation
    // in CHECK constraints that would then be a second place to keep in step.
    .addColumn('rules', 'jsonb', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_by_user_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('superseded_at', 'timestamptz')
    .addForeignKeyConstraint('policies_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('policies_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addCheckConstraint('policies_version_positive', sql`version >= 1`)
    // Mirrors `POLICY_DECISIONS` in @acbp/contracts. Duplicated on purpose and asserted equal by a test — the
    // ACTIVITY_TYPES divergence (contracts widened without a migration) is the precedent for why a silently
    // diverging pair is a booby trap rather than a convenience.
    .addCheckConstraint('policies_baseline_valid', sql`baseline in ('allow', 'require_approval', 'deny')`)
    .addCheckConstraint('policies_status_valid', sql`status in ('active', 'superseded')`)
    // `rules` must be a JSON ARRAY. Without this a caller could store an object or a bare string and the engine
    // would read zero rules from it — a policy that silently enforces nothing.
    .addCheckConstraint('policies_rules_is_array', sql`jsonb_typeof(rules) = 'array'`)
    // The status and the timestamp cannot disagree. An `active` row with a supersession time, or a `superseded` row
    // without one, is a record that cannot be read honestly afterwards.
    .addCheckConstraint('policies_supersede_consistent', sql`(status = 'active' and superseded_at is null) or (status = 'superseded' and superseded_at is not null)`)
    .addUniqueConstraint('policies_company_version_uq', ['company_id', 'version'])
    // THE COMPOSITE TARGET the evaluation's version-pinned FK needs. A plain FK on `policy_id` alone could not
    // enforce that the recorded version is the policy's own.
    .addUniqueConstraint('policies_id_version_company_uq', ['id', 'version', 'company_id'])
    .execute();

  // AT MOST ONE ACTIVE VERSION PER COMPANY. Partial, so superseded versions accumulate freely — which is the point
  // of "permanent versions". Two simultaneously-active policies would make "which rules decided this?" unanswerable.
  await sql`create unique index policies_company_active_uq on public.policies (company_id) where status = 'active'`.execute(db);

  // LEAST PRIVILEGE, with ONE legal mutation. Superseding is a real transition canon names, so it needs an UPDATE —
  // but only of the two columns that carry it. No DELETE: an evaluation cites its version forever, and deleting the
  // version would leave the trail pointing at nothing.
  await sql`grant select, insert on public.policies to ${APP_ROLE}`.execute(db);
  await sql`grant update (status, superseded_at) on public.policies to ${APP_ROLE}`.execute(db);

  await sql`alter table public.policies enable row level security`.execute(db);
  await sql`alter table public.policies force row level security`.execute(db);
  await sql`create policy policies_select on public.policies for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy policies_insert on public.policies for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  // USING *and* WITH CHECK. Without WITH CHECK an update could move a row out of the caller's tenant — the row would
  // be visible to change and free to land anywhere.
  await sql`create policy policies_update on public.policies for update using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY}) with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);

  // ── policy_evaluations ──────────────────────────────────────────────────────────────────────────────────
  await db.schema
    .createTable('policy_evaluations')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('policy_id', 'uuid', (col) => col.notNull())
    // Stored ALONGSIDE the id, and pinned to it by the composite FK below (CDR-066 §5-G12).
    .addColumn('policy_version', 'integer', (col) => col.notNull())
    // Which of the three mandatory points this was (APPROVAL-AND-POLICY-ARCHITECTURE §5).
    .addColumn('evaluation_point', 'text', (col) => col.notNull())
    .addColumn('decision', 'text', (col) => col.notNull())
    .addColumn('escalate', 'boolean', (col) => col.notNull().defaultTo(false))
    // The three rule-id lists the evaluator returns. `unevaluable` is the one that matters operationally: a run of
    // evaluations with entries here is a policy that is failing closed rather than working.
    .addColumn('fired_rule_ids', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('unevaluable_rule_ids', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    .addColumn('untrusted_rule_ids', 'jsonb', (col) => col.notNull().defaultTo(sql`'[]'::jsonb`))
    // THE INSTANT THAT WAS PASSED IN. G3 made the clock an input so the evaluator is a function of its arguments;
    // without recording which instant, a working-hours decision cannot be re-derived from its own record.
    .addColumn('evaluated_at', 'timestamptz', (col) => col.notNull())
    // Only point 3 has one. Nullable, because points 1 and 2 evaluate an action that has not been dispatched — and
    // point 1 is marked NOT skippable, so making it unrecordable would break canon.
    .addColumn('tool_call_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('policy_evaluations_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('policy_evaluations_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // VERSION-PINNED AND TENANT-PINNED in one constraint. This is what makes `policy_version` a fact rather than a
    // hopeful copy, and it is why `policies` has no DELETE grant.
    .addForeignKeyConstraint('policy_evaluations_policy_fk', ['policy_id', 'policy_version', 'company_id'], 'policies', ['id', 'version', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addForeignKeyConstraint('policy_evaluations_tool_call_fk', ['tool_call_id', 'company_id'], 'tool_calls', ['id', 'company_id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addCheckConstraint('policy_evaluations_decision_valid', sql`decision in ('allow', 'require_approval', 'deny')`)
    .addCheckConstraint('policy_evaluations_point_valid', sql`evaluation_point in ('proposed', 'approval_requested', 'pre_execution')`)
    // Escalation is a property of REFUSING. An escalated `allow` is a contradiction the engine never produces, and
    // storing one would put a claim in the trail that no evaluation could have made.
    .addCheckConstraint('policy_evaluations_escalate_on_deny', sql`escalate = false or decision = 'deny'`)
    .addCheckConstraint('policy_evaluations_lists_are_arrays', sql`jsonb_typeof(fired_rule_ids) = 'array' and jsonb_typeof(unevaluable_rule_ids) = 'array' and jsonb_typeof(untrusted_rule_ids) = 'array'`)
    .execute();

  await sql`create index policy_evaluations_company_created_idx on public.policy_evaluations (company_id, created_at desc)`.execute(db);
  await sql`create index policy_evaluations_policy_idx on public.policy_evaluations (policy_id)`.execute(db);
  await sql`create index policy_evaluations_tool_call_idx on public.policy_evaluations (tool_call_id) where tool_call_id is not null`.execute(db);

  // APPEND-ONLY, ABSOLUTELY. No UPDATE — not even column-scoped — and no DELETE. POL-006 makes these records the
  // evidence of what the platform allowed; evidence that can be edited afterwards is not evidence.
  await sql`grant select, insert on public.policy_evaluations to ${APP_ROLE}`.execute(db);

  await sql`alter table public.policy_evaluations enable row level security`.execute(db);
  await sql`alter table public.policy_evaluations force row level security`.execute(db);
  await sql`create policy policy_evaluations_select on public.policy_evaluations for select using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
  await sql`create policy policy_evaluations_insert on public.policy_evaluations for insert with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop policy if exists policy_evaluations_insert on public.policy_evaluations`.execute(db);
  await sql`drop policy if exists policy_evaluations_select on public.policy_evaluations`.execute(db);
  await sql`revoke all on public.policy_evaluations from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.policy_evaluations_tool_call_idx`.execute(db);
  await sql`drop index if exists public.policy_evaluations_policy_idx`.execute(db);
  await sql`drop index if exists public.policy_evaluations_company_created_idx`.execute(db);
  await db.schema.dropTable('policy_evaluations').ifExists().execute();

  await sql`drop policy if exists policies_update on public.policies`.execute(db);
  await sql`drop policy if exists policies_insert on public.policies`.execute(db);
  await sql`drop policy if exists policies_select on public.policies`.execute(db);
  await sql`revoke all on public.policies from ${APP_ROLE}`.execute(db);
  await sql`drop index if exists public.policies_company_active_uq`.execute(db);
  await db.schema.dropTable('policies').ifExists().execute();

  await sql`drop index if exists public.tool_calls_id_company_uq`.execute(db);
}
