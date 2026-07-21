// ACBP-P1-005 — COMPILE-TIME proof of the account/company scope isolation (CDR-012 #7/#8; BACKLOG.csv
// ACBP-P1-005 "forged tenant denied" / "missing context = compile/runtime failure closed"). Uses
// expect-error directives; the typecheck gate FAILS if any expected error stops occurring. It runs no
// runtime assertions and is not a *.test.ts (Vitest ignores it).
import { TenantRepository, AccountScopedRepository, withTenantTransaction, withAccountTransaction } from './index.js';
import type { DatabaseClient, TenantContext, AccountContext, TenantScope, AccountScope } from './index.js';

class ProbeTenantRepo extends TenantRepository {
  companyId(): string {
    return this.tenant.companyId;
  }
}

class ProbeAccountRepo extends AccountScopedRepository {
  accountId(): string {
    return this.account.accountId;
  }
}

// VALID: an account repository is constructed from an AccountScope obtained via withAccountTransaction,
// which requires an AccountContext and applies the account session settings first.
export async function valid(client: DatabaseClient, account: AccountContext): Promise<void> {
  await withAccountTransaction(client, account, (scope: AccountScope) => Promise.resolve(new ProbeAccountRepo(scope).accountId()));
}

// INVALID: none of these compile — account context cannot be omitted or forged, and the two scopes are
// NOT interchangeable (CDR-012 #8: a company repo can never be built from an account-only scope).
export function invalid(client: DatabaseClient, tenant: TenantContext, account: AccountContext): void {
  // @ts-expect-error missing account scope: an account repository cannot be constructed without context
  const a1 = new ProbeAccountRepo();
  // @ts-expect-error the raw client is not an AccountScope — account context is mandatory
  const a2 = new ProbeAccountRepo(client);
  // @ts-expect-error a plain object cannot satisfy the branded AccountScope — context cannot be forged
  const a3 = new ProbeAccountRepo({ account, db: {} });
  void a1;
  void a2;
  void a3;

  // A company TenantScope is NOT assignable to an account repository.
  void withTenantTransaction(client, tenant, (tenantScope: TenantScope) =>
    // @ts-expect-error account/company scopes are brand-distinct — a TenantScope cannot build an AccountRepository
    Promise.resolve(new ProbeAccountRepo(tenantScope)),
  );

  // An account AccountScope is NOT assignable to a company repository (the load-bearing guarantee).
  void withAccountTransaction(client, account, (accountScope: AccountScope) =>
    // @ts-expect-error account/company scopes are brand-distinct — an AccountScope cannot build a TenantRepository
    Promise.resolve(new ProbeTenantRepo(accountScope)),
  );
}
