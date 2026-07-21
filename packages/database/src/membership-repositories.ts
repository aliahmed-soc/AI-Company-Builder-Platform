// @acbp/database — account membership repository (ACBP-P1-004; CDR-011).
//
// Operates on the account-owned `memberships` table. Like the other P1-002/P1-003 repositories it takes
// a plain executor (Kysely or a transaction) and is NOT tenant-scoped — the general tenant-context
// primitives (P1-005) and RLS (P1-006) do not exist yet; authorization is enforced above using the
// active membership's role, resolved from the SERVER-VERIFIED user id (never a Clerk claim). Kysely
// parameterized queries only. Conflict handling is scoped to the exact partial-unique indexes.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, MembershipRow, NewMembership, MembershipUpdate } from './schema.js';

export type MembershipExecutor = Kysely<DatabaseSchema>;

export class MembershipRepository {
  readonly #db: MembershipExecutor;
  constructor(db: MembershipExecutor) {
    this.#db = db;
  }

  /** All memberships of an account (any status), oldest first. */
  listByAccount(accountId: string): Promise<MembershipRow[]> {
    return this.#db.selectFrom('memberships').selectAll().where('account_id', '=', accountId).orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  }

  findById(id: string): Promise<MembershipRow | undefined> {
    return this.#db.selectFrom('memberships').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The caller's ACTIVE membership in an account (the authorization row), or undefined. */
  findActiveByAccountAndUser(accountId: string, userId: string): Promise<MembershipRow | undefined> {
    return this.#db
      .selectFrom('memberships')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('member_user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }

  /** Count of ACTIVE owner memberships in an account (used to guard against removing the last owner). */
  async countActiveOwners(accountId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('memberships')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('account_id', '=', accountId)
      .where('role', '=', 'owner')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /** A pending invite by its single-use token hash, or undefined. */
  findPendingByTokenHash(tokenHash: string): Promise<MembershipRow | undefined> {
    return this.#db.selectFrom('memberships').selectAll().where('invite_token_hash', '=', tokenHash).where('status', '=', 'invited').executeTakeFirst();
  }

  /** An outstanding invite for (account, email), or undefined. */
  findPendingByAccountAndEmail(accountId: string, invitedEmail: string): Promise<MembershipRow | undefined> {
    return this.#db.selectFrom('memberships').selectAll().where('account_id', '=', accountId).where('invited_email', '=', invitedEmail).where('status', '=', 'invited').executeTakeFirst();
  }

  /** Insert a row (pending invite or membership) and return it. */
  insert(values: NewMembership): Promise<MembershipRow> {
    return this.#db.insertInto('memberships').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /**
   * Race-safe owner-membership provisioning: insert an active owner membership, doing nothing ONLY on
   * the active-per-(account,user) partial-unique conflict, then always return the live row. Scoped to
   * that exact index predicate — an unrelated violation still surfaces as a real failure. Used by
   * account provisioning so a new account's founder is a first-class owner member.
   */
  async insertOwnerIfAbsent(accountId: string, userId: string): Promise<{ readonly row: MembershipRow; readonly inserted: boolean }> {
    const inserted = await this.#db
      .insertInto('memberships')
      .values({ account_id: accountId, member_user_id: userId, role: 'owner', status: 'active', accepted_at: sql<Date>`now()` })
      .onConflict((oc) => oc.columns(['account_id', 'member_user_id']).where('status', '=', 'active').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { row: inserted, inserted: true };
    const existing = await this.findActiveByAccountAndUser(accountId, userId);
    if (existing === undefined) {
      throw new Error('MembershipRepository.insertOwnerIfAbsent: conflict reported but no existing active membership found');
    }
    return { row: existing, inserted: false };
  }

  /**
   * Atomically revoke an ACTIVE membership. Returns true IFF this call performed the active→revoked
   * transition (guarded by `WHERE status = 'active'`); false when the row was already revoked. Safe under
   * concurrency — two racing revokes serialize on the row lock and only the one that flips `active→revoked`
   * returns true, so exactly one durable `membership.revoked` audit is written (ACBP-P1-008). Clears the
   * invite token hash and stamps revoked_at/updated_at from the DB clock.
   */
  async revokeIfActive(id: string): Promise<boolean> {
    const row = await this.#db
      .updateTable('memberships')
      .set({ status: 'revoked', revoked_at: sql<Date>`now()`, invite_token_hash: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Apply a patch and return the updated row (or undefined if the id is unknown). Always stamps updated_at. */
  async update(id: string, patch: MembershipUpdate): Promise<MembershipRow | undefined> {
    const { id: _ignored, ...rest } = patch;
    return this.#db
      .updateTable('memberships')
      .set({ ...rest, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}
