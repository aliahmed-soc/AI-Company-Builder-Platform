// ACBP-P0-018 — COMPILE-TIME proof of the acceptance criterion "repo without tenant context does
// not compile" (BACKLOG.csv; DATA-ARCHITECTURE §2 invariant 2). It uses expect-error directives
// (below); the typecheck gate FAILS if any expected error stops occurring. It runs no runtime
// assertions and is not a *.test.ts (Vitest ignores it).
import { TenantRepository, withTenantTransaction } from './index.js';
import type { DatabaseClient, TenantContext, TenantScope } from './index.js';

class ProbeRepo extends TenantRepository {
  companyId(): string {
    return this.tenant.companyId;
  }
}

// VALID: a repository is constructed from a TenantScope obtained via withTenantTransaction, which
// requires a TenantContext and applies the RLS session settings first.
export async function valid(client: DatabaseClient, tenant: TenantContext): Promise<void> {
  await withTenantTransaction(client, tenant, (scope: TenantScope) => Promise.resolve(new ProbeRepo(scope).companyId()));
}

// INVALID: none of these compile — tenant context cannot be omitted or forged.
export function invalid(client: DatabaseClient, tenant: TenantContext): void {
  // @ts-expect-error missing tenant scope: a repository cannot be constructed without tenant context
  const r1 = new ProbeRepo();
  // @ts-expect-error the raw client is not a TenantScope — tenant context is mandatory
  const r2 = new ProbeRepo(client);
  // @ts-expect-error a plain object cannot satisfy the branded TenantScope — context cannot be forged
  const r3 = new ProbeRepo({ tenant, db: {} });
  void r1;
  void r2;
  void r3;
}
