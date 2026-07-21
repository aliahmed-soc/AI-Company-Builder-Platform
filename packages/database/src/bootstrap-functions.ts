// @acbp/database — typed callers for the three SECURITY DEFINER bootstrap functions (ACBP-P1-006; CDR-013).
//
// These are the ONLY application entry points that cross the RLS boundary, and they do so only by invoking
// the owner-owned, EXECUTE-restricted functions from migration 0006. The restricted application role calls
// them; the functions run as their definer and perform exactly one hard-scoped atomic transition each.
// Parameters are always bound (no SQL injection surface); uuid inputs are cast server-side.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';
import { toDatabaseError } from './errors.js';

/** A Kysely executor (the restricted application client, or a transaction on it). */
export type BootstrapExecutor = Kysely<DatabaseSchema>;

// These run outside a withTransaction boundary, so any thrown pg error is normalized to a redacted
// PlatformError (never a raw provider message) — ACBP-P1-006 review finding F4.

/** Provision (idempotently) the server-verified user's personal account + profile + owner membership. */
export async function provisionAccountBootstrap(db: BootstrapExecutor, userId: string): Promise<{ readonly accountId: string; readonly created: boolean }> {
  try {
    const r = await sql<{ o_account_id: string; o_created: boolean }>`select o_account_id, o_created from public.acbp_provision_account(${userId}::uuid)`.execute(db);
    const row = r.rows[0];
    if (row === undefined) throw new Error('acbp_provision_account returned no row');
    return { accountId: row.o_account_id, created: row.o_created };
  } catch (e) {
    throw toDatabaseError(e, { operation: 'provision_account' });
  }
}

/** Resolve the caller's OWN active membership role in the requested account (null when not an active member). */
export async function resolveOwnMembershipBootstrap(db: BootstrapExecutor, userId: string, accountId: string): Promise<{ readonly role: string } | null> {
  try {
    const r = await sql<{ role: string | null }>`select public.acbp_resolve_own_membership(${userId}::uuid, ${accountId}::uuid) as role`.execute(db);
    const role = r.rows[0]?.role ?? null;
    return role === null ? null : { role };
  } catch (e) {
    throw toDatabaseError(e, { operation: 'resolve_own_membership' });
  }
}

/**
 * Atomically accept a pending invite by its stored token hash for the server-verified user (null = denied).
 * A rare concurrent double-accept can raise the active-membership unique violation (23505) → treated as
 * `null` (the invite could not be uniquely activated; the DB stays consistent — at most one membership).
 */
export async function acceptInviteBootstrap(db: BootstrapExecutor, inviteTokenHash: string, userId: string): Promise<{ readonly membershipId: string; readonly accountId: string; readonly role: string } | null> {
  try {
    const r = await sql<{ o_membership_id: string; o_account_id: string; o_role: string }>`select o_membership_id, o_account_id, o_role from public.acbp_accept_invite(${inviteTokenHash}, ${userId}::uuid)`.execute(db);
    const row = r.rows[0];
    return row === undefined ? null : { membershipId: row.o_membership_id, accountId: row.o_account_id, role: row.o_role };
  } catch (e) {
    const err = toDatabaseError(e, { operation: 'accept_invite' });
    if (err.category === 'conflict') return null; // lost a concurrent activation race → treat as invalid/used
    throw err;
  }
}
