// @acbp/database — account-level tenancy primitive (ACBP-P1-005; ADR-007; CDR-012).
//
// This is a SEPARATE, type-distinct sibling of the company-level primitive in tenant.ts. It exists so
// account-owned work (accounts, memberships, account profiles) can run under a validated ACCOUNT context
// WITHOUT a company — companies do not exist until ACBP-P1-010 (CDR-012). Structural enforcement mirrors
// the company primitive:
//
//   1. An `AccountScope` carries a BRANDED symbol that is module-private, so no code outside this package
//      can fabricate one — the only way to obtain it is `withAccountTransaction`, which requires an
//      `AccountContext` and applies the per-connection account session settings first.
//   2. `AccountScopedRepository` takes an `AccountScope` in its constructor, so an account-scoped
//      repository built without account context does not type-check (proven in account-repository.type-test.ts).
//   3. The `accountScopeBrand` is DISTINCT from the company `tenantScopeBrand`, so an `AccountScope` is
//      NOT assignable to a `TenantScope` and vice-versa (CDR-012 #8) — a company repository can never be
//      constructed from an account-only scope, and no alias collapses the two.
//
// The neutral `AccountContext` shape lives in @acbp/contracts (the provider-neutral currency); this module
// only adds the database-bound branded scope. `AccountContext` never carries a company id (CDR-012 #1).
import type { Transaction } from 'kysely';
import type { AccountContext } from '@acbp/contracts';
import type { DatabaseSchema } from './schema.js';

export type { AccountContext };

// Module-private brand: external packages cannot construct a value of this type, so an AccountScope can
// only originate from withAccountTransaction() inside this package. Distinct from tenantScopeBrand.
declare const accountScopeBrand: unique symbol;

/**
 * A transaction that has had its per-connection ACCOUNT session settings applied (app.current_account +
 * app.current_actor; NEVER app.current_company). Account-owned repositories operate only through this.
 * Obtainable exclusively via {@link withAccountTransaction}.
 */
export interface AccountScope {
  readonly [accountScopeBrand]: true;
  readonly account: AccountContext;
  readonly db: Transaction<DatabaseSchema>;
}

/** Internal: mint an AccountScope. Not exported from the package index — foundation use only. */
export function createAccountScope(account: AccountContext, db: Transaction<DatabaseSchema>): AccountScope {
  return { account, db } as AccountScope;
}
