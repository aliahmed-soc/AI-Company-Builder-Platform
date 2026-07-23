// @acbp/database — company portfolio read repository (ACBP-P1-011; CDR-017).
//
// The read-side of the membership-filtered company portfolio. It runs on an ACCOUNT-scoped executor
// (`app.current_account` + `app.current_actor` set; `app.current_company` INTENTIONALLY UNSET) and enumerates
// ONLY the companies where the current actor holds an ACTIVE `company_memberships` row (CDR-017 §1/§2). The
// query STARTS FROM the actor's active memberships (the RLS self-branch is the authority) and joins `companies`
// on matching account + company — it never "lists all account companies and filters in memory". Account
// ownership grants no row by itself.
//
// This repository deliberately exposes NO name: the human-facing name lives in the versioned, dual-keyed
// `company_profiles` which is NOT readable under account scope. Names are enriched separately, per candidate,
// through fresh CompanyScope reads (ACBP-P1-011 Slice 3) — never joined here under account scope.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';

export type PortfolioExecutor = Kysely<DatabaseSchema>;

/** The EXCLUSIVE keyset-after position (last row of the previous page): exact company creation instant + id. */
export interface PortfolioKeyset {
  /** ISO-8601 UTC instant with up to microsecond precision (bound into SQL via a `::timestamptz` cast so
   *  PostgreSQL parses its own precision exactly — no JS Date/float ever touches the ordering key). */
  readonly createdAt: string;
  readonly companyId: string;
}

/**
 * A raw portfolio candidate row: the company id, its truthful lifecycle status, the CALLER's company role (from
 * their own active membership), and the exact microsecond epoch of `companies.created_at` (`int64` as text — no
 * float, no JS Date loss), from which the service builds the exact ISO the DTO/cursor use. NO name (enriched
 * later under CompanyScope) and NO account/membership internals.
 */
export interface PortfolioCandidateRow {
  readonly company_id: string;
  readonly status: string;
  readonly role: string;
  readonly created_at_us: string;
}

/**
 * Read-side of the company portfolio (ACBP-P1-011). Account-scoped, membership-filtered KEYSET pagination over
 * `companies` reached THROUGH the actor's active `company_memberships`, ordered `companies.created_at DESC,
 * companies.id DESC`. Runs on the caller's AccountScope executor, so RLS confines candidates to the current
 * account AND (via the memberships self-branch, company GUC unset) to the actor's own active memberships.
 * Reads only.
 */
export class PortfolioRepository {
  readonly #db: PortfolioExecutor;
  constructor(db: PortfolioExecutor) {
    this.#db = db;
  }

  /**
   * Build the enumeration query WITHOUT executing it. Exposed (in addition to the executing method below) so the
   * query-plan evidence suite can EXPLAIN and compile the EXACT production shape — no hand-maintained mirror that
   * could silently drift from what production runs (targeted review M-2).
   */
  buildListQuery(actorId: string, limit: number, opts: { after?: PortfolioKeyset } = {}) {
    let q = this.#db
      .selectFrom('company_memberships as cm')
      .innerJoin('companies as c', (join) => join.onRef('c.id', '=', 'cm.company_id').onRef('c.account_id', '=', 'cm.account_id'))
      .where('cm.member_user_id', '=', actorId)
      .where('cm.status', '=', 'active')
      .select([
        'c.id as company_id',
        'c.status as status',
        'cm.role as role',
        sql<string>`(extract(epoch from c.created_at) * 1000000)::bigint::text`.as('created_at_us'),
      ]);
    const after = opts.after;
    if (after !== undefined) {
      // Exclusive DESC keyset: strictly OLDER than the previous page's last item (created_at, then id tie-break).
      q = q.where((eb) =>
        eb.or([
          eb('c.created_at', '<', sql<Date>`${after.createdAt}::timestamptz`),
          eb.and([eb('c.created_at', '=', sql<Date>`${after.createdAt}::timestamptz`), eb('c.id', '<', after.companyId)]),
        ]),
      );
    }
    return q.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(limit);
  }

  /**
   * Fetch up to `limit` portfolio candidates for `actorId`, newest-company-first, applying the EXCLUSIVE `after`
   * keyset (rows strictly older than the previous page's last item). The caller fetches `limit + 1` to detect a
   * further page. `actorId` MUST be the AccountScope's own actor — the memberships RLS self-branch
   * (`member_user_id = app.current_actor`) is what makes these rows visible under account scope, so a mismatched
   * id would simply return nothing (fail-closed), never another user's portfolio.
   *
   * The join is on BOTH `company_id` and `account_id` so a company only contributes when it belongs to the same
   * account as the membership (defense in depth over the account-scoped `companies` SELECT policy). Active
   * status is filtered explicitly in addition to the RLS self-branch.
   */
  listActiveMembershipCompanies(actorId: string, limit: number, opts: { after?: PortfolioKeyset } = {}): Promise<PortfolioCandidateRow[]> {
    return this.buildListQuery(actorId, limit, opts).execute();
  }
}
