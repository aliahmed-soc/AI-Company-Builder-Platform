// @acbp/database — company repositories (ACBP-P1-010; CDR-015).
//
// Operate on the company-owned tables (`companies`, `company_profiles`, `company_memberships`). Like the other
// repositories they take a plain executor (Kysely or a transaction) and rely on the caller to run them under
// the correct RLS scope: `companies` INSERT under an AccountScope (account-keyed policy), everything else under
// a CompanyScope (dual-keyed). Kysely parameterized queries only; conflict handling is scoped to the exact
// partial-unique index. No raw SQL interpolation.
import { sql, type Kysely } from 'kysely';
import type {
  DatabaseSchema,
  CompanyRow,
  NewCompany,
  CompanyProfileRow,
  NewCompanyProfile,
  CompanyMembershipRow,
  NewCompanyMembership,
} from './schema.js';

export type CompanyExecutor = Kysely<DatabaseSchema>;

export class CompanyRepository {
  readonly #db: CompanyExecutor;
  constructor(db: CompanyExecutor) {
    this.#db = db;
  }

  /** Insert a company (run under an AccountScope; the account-keyed RLS policy binds account_id). Returns the
   *  authoritative inserted row (server-generated id + server-selected initial status). */
  insert(values: NewCompany): Promise<CompanyRow> {
    return this.#db.insertInto('companies').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** A company by id (RLS confines visibility to the caller's scope). */
  findById(id: string): Promise<CompanyRow | undefined> {
    return this.#db.selectFrom('companies').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Set the lifecycle status (run under a CompanyScope; dual-keyed UPDATE policy). Returns the updated row,
   *  or undefined when the row is not visible/mutable under the current scope. Always stamps updated_at. */
  async updateStatus(id: string, status: string): Promise<CompanyRow | undefined> {
    return this.#db
      .updateTable('companies')
      .set({ status, updated_at: sql`now()` })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
  }
}

export class CompanyProfileRepository {
  readonly #db: CompanyExecutor;
  constructor(db: CompanyExecutor) {
    this.#db = db;
  }

  /** Insert a profile revision (append-only; run under a CompanyScope). Returns the inserted row. A duplicate
   *  (company_id, version) surfaces as the PK conflict — the caller retries with the next version. */
  insert(values: NewCompanyProfile): Promise<CompanyProfileRow> {
    return this.#db.insertInto('company_profiles').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** The current (highest-version) profile revision for a company, or undefined if none exists. */
  currentRevision(companyId: string): Promise<CompanyProfileRow | undefined> {
    return this.#db
      .selectFrom('company_profiles')
      .selectAll()
      .where('company_id', '=', companyId)
      .orderBy('version', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
}

export class CompanyMembershipRepository {
  readonly #db: CompanyExecutor;
  constructor(db: CompanyExecutor) {
    this.#db = db;
  }

  /** Insert a company membership (run under a CompanyScope; dual-keyed INSERT policy). Returns the row. */
  insert(values: NewCompanyMembership): Promise<CompanyMembershipRow> {
    return this.#db.insertInto('company_memberships').values(values).returningAll().executeTakeFirstOrThrow();
  }

  /** The caller's ACTIVE company membership (the company-authorization row). Readable under account scope via
   *  the self-branch (member_user_id = current_actor) so it can drive pre-context company resolution. */
  findActiveForUser(companyId: string, userId: string): Promise<CompanyMembershipRow | undefined> {
    return this.#db
      .selectFrom('company_memberships')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('member_user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
  }
}
