// ACBP-P1-006 — the exact three SECURITY DEFINER bootstrap functions (CDR-013 #4/#5; owner allowlist).
//
// These are the ONLY controlled crossings of the RLS boundary. Each runs as its owner (the migration/owner
// role, which carries BYPASSRLS in production / is the superuser in CI), so it bypasses RLS for its ONE
// exact atomic transition; the restricted `acbp_app` role can only invoke them via EXECUTE (revoked from
// PUBLIC). Each has a fixed safe `search_path = pg_catalog` (no caller-writable application schema),
// schema-qualifies every application object, uses no dynamic SQL, and returns the minimum fields. No token
// hash, invited email, or other sensitive data is ever returned. No fourth bootstrap function may be added
// without another explicit owner decision.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

const APP_ROLE = sql.ref('acbp_app');

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1) Provisioning: create ONLY the given server-verified user's personal account + profile + owner
  //    membership. Idempotent and race-safe (scoped ON CONFLICT on the exact P1-003/P1-004 constraints).
  //    The owner and role are fixed (never caller-chosen); it can never claim another user's account.
  await sql`
    create or replace function public.acbp_provision_account(p_user_id uuid)
    returns table (o_account_id uuid, o_created boolean)
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $fn$
    declare
      v_account_id uuid;
      v_created boolean := false;
    begin
      insert into public.accounts (created_by_user_id)
        values (p_user_id)
        on conflict (created_by_user_id) do nothing
        returning id into v_account_id;

      if v_account_id is null then
        select a.id into v_account_id from public.accounts a where a.created_by_user_id = p_user_id;
      else
        v_created := true;
      end if;

      insert into public.account_profiles (account_id)
        values (v_account_id)
        on conflict (account_id) do nothing;

      insert into public.memberships (account_id, member_user_id, role, status, accepted_at)
        values (v_account_id, p_user_id, 'owner', 'active', now())
        on conflict (account_id, member_user_id) where status = 'active' do nothing;

      return query select v_account_id, v_created;
    end;
    $fn$;
  `.execute(db);

  // 2) Own-membership resolution: return ONLY the caller's own ACTIVE membership role in the explicitly
  //    requested account (or NULL). Cannot list members, enumerate accounts, or read invitation data.
  //    Honours immediate revocation via the status='active' filter.
  await sql`
    create or replace function public.acbp_resolve_own_membership(p_user_id uuid, p_account_id uuid)
    returns text
    language plpgsql
    security definer
    set search_path = pg_catalog
    stable
    as $fn$
    declare
      v_role text;
    begin
      select m.role into v_role
      from public.memberships m
      where m.account_id = p_account_id
        and m.member_user_id = p_user_id
        and m.status = 'active';
      return v_role;
    end;
    $fn$;
  `.execute(db);

  // 3) Invite acceptance: one atomic invited→active transition, bound to PLATFORM-AUTHORITATIVE identity.
  //    The email is derived from public.users (the accepting user must be active with a verified primary
  //    email) — NEVER a caller parameter. It preserves the invite's account + role, consumes the token
  //    hash, and (via the WHERE guards + the active-per-(account,user) unique index) yields at most one
  //    activation under concurrency; every later/invalid attempt returns no rows (fail closed). It never
  //    returns the token hash or email.
  await sql`
    create or replace function public.acbp_accept_invite(p_invite_token_hash text, p_user_id uuid)
    returns table (o_membership_id uuid, o_account_id uuid, o_role text)
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $fn$
    declare
      v_email text;
      v_verified boolean;
      v_status text;
    begin
      select u.primary_email, u.email_verified, u.status
        into v_email, v_verified, v_status
      from public.users u
      where u.id = p_user_id;

      if v_email is null or v_verified is not true or v_status is distinct from 'active' then
        return; -- unknown/inactive/unverified user → no rows (denied)
      end if;

      return query
      update public.memberships m
         set status = 'active',
             member_user_id = p_user_id,
             invite_token_hash = null,
             accepted_at = now(),
             updated_at = now()
       where m.invite_token_hash = p_invite_token_hash
         and m.status = 'invited'
         and m.member_user_id is null
         and lower(btrim(m.invited_email)) = lower(btrim(v_email))
         -- never create a second active membership for the same (account, user)
         and not exists (
           select 1 from public.memberships m2
           where m2.account_id = m.account_id
             and m2.member_user_id = p_user_id
             and m2.status = 'active'
         )
      returning m.id, m.account_id, m.role;
    end;
    $fn$;
  `.execute(db);

  // Lock down execution: no PUBLIC execute; only the restricted application role may invoke them.
  for (const fn of [
    sql`public.acbp_provision_account(uuid)`,
    sql`public.acbp_resolve_own_membership(uuid, uuid)`,
    sql`public.acbp_accept_invite(text, uuid)`,
  ]) {
    await sql`revoke all on function ${fn} from public`.execute(db);
    await sql`grant execute on function ${fn} to ${APP_ROLE}`.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists public.acbp_accept_invite(text, uuid)`.execute(db);
  await sql`drop function if exists public.acbp_resolve_own_membership(uuid, uuid)`.execute(db);
  await sql`drop function if exists public.acbp_provision_account(uuid)`.execute(db);
}
