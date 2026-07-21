// @acbp/database — tenant-scoped repository base (ACBP-P0-018; ADR-007 invariant 2).
//
// Compile-level tenant enforcement: the constructor requires a TenantScope, which can ONLY be
// obtained from withTenantTransaction (the branded type cannot be fabricated outside this package).
// Therefore a repository — and any query it runs — cannot be constructed without tenant context.
// See repository.type-test.ts for the compile-time proof, and the acceptance criterion
// "repo without tenant context does not compile" (BACKLOG.csv ACBP-P0-018).
import type { Transaction } from 'kysely';
import type { AccountContext } from '@acbp/contracts';
import type { DatabaseSchema } from './schema.js';
import type { TenantContext, TenantScope } from './tenant.js';
import type { AccountScope } from './account-tenant.js';

export abstract class TenantRepository {
  /** Tenant-scoped transaction executor; every query runs on this (RLS session settings applied). */
  protected readonly db: Transaction<DatabaseSchema>;
  protected readonly tenant: TenantContext;

  constructor(scope: TenantScope) {
    this.db = scope.db;
    this.tenant = scope.tenant;
  }
}

/**
 * Account-scoped repository base (ACBP-P1-005; CDR-012 #7). Named `AccountScopedRepository` (not
 * `AccountRepository`, which is the P1-003 concrete accounts-table repo). Structurally requires an
 * {@link AccountScope} — which can ONLY come from withAccountTransaction — so an account-scoped repository
 * (and any query it runs) cannot be constructed without a validated account context. The AccountScope
 * brand is distinct from TenantScope, so this constructor rejects a company `TenantScope` and vice-versa
 * (CDR-012 #8); proven in account-repository.type-test.ts.
 */
export abstract class AccountScopedRepository {
  /** Account-scoped transaction executor; every query runs on this (account session settings applied). */
  protected readonly db: Transaction<DatabaseSchema>;
  protected readonly account: AccountContext;

  constructor(scope: AccountScope) {
    this.db = scope.db;
    this.account = scope.account;
  }
}
