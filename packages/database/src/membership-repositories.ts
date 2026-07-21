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

  /**
   * Atomically revoke an ACTIVE membership while UPHOLDING the last-owner invariant (CDR-011): an account
   * must never be drained of its last active owner. The owner-count decision and the revoke are ONE locked
   * operation, closing the read-then-act race in which two concurrent revocations of DIFFERENT owners each
   * read "2 owners", both pass a separate guard, and both flip — leaving ZERO active owners.
   *
   * Serialization: lock this account's active-owner rows with `SELECT … FOR UPDATE` (ordered by id, so
   * competing owner revocations acquire the locks in the same order and cannot deadlock) BEFORE deciding.
   * A racing revocation of another owner blocks on that lock; when it proceeds it re-reads the now-smaller
   * owner set and correctly refuses if only one remains. MUST run inside the caller's account transaction
   * so the locks are held until commit. The conditional flip keeps the `WHERE status = 'active'` guard
   * (idempotent under concurrency: only the transaction that performs active→revoked reports 'revoked', so
   * exactly one durable `membership.revoked` audit is written — ACBP-P1-008). Returns:
   *   - `'last_owner'` the target is the sole remaining active owner → refused; nothing changed
   *   - `'revoked'`    the target was active and this call performed the active→revoked transition
   *   - `'noop'`       the row was not active (already revoked / a concurrent revoke won) → idempotent no-op
   */
  async revokeActiveMembershipPreservingLastOwner(accountId: string, id: string): Promise<'revoked' | 'noop' | 'last_owner'> {
    const activeOwners = await this.#db
      .selectFrom('memberships')
      .select('id')
      .where('account_id', '=', accountId)
      .where('role', '=', 'owner')
      .where('status', '=', 'active')
      .orderBy('id')
      .forUpdate()
      .execute();
    // Refuse only when the target itself is that sole remaining active owner (never for a viewer/non-owner).
    if (activeOwners.length <= 1 && activeOwners.some((o) => o.id === id)) return 'last_owner';
    // Conditional active→revoked flip; a lost race (row already revoked) is an idempotent no-op.
    const flipped = await this.#db
      .updateTable('memberships')
      .set({ status: 'revoked', revoked_at: sql<Date>`now()`, invite_token_hash: null, updated_at: sql`now()` })
      .where('id', '=', id)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    return flipped === undefined ? 'noop' : 'revoked';
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
