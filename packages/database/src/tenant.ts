// @acbp/database — tenant context + compile-level tenant scoping (ACBP-P0-018; ADR-007).
//
// DATA-ARCHITECTURE §2 invariant 2: "the repository layer requires tenant context as a construction
// parameter — queries without it do not compile/execute". We enforce this structurally:
//
//   1. Tenant-owned queries run only against a `TenantScope`.
//   2. A `TenantScope` carries a BRANDED symbol that is module-private, so no code outside this
//      package can fabricate one — the only way to obtain it is `withTenantTransaction`, which
//      requires a `TenantContext` and applies the per-connection RLS session settings first.
//   3. `TenantRepository` takes a `TenantScope` in its constructor, so a repository constructed
//      without tenant context does not type-check (proven in repository.type-test.ts).
//
// This is the app-layer half of the two-layer isolation model; the database RLS policies (keyed to
// the session settings applied here) are the second, independent layer, added with the first
// tenant-owned table by its own ticket. Tenant isolation is NOT complete until that exists.
import type { Transaction } from 'kysely';
import type { DatabaseSchema } from './schema.js';

/**
 * Tenant context for a scoped operation. Derived from verified session membership at the composition
 * root — NEVER accepted directly from untrusted client input (ADR-007; invariant 2). Identifiers are
 * opaque and treated as sensitive operational metadata in logs (ADR-017).
 */
export interface TenantContext {
  readonly accountId: string;
  readonly companyId: string;
  readonly actorId?: string;
}

// Module-private brand: external packages cannot construct a value of this type, so a TenantScope
// can only originate from withTenantTransaction() inside this package.
declare const tenantScopeBrand: unique symbol;

/**
 * A transaction that has had its per-connection tenant session settings applied. Tenant-owned
 * repositories operate only through this. Obtainable exclusively via {@link withTenantTransaction}.
 */
export interface TenantScope {
  readonly [tenantScopeBrand]: true;
  readonly tenant: TenantContext;
  readonly db: Transaction<DatabaseSchema>;
}

/** Internal: mint a TenantScope. Not exported from the package index — foundation use only. */
export function createTenantScope(tenant: TenantContext, db: Transaction<DatabaseSchema>): TenantScope {
  return { tenant, db } as TenantScope;
}
