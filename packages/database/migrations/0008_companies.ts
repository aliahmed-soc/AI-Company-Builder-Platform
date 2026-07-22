// ACBP-P1-010 — company lifecycle + company tenancy (CDR-015; COMP-001/004/005/006/008; ADR-006/007;
// WORKFLOW-STATE-MACHINES §1). ADDITIVE expand migration. Introduces three account-owned, company-scoped
// tables and expands the append-only audit store with a nullable `company_id` — WITHOUT touching the
// account foundation (`accounts`/`account_profiles`/`memberships` are UNCHANGED; `memberships.company_id`
// stays a NULL hook with NO FK — company membership lives ONLY in the new `company_memberships` table).
//
// Tenancy model (CDR-015 §RLS):
//   - `app.current_account` (existing) + `app.current_company` (new) GUCs, set transaction-locally by the
//     trusted context layer. Company-owned DETAIL access requires BOTH to match (fail-closed text compare).
//   - `companies` INSERT is ACCOUNT-keyed (the company does not exist yet — created under the caller's
//     already-validated AccountScope, exactly like `memberships` INSERT). NO 4th SECURITY DEFINER function:
//     the closed allowlist stays three (CDR-013). `companies` SELECT is account-scoped (the account-owned
//     registry of its companies; also lets the bootstrap read its own INSERT ... RETURNING row); UPDATE is
//     dual-keyed (a lifecycle/rename mutation must be resolved INTO the specific company).
//   - `company_profiles` (immutable revisions: new version per change, COMP-004) and `company_memberships`
//     are company-OWNED detail: dual-keyed. `company_memberships` SELECT also has a self-branch so a member
//     can discover their own company memberships under account scope to RESOLVE into a company (no SECURITY
//     DEFINER resolver needed). Both are INSERT + SELECT only for `acbp_app` (append-only; no revoke/edit
//     path in P1-010 — a profile edit is a new row, not an UPDATE).
//   - `audit_events` gains a NULLABLE `company_id`; its two policies become DUAL-SCOPE (an account event has
//     company_id NULL and is visible under account scope; a company event carries company_id and is visible
//     only when BOTH contexts match). Append-only immutability (INSERT+SELECT grants only; no UPDATE/DELETE
//     grant or policy; CDR-014) is preserved — the column is purely additive.
//
// The migration grants BYPASSRLS to NO ONE and adds NO SECURITY DEFINER function. PostgreSQL transactional
// DDL rolls the whole batch back on failure (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret) — created in migration 0005. */
const APP_ROLE = sql.ref('acbp_app');

/** Fail-closed text compare against the transaction-local company GUC (NULL when unset/empty → no match). */
const CURRENT_COMPANY = sql`nullif(current_setting('app.current_company', true), '')`;
const CURRENT_ACCOUNT = sql`nullif(current_setting('app.current_account', true), '')`;
const CURRENT_ACTOR = sql`nullif(current_setting('app.current_actor', true), '')`;

export async function up(db: Kysely<unknown>): Promise<void> {
  // ── 1) companies (C-root) ────────────────────────────────────────────────────────────────────────────
  // Immutable identity (id, account_id, creation_mode); mutable lifecycle status. The human-facing NAME is
  // NOT here — it lives in the versioned `company_profiles` so a rename is a new profile revision (COMP-004).
  await db.schema
    .createTable('companies')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('draft'))
    .addColumn('creation_mode', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('companies_account_fk', ['account_id'], 'accounts', ['id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    // P1-010 reachable status set (deactivate/delete deferred — the CHECK stays tight to what is reachable).
    .addCheckConstraint('companies_status_valid', sql`status in ('draft', 'onboarding', 'active', 'paused')`)
    .addCheckConstraint('companies_creation_mode_valid', sql`creation_mode in ('own_idea', 'platform_suggested', 'existing_business')`)
    .execute();

  await sql`create index companies_account_idx on public.companies (account_id)`.execute(db);

  // ── 2) company_profiles (immutable revisions — COMP-004 "new version per change") ────────────────────
  // Append-only revision log. The CURRENT profile is max(version) per company. A rename / edit INSERTs
  // version+1 in-transaction; the (company_id, version) PK serializes concurrent writers (loser retries),
  // giving last-write-wins with a visible history. Revisions never cross companies (FK + PK scope).
  await db.schema
    .createTable('company_profiles')
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('version', 'integer', (col) => col.notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    // Provenance of the revision (who edited). Nullable for system-authored revisions. Users are soft-deleted.
    .addColumn('created_by_user_id', 'uuid')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint('company_profiles_pk', ['company_id', 'version'])
    .addForeignKeyConstraint('company_profiles_company_fk', ['company_id'], 'companies', ['id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    .addForeignKeyConstraint('company_profiles_author_fk', ['created_by_user_id'], 'users', ['id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addCheckConstraint('company_profiles_version_positive', sql`version >= 1`)
    .addCheckConstraint('company_profiles_name_len', sql`char_length(name) between 1 and 200`)
    .addCheckConstraint('company_profiles_description_len', sql`description is null or char_length(description) between 1 and 2000`)
    .execute();

  // ── 3) company_memberships (SEPARATE from account memberships — CDR-015 §2) ──────────────────────────
  // A company membership REQUIRES an active account membership (enforced in the application bootstrap/resolver;
  // account ownership never auto-grants company access). The creator gets an explicit active `owner` row.
  await db.schema
    .createTable('company_memberships')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('account_id', 'uuid', (col) => col.notNull())
    .addColumn('company_id', 'uuid', (col) => col.notNull())
    .addColumn('member_user_id', 'uuid', (col) => col.notNull())
    .addColumn('role', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addForeignKeyConstraint('company_memberships_account_fk', ['account_id'], 'accounts', ['id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    .addForeignKeyConstraint('company_memberships_company_fk', ['company_id'], 'companies', ['id'], (cb) =>
      cb.onDelete('cascade').onUpdate('no action'),
    )
    .addForeignKeyConstraint('company_memberships_member_user_fk', ['member_user_id'], 'users', ['id'], (cb) =>
      cb.onDelete('no action').onUpdate('no action'),
    )
    .addCheckConstraint('company_memberships_role_valid', sql`role in ('owner', 'viewer')`)
    .addCheckConstraint('company_memberships_status_valid', sql`status in ('active', 'revoked')`)
    .execute();

  // At most one ACTIVE company membership per (company, user). company_id is globally unique → implies account.
  await sql`create unique index company_memberships_active_unique on public.company_memberships (company_id, member_user_id) where status = 'active'`.execute(db);
  // Pre-context resolution helper: "which companies is this user a member of" under account scope.
  await sql`create index company_memberships_member_idx on public.company_memberships (member_user_id) where status = 'active'`.execute(db);
  await sql`create index company_memberships_company_idx on public.company_memberships (company_id)`.execute(db);

  // ── 4) audit_events expand: nullable company_id + partial lookup index (additive; immutability preserved) ─
  await sql`alter table public.audit_events add column company_id uuid`.execute(db);
  await sql`create index audit_events_company_idx on public.audit_events (company_id, occurred_at) where company_id is not null`.execute(db);

  // ── 5) Least-privilege grants ────────────────────────────────────────────────────────────────────────
  // companies: SELECT/INSERT/UPDATE (create + lifecycle/rename; no DELETE — deactivate/delete deferred).
  await sql`grant select, insert, update on public.companies to ${APP_ROLE}`.execute(db);
  // company_profiles + company_memberships: append-only for the app role (INSERT + SELECT only).
  await sql`grant select, insert on public.company_profiles to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert on public.company_memberships to ${APP_ROLE}`.execute(db);

  // ── 6) Enable + FORCE RLS (applies to the owner too; only BYPASSRLS/superusers bypass) ────────────────
  for (const t of ['companies', 'company_profiles', 'company_memberships'] as const) {
    await sql`alter table public.${sql.ref(t)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} force row level security`.execute(db);
  }

  // ── 7) Policies (all fail-closed text comparisons against the transaction-local GUCs) ─────────────────
  // companies: create is ACCOUNT-keyed (company does not exist yet); read is account-scoped (the account's
  // registry of companies; also lets the bootstrap's INSERT ... RETURNING pass the SELECT policy); mutate is
  // DUAL-keyed (must be resolved into the specific company). account_id + id are immutable (WITH CHECK).
  await sql`
    create policy companies_insert on public.companies for insert
      with check (account_id::text = ${CURRENT_ACCOUNT})
  `.execute(db);
  await sql`
    create policy companies_select on public.companies for select
      using (account_id::text = ${CURRENT_ACCOUNT})
  `.execute(db);
  await sql`
    create policy companies_update on public.companies for update
      using (account_id::text = ${CURRENT_ACCOUNT} and id::text = ${CURRENT_COMPANY})
      with check (account_id::text = ${CURRENT_ACCOUNT} and id::text = ${CURRENT_COMPANY})
  `.execute(db);

  // company_profiles: dual-keyed detail. Read/insert require the caller resolved into the company. Append-only.
  await sql`
    create policy company_profiles_insert on public.company_profiles for insert
      with check (
        company_id::text = ${CURRENT_COMPANY}
        and exists (
          select 1 from public.companies c
          where c.id = company_id and c.account_id::text = ${CURRENT_ACCOUNT}
        )
      )
  `.execute(db);
  await sql`
    create policy company_profiles_select on public.company_profiles for select
      using (
        company_id::text = ${CURRENT_COMPANY}
        and exists (
          select 1 from public.companies c
          where c.id = company_id and c.account_id::text = ${CURRENT_ACCOUNT}
        )
      )
  `.execute(db);

  // company_memberships: INSERT is dual-keyed (account + company both match). SELECT is dual-keyed OR a
  // self-branch (a member reads their OWN company membership rows under account scope to resolve which
  // company to enter — the no-SECURITY-DEFINER company resolver relies on this).
  await sql`
    create policy company_memberships_insert on public.company_memberships for insert
      with check (account_id::text = ${CURRENT_ACCOUNT} and company_id::text = ${CURRENT_COMPANY})
  `.execute(db);
  await sql`
    create policy company_memberships_select on public.company_memberships for select
      using (
        account_id::text = ${CURRENT_ACCOUNT}
        and (
          company_id::text = ${CURRENT_COMPANY}
          or member_user_id::text = ${CURRENT_ACTOR}
        )
      )
  `.execute(db);

  // ── 8) audit_events → DUAL-SCOPE (account event: company_id NULL, account match; company event: company_id
  //      set, BOTH match). ALTER-in-place keeps the append-only grants/immutability untouched.
  await sql`
    alter policy audit_events_insert on public.audit_events
      with check (
        account_id::text = ${CURRENT_ACCOUNT}
        and (company_id is null or company_id::text = ${CURRENT_COMPANY})
      )
  `.execute(db);
  await sql`
    alter policy audit_events_select on public.audit_events
      using (
        account_id::text = ${CURRENT_ACCOUNT}
        and (company_id is null or company_id::text = ${CURRENT_COMPANY})
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restore audit_events to the account-only P1-008 policies (before dropping the column they reference).
  await sql`
    alter policy audit_events_insert on public.audit_events
      with check (account_id::text = ${CURRENT_ACCOUNT})
  `.execute(db);
  await sql`
    alter policy audit_events_select on public.audit_events
      using (account_id::text = ${CURRENT_ACCOUNT})
  `.execute(db);
  await sql`drop index if exists public.audit_events_company_idx`.execute(db);
  await sql`alter table public.audit_events drop column if exists company_id`.execute(db);

  // Drop company policies.
  for (const p of [
    ['company_memberships', 'company_memberships_insert'],
    ['company_memberships', 'company_memberships_select'],
    ['company_profiles', 'company_profiles_insert'],
    ['company_profiles', 'company_profiles_select'],
    ['companies', 'companies_insert'],
    ['companies', 'companies_select'],
    ['companies', 'companies_update'],
  ] as const) {
    await sql`drop policy if exists ${sql.ref(p[1])} on public.${sql.ref(p[0])}`.execute(db);
  }

  // Revoke grants before dropping (so no dependent privilege blocks the drop).
  await sql`revoke all on public.company_memberships from ${APP_ROLE}`.execute(db);
  await sql`revoke all on public.company_profiles from ${APP_ROLE}`.execute(db);
  await sql`revoke all on public.companies from ${APP_ROLE}`.execute(db);

  // Drop children (FK) before the parent `companies`.
  await db.schema.dropTable('company_memberships').ifExists().execute();
  await db.schema.dropTable('company_profiles').ifExists().execute();
  await db.schema.dropTable('companies').ifExists().execute();
}
