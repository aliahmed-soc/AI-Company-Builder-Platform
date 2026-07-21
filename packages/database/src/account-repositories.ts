// @acbp/database — account-root repositories (ACBP-P1-003; CDR-010).
//
// Operate on the account-root tables (accounts, account_profiles). An account is A-tenant, but the
// general tenant-context primitives (ACBP-P1-005) and row-level security (ACBP-P1-006) do not exist
// yet, so — like the identity repositories — these take a plain executor and do NOT extend
// TenantRepository. Authorization is enforced above: every caller resolves its OWN account by the
// server-derived internal user id (`created_by_user_id`), never by a client-supplied account id, so
// no cross-account access is reachable even before RLS lands. Kysely parameterized queries only.
import { sql, type Kysely } from 'kysely';
import type {
  DatabaseSchema,
  AccountRow,
  NewAccount,
  AccountProfileRow,
  NewAccountProfile,
  AccountProfileUpdate,
} from './schema.js';

/** Executor accepted by the account repositories: the base client's Kysely or a Transaction. */
export type AccountExecutor = Kysely<DatabaseSchema>;

export class AccountRepository {
  readonly #db: AccountExecutor;
  constructor(db: AccountExecutor) {
    this.#db = db;
  }

  /** Resolve the personal account owned by the given internal user id, or undefined if none exists. */
  findByOwner(createdByUserId: string): Promise<AccountRow | undefined> {
    return this.#db.selectFrom('accounts').selectAll().where('created_by_user_id', '=', createdByUserId).executeTakeFirst();
  }

  /** Look up an account by its internal id, or undefined. */
  findById(id: string): Promise<AccountRow | undefined> {
    return this.#db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Race-safe personal-account provisioning: insert the account, doing nothing ONLY on the
   * `created_by_user_id` uniqueness conflict, then always return the live row. `inserted` is true when
   * THIS call created it, false when a concurrent first-sign-in provisioner had already created it.
   * Conflict handling is scoped to the exact owner-unique constraint via ON CONFLICT DO NOTHING — NOT
   * a blanket 23505 catch, so an unrelated violation (e.g. the FK) still surfaces as a real failure.
   */
  async insertIfAbsent(values: NewAccount): Promise<{ readonly row: AccountRow; readonly inserted: boolean }> {
    const inserted = await this.#db
      .insertInto('accounts')
      .values(values)
      .onConflict((oc) => oc.column('created_by_user_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { row: inserted, inserted: true };
    const existing = await this.findByOwner(values.created_by_user_id);
    if (existing === undefined) {
      // Unreachable: the conflict proves a row exists. Fail loudly rather than fabricate one.
      throw new Error('AccountRepository.insertIfAbsent: conflict reported but no existing account row found');
    }
    return { row: existing, inserted: false };
  }
}

export class AccountProfileRepository {
  readonly #db: AccountExecutor;
  constructor(db: AccountExecutor) {
    this.#db = db;
  }

  /** Look up the 1:1 profile for an account, or undefined if none exists yet. */
  findByAccount(accountId: string): Promise<AccountProfileRow | undefined> {
    return this.#db.selectFrom('account_profiles').selectAll().where('account_id', '=', accountId).executeTakeFirst();
  }

  /**
   * Race-safe profile provisioning: insert the 1:1 profile, doing nothing ONLY on the account_id
   * primary-key conflict, then always return the live row. `inserted` distinguishes create vs
   * already-present. Scoped to the exact PK conflict — an unrelated violation still fails.
   */
  async insertIfAbsent(values: NewAccountProfile): Promise<{ readonly row: AccountProfileRow; readonly inserted: boolean }> {
    const inserted = await this.#db
      .insertInto('account_profiles')
      .values(values)
      .onConflict((oc) => oc.column('account_id').doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return { row: inserted, inserted: true };
    const existing = await this.findByAccount(values.account_id);
    if (existing === undefined) {
      throw new Error('AccountProfileRepository.insertIfAbsent: conflict reported but no existing profile row found');
    }
    return { row: existing, inserted: false };
  }

  /**
   * Apply a profile edit and return the updated row (or undefined if the account has no profile).
   * Always stamps `updated_at`; never mutates `account_id`. Email is intentionally NOT a profile
   * field — it stays Clerk-authoritative on `users` (CDR-010 #6).
   */
  async update(accountId: string, patch: AccountProfileUpdate): Promise<AccountProfileRow | undefined> {
    const { account_id: _ignored, ...rest } = patch;
    // Stamp updated_at from the DATABASE clock (now()), not the app clock. created_at is also DB-set,
    // so both timestamps share one clock and `updated_at >= created_at` holds regardless of any
    // app↔database clock skew.
    return this.#db
      .updateTable('account_profiles')
      .set({ ...rest, updated_at: sql`now()` })
      .where('account_id', '=', accountId)
      .returningAll()
      .executeTakeFirst();
  }
}
