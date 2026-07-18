// @acbp/database — Kysely database schema type (ACBP-P0-018).
//
// INTENTIONALLY EMPTY of product-domain tables. This ticket establishes the access + migration
// FOUNDATION only; account/user/company/task/approval/usage/audit/etc. tables are introduced by
// their own later tickets (DATA-ARCHITECTURE.md), each with tenant ownership + RLS. The only object
// the foundation creates is a non-domain migration probe (see migrations/0001_platform_init.ts),
// which is infrastructure, not part of the application query surface, so it is deliberately not
// typed here.
//
// Kysely is generic over this interface; keeping it empty means no query can reference a
// product-domain table until that table's migration + type are added by the owning ticket.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- foundation has no domain tables yet (P0-018 non-scope)
export interface DatabaseSchema {}
