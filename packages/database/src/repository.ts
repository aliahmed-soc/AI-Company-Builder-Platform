// @acbp/database — tenant-scoped repository base (ACBP-P0-018; ADR-007 invariant 2).
//
// Compile-level tenant enforcement: the constructor requires a TenantScope, which can ONLY be
// obtained from withTenantTransaction (the branded type cannot be fabricated outside this package).
// Therefore a repository — and any query it runs — cannot be constructed without tenant context.
// See repository.type-test.ts for the compile-time proof, and the acceptance criterion
// "repo without tenant context does not compile" (BACKLOG.csv ACBP-P0-018).
import type { Transaction } from 'kysely';
import type { DatabaseSchema } from './schema.js';
import type { TenantContext, TenantScope } from './tenant.js';

export abstract class TenantRepository {
  /** Tenant-scoped transaction executor; every query runs on this (RLS session settings applied). */
  protected readonly db: Transaction<DatabaseSchema>;
  protected readonly tenant: TenantContext;

  constructor(scope: TenantScope) {
    this.db = scope.db;
    this.tenant = scope.tenant;
  }
}
