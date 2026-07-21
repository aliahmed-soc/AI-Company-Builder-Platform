// ACBP-P1-006 — row-level security layer (CDR-013; ADR-007 second isolation layer).
//
// Enables + FORCES RLS on the three account-owned tables and creates the restricted application role that
// normal traffic uses. Policies are keyed to the transaction-local `app.current_account` GUC (with an
// `app.current_actor` self-branch on memberships), compared on TEXT so a missing/empty/malformed value
// yields NULL → no row visible / WITH CHECK fails, with no uuid-cast exception (fail-closed).
//
// Command coverage for the RESTRICTED role (the owner/migration role and superusers bypass; the three
// SECURITY DEFINER bootstrap functions in migration 0006 handle the pre-context operations that have no
// restricted-role policy — first-sign-in account+profile+owner-membership creation, pre-context own-
// membership resolution, and pending-invite acceptance):
//   accounts          : SELECT, UPDATE            (INSERT/DELETE denied — creation is bootstrap-only; no delete yet)
//   account_profiles  : SELECT, UPDATE            (INSERT denied — created at provisioning; no delete yet)
//   memberships       : SELECT, INSERT, UPDATE    (INSERT=invite, UPDATE=revoke under account scope; DELETE denied)
//
// The migration grants BYPASSRLS to NO ONE. The app role is NOLOGIN here (no password in code); deploy/tests
// grant LOGIN + a secret password out-of-band. PostgreSQL transactional DDL rolls the whole batch back on
// failure (no partial apply).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** Restricted application role name (an object identifier, not a secret). */
const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) Restricted application role — created idempotently, NOLOGIN (password granted out-of-band). It owns
  //    nothing, cannot bypass RLS, cannot create roles/dbs, and does not inherit other roles' privileges.
  await sql`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'acbp_app') then
        create role acbp_app nologin nosuperuser nobypassrls nocreatedb nocreaterole noreplication noinherit;
      end if;
    end
    $$;
  `.execute(db);

  // 2) Least-privilege grants. Global identity tables (users, identity_webhook_receipts) carry no RLS.
  await sql`grant usage on schema public to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert, update, delete on public.users, public.identity_webhook_receipts to ${APP_ROLE}`.execute(db);
  await sql`grant select, update on public.accounts to ${APP_ROLE}`.execute(db);
  await sql`grant select, update on public.account_profiles to ${APP_ROLE}`.execute(db);
  await sql`grant select, insert, update on public.memberships to ${APP_ROLE}`.execute(db);

  // 3) Enable + FORCE RLS so policies apply even to the table owner (only BYPASSRLS/superusers bypass).
  for (const t of ['accounts', 'account_profiles', 'memberships'] as const) {
    await sql`alter table public.${sql.ref(t)} enable row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} force row level security`.execute(db);
  }

  // 4) Policies. Fail-closed text comparison against the transaction-local GUCs.
  //    accounts: a caller sees/updates only its own account row; id/ownership cannot change (WITH CHECK
  //    re-asserts the row still matches). No INSERT/DELETE policy → denied for the restricted role.
  await sql`
    create policy accounts_select on public.accounts for select
      using (id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
  await sql`
    create policy accounts_update on public.accounts for update
      using (id::text = nullif(current_setting('app.current_account', true), ''))
      with check (id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);

  //    account_profiles: 1:1 with the account; scoped by account_id. No INSERT/DELETE policy → denied.
  await sql`
    create policy account_profiles_select on public.account_profiles for select
      using (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
  await sql`
    create policy account_profiles_update on public.account_profiles for update
      using (account_id::text = nullif(current_setting('app.current_account', true), ''))
      with check (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);

  //    memberships: account-scoped list/manage OR self-read (a member sees their own row via current_actor).
  //    INSERT=invite and UPDATE=revoke run under the owner's account scope; both re-assert account_id on
  //    WITH CHECK so a row cannot be created for, or moved to, another account. No DELETE policy → denied.
  await sql`
    create policy memberships_select on public.memberships for select
      using (
        account_id::text = nullif(current_setting('app.current_account', true), '')
        or member_user_id::text = nullif(current_setting('app.current_actor', true), '')
      )
  `.execute(db);
  await sql`
    create policy memberships_insert on public.memberships for insert
      with check (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
  await sql`
    create policy memberships_update on public.memberships for update
      using (account_id::text = nullif(current_setting('app.current_account', true), ''))
      with check (account_id::text = nullif(current_setting('app.current_account', true), ''))
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const p of [
    ['accounts', 'accounts_select'],
    ['accounts', 'accounts_update'],
    ['account_profiles', 'account_profiles_select'],
    ['account_profiles', 'account_profiles_update'],
    ['memberships', 'memberships_select'],
    ['memberships', 'memberships_insert'],
    ['memberships', 'memberships_update'],
  ] as const) {
    await sql`drop policy if exists ${sql.ref(p[1])} on public.${sql.ref(p[0])}`.execute(db);
  }
  for (const t of ['accounts', 'account_profiles', 'memberships'] as const) {
    await sql`alter table public.${sql.ref(t)} no force row level security`.execute(db);
    await sql`alter table public.${sql.ref(t)} disable row level security`.execute(db);
  }
  // Revoke grants, then drop the role (revoke first so DROP ROLE is not blocked by dependent privileges).
  await sql`revoke all on public.users, public.identity_webhook_receipts, public.accounts, public.account_profiles, public.memberships from ${APP_ROLE}`.execute(db);
  await sql`revoke usage on schema public from ${APP_ROLE}`.execute(db);
  await sql`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'acbp_app') then
        drop role acbp_app;
      end if;
    end
    $$;
  `.execute(db);
}
