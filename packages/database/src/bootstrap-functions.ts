// @acbp/database — typed callers for the three SECURITY DEFINER bootstrap functions (ACBP-P1-006; CDR-013).
//
// These are the ONLY application entry points that cross the RLS boundary, and they do so only by invoking
// the owner-owned, EXECUTE-restricted functions from migration 0006. The restricted application role calls
// them; the functions run as their definer and perform exactly one hard-scoped atomic transition each.
// Parameters are always bound (no SQL injection surface); uuid inputs are cast server-side.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';

/** A Kysely executor (the restricted application client, or a transaction on it). */
export type BootstrapExecutor = Kysely<DatabaseSchema>;

/** Provision (idempotently) the server-verified user's personal account + profile + owner membership. */
export async function provisionAccountBootstrap(db: BootstrapExecutor, userId: string): Promise<{ readonly accountId: string; readonly created: boolean }> {
  const r = await sql<{ account_id: string; created: boolean }>`select account_id, created from public.acbp_provision_account(${userId}::uuid)`.execute(db);
  const row = r.rows[0];
  if (row === undefined) throw new Error('acbp_provision_account returned no row');
  return { accountId: row.account_id, created: row.created };
}

/** Resolve the caller's OWN active membership role in the requested account (null when not an active member). */
export async function resolveOwnMembershipBootstrap(db: BootstrapExecutor, userId: string, accountId: string): Promise<{ readonly role: string } | null> {
  const r = await sql<{ role: string | null }>`select public.acbp_resolve_own_membership(${userId}::uuid, ${accountId}::uuid) as role`.execute(db);
  const role = r.rows[0]?.role ?? null;
  return role === null ? null : { role };
}

/** Atomically accept a pending invite by its stored token hash for the server-verified user (null = denied). */
export async function acceptInviteBootstrap(db: BootstrapExecutor, inviteTokenHash: string, userId: string): Promise<{ readonly membershipId: string; readonly accountId: string; readonly role: string } | null> {
  const r = await sql<{ membership_id: string; account_id: string; role: string }>`select membership_id, account_id, role from public.acbp_accept_invite(${inviteTokenHash}, ${userId}::uuid)`.execute(db);
  const row = r.rows[0];
  return row === undefined ? null : { membershipId: row.membership_id, accountId: row.account_id, role: row.role };
}
