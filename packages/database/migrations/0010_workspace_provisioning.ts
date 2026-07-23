// ACBP-P1-012 — workspace provisioning checkpoints + workspace-area registry (CDR-018; COMP-002/003; ADR-008
// semantics). ADDITIVE expand migration — migrations 0001–0009 are untouched, NO SECURITY DEFINER function is
// added (the closed allowlist stays exactly three), and no existing table/policy changes.
//
// Two company-owned, dual-keyed tables:
//
//   - `provisioning_steps` — ONE MUTABLE current-state row per (company, step) for the six canonical workspace
//     provisioning steps. Durable statuses are pending | completed | failed ONLY (a `running` state is NEVER
//     committed — CDR-018 §4 — so no lease/heartbeat machinery exists). Attempts are bounded to 3 TOTAL.
//     History is NOT kept here: every transition is audited in `audit_events` in the same transaction, so the
//     mutable row + append-only audit together give current state AND full history. Column-level UPDATE grants
//     make identity columns (account/company/step/step_order/requested_at/created_at) immutable to `acbp_app`
//     at the PRIVILEGE level (no UPDATE grant on those columns at all).
//
//   - `company_workspace_areas` — the minimal, append-only workspace-area registry (mission_draft, research,
//     roadmap, documents — the four steps that CREATE something; profile/activity are verification steps).
//     INSERT + SELECT only.
//
// BACKFILL: every EXISTING company still in `draft` or `onboarding` gets its six PENDING checkpoint rows so a
// later owner-triggered resume can provision it. The backfill runs NO provisioning and performs NO lifecycle
// transition (statuses untouched); it is deterministic + idempotent (ON CONFLICT DO NOTHING). It READS
// `companies` (FORCE RLS since 0008) on the migration connection, so the migration role must bypass RLS —
// guarded loudly below (the 0009 precedent).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // 0) PRECONDITION: the backfill reads `companies` under FORCE RLS with no GUCs set — a non-bypassing
  //    migration role would silently see ZERO companies and "succeed" with an empty backfill. Fail loudly.
  await sql`
    do $$
    begin
      if not (select (rolbypassrls or rolsuper) from pg_roles where rolname = current_user) then
        raise exception 'migration 0010 requires a BYPASSRLS/superuser migration role: companies is under FORCE RLS and the checkpoint backfill would silently read zero rows';
      end if;
    end
    $$;
  `.execute(db);

  // ── 1) provisioning_steps — mutable per-(company, step) checkpoint row ───────────────────────────────────
  await db.schema
    .createTable('provisioning_steps')
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('step', 'text', (col) => col.notNull())
    .addColumn('step_order', 'integer', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('attempt', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('requested_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('failed_at', 'timestamptz')
    .addColumn('failure_code', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('provisioning_steps_pk', ['company_id', 'step'])
    .addForeignKeyConstraint('provisioning_steps_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('provisioning_steps_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // The closed six-step set, with step_order pinned to the CANONICAL order (CDR-018 §2).
    .addCheckConstraint('provisioning_steps_step_valid', sql`step in ('profile', 'mission_draft', 'research', 'roadmap', 'documents', 'activity')`)
    .addCheckConstraint(
      'provisioning_steps_order_canonical',
      sql`(step = 'profile' and step_order = 1) or (step = 'mission_draft' and step_order = 2) or (step = 'research' and step_order = 3) or (step = 'roadmap' and step_order = 4) or (step = 'documents' and step_order = 5) or (step = 'activity' and step_order = 6)`,
    )
    // Durable statuses ONLY — `running` is structurally impossible to commit (CDR-018 §4).
    .addCheckConstraint('provisioning_steps_status_valid', sql`status in ('pending', 'completed', 'failed')`)
    // 3 TOTAL attempts; pending has never been attempted; a committed outcome implies >= 1 attempt.
    .addCheckConstraint('provisioning_steps_attempt_bounded', sql`attempt >= 0 and attempt <= 3`)
    .addCheckConstraint('provisioning_steps_attempt_consistent', sql`(status = 'pending' and attempt = 0) or (status <> 'pending' and attempt >= 1)`)
    // Status/timestamp/failure-code consistency (fail-closed shape per status; closed failure codes).
    .addCheckConstraint('provisioning_steps_pending_shape', sql`status <> 'pending' or (started_at is null and completed_at is null and failed_at is null and failure_code is null)`)
    .addCheckConstraint('provisioning_steps_completed_shape', sql`status <> 'completed' or (started_at is not null and completed_at is not null and failed_at is null and failure_code is null)`)
    .addCheckConstraint('provisioning_steps_failed_shape', sql`status <> 'failed' or (started_at is not null and failed_at is not null and completed_at is null and failure_code in ('profile_missing', 'activity_projection_missing', 'internal_error'))`)
    .execute();

  // ── 2) company_workspace_areas — minimal append-only area registry ───────────────────────────────────────
  await db.schema
    .createTable('company_workspace_areas')
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('area', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('company_workspace_areas_pk', ['company_id', 'area'])
    .addForeignKeyConstraint('company_workspace_areas_company_fk', ['company_id'], 'companies', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    .addForeignKeyConstraint('company_workspace_areas_account_fk', ['account_id'], 'accounts', ['id'], (cb) => cb.onDelete('cascade').onUpdate('no action'))
    // The closed area set (CDR-018 §6): the four registry steps only — profile/activity create no area.
    .addCheckConstraint('company_workspace_areas_area_valid', sql`area in ('mission_draft', 'research', 'roadmap', 'documents')`)
    .execute();

  // ── 3) BACKFILL: six PENDING checkpoints for every existing draft/onboarding company (CDR-018 §9). ───────
  //    Executes nothing, transitions nothing, creates no area rows; deterministic + idempotent.
  await sql`
    insert into public.provisioning_steps (account_id, company_id, step, step_order)
    select c.account_id, c.id, s.step, s.step_order
    from public.companies c
    cross join (values
      ('profile', 1), ('mission_draft', 2), ('research', 3), ('roadmap', 4), ('documents', 5), ('activity', 6)
    ) as s(step, step_order)
    where c.status in ('draft', 'onboarding')
    on conflict (company_id, step) do nothing
  `.execute(db);

  // ── 4) Least-privilege grants ────────────────────────────────────────────────────────────────────────────
  //    provisioning_steps: SELECT + INSERT + COLUMN-LEVEL UPDATE on exactly the mutable outcome columns.
  //    Identity columns (account_id, company_id, step, step_order, requested_at, created_at) have NO update
  //    privilege → immutable to the app role. No DELETE/TRUNCATE for either table.
  await sql`grant select, insert on public.provisioning_steps to ${APP_ROLE}`.execute(db);
  await sql`grant update (status, attempt, started_at, completed_at, failed_at, failure_code, updated_at) on public.provisioning_steps to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.company_workspace_areas to ${APP_ROLE}`.execute(db);

  // ── 5) Enable + FORCE RLS (applies to the owner too; only BYPASSRLS/superusers bypass) ───────────────────
  for (const t of ['provisioning_steps', 'company_workspace_areas'] as const) {
    await sql`alter table public.${sql.ref(t)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} force row level security`.execute(db);
  }

  // ── 6) Dual-keyed fail-closed policies: every command requires the caller resolved into BOTH the account
  //    AND the specific company (a validated CompanyScope). No account-only product authority, no FOR ALL
  //    policy, no UPDATE policy on the append-only areas table (and no update grant either).
  await sql`
    create policy provisioning_steps_select on public.provisioning_steps for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy provisioning_steps_insert on public.provisioning_steps for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy provisioning_steps_update on public.provisioning_steps for update
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy company_workspace_areas_select on public.company_workspace_areas for select
      using (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy company_workspace_areas_insert on public.company_workspace_areas for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of [
    ['provisioning_steps', 'provisioning_steps_select'],
    ['provisioning_steps', 'provisioning_steps_insert'],
    ['provisioning_steps', 'provisioning_steps_update'],
    ['company_workspace_areas', 'company_workspace_areas_select'],
    ['company_workspace_areas', 'company_workspace_areas_insert'],
  ] as const) {
    await sql`drop policy if exists ${sql.ref(p[1])} on public.${sql.ref(p[0])}`.execute(db);
  }
  await sql`revoke all on public.provisioning_steps from ${APP_ROLE}`.execute(db);
  await sql`revoke all on public.company_workspace_areas from ${APP_ROLE}`.execute(db);
  await db.schema.dropTable('provisioning_steps').ifExists().execute();
  await db.schema.dropTable('company_workspace_areas').ifExists().execute();
}
