// @acbp/database — the PURPOSE-SPECIFIC platform-admin tenant-read primitive (ACBP-P1-013; CDR-019 §5/§6).
//
// This is deliberately NOT a generic cross-tenant tool: it performs EXACTLY ONE operation — the audited
// company-overview read — and nothing else can be executed through it (no callback, no query parameter, no
// repository handle escapes). There is NO exported `runAsTenant`/`setArbitraryTenant`/cross-tenant repository/
// owner-connection helper anywhere; this function is consumed solely by @acbp/core's admin module. It runs on
// the RESTRICTED `acbp_app` connection (never the owner role, never BYPASSRLS) and relies on FORCE RLS
// remaining fully active throughout.
//
// Required sequence, all inside ONE transaction (SET LOCAL scope dies at commit/rollback — JIT per-transaction):
//   1. set `app.current_actor` from the SERVER-VERIFIED internal admin user id;
//   2. read the actor's OWN `platform_admins` row through the self-check RLS policy (fresh, never cached);
//   3. only if that row is ACTIVE: set the TARGET `app.current_account` + `app.current_company` (selectors);
//   4. fetch the company overview with the relationship verified IN-DATABASE
//      (`companies.id = companyId AND companies.account_id = accountId`) — no company-only lookup, no list,
//      no profile/membership query;
//   5. write the caller-supplied `admin.tenant_read` audit event via the ONE audit write path
//      (`writeAuditEvent`, actor stamped from the scope; `actor_type='admin'`) into the TARGET tenant's trail;
//   6. commit — the overview is returned ONLY after the audit write succeeded and the transaction committed
//      (an audit failure rolls everything back and returns nothing).
import { sql } from 'kysely';
import type { AuditEvent } from '@acbp/contracts';
import type { DatabaseClient } from './client.js';
import { withTransaction } from './transaction.js';
import { writeAuditEvent, type AuditWriteContext } from './audit-repository.js';
import { createTenantScope } from './tenant.js';
import { TENANT_SETTINGS } from './session.js';

/** The redacted raw result of the single approved read (mapped to the public DTO in @acbp/core). */
export interface AdminCompanyReadRow {
  readonly id: string;
  readonly status: string;
  readonly creation_mode: string;
  readonly created_at: Date;
}

export type AdminCompanyReadOutcome =
  | { readonly outcome: 'ok'; readonly company: AdminCompanyReadRow }
  | { readonly outcome: 'not_admin' }
  | { readonly outcome: 'no_such_target' };

/**
 * Execute the ONE approved admin read (see the module header for the full protocol). `buildAudit` receives the
 * fetched row and returns the typed `admin.tenant_read` event — constructed by the CALLER (@acbp/core) so this
 * module stays free of event semantics; it is written through {@link writeAuditEvent} on an internally-minted
 * scope whose actor is the ADMIN (the audit therefore records the real administrator, never a tenant user).
 */
export async function executeAdminCompanyRead(
  client: DatabaseClient,
  target: { readonly adminUserId: string; readonly accountId: string; readonly companyId: string },
  buildAudit: (row: AdminCompanyReadRow) => AuditEvent,
  ctx: AuditWriteContext = {},
  /**
   * TEST FAILPOINT ONLY: invoked (with NO arguments — it can reach neither the transaction nor the scope)
   * AFTER the audit write succeeded, still inside the transaction; a rejection forces the rollback path.
   * It cannot skip, replace, or observe the audit write — `writeAuditEvent` above is unconditionally the
   * one audit path. Never set in production (the composed runtime never forwards one).
   */
  failpointAfterAudit?: () => Promise<void>,
): Promise<AdminCompanyReadOutcome> {
  return withTransaction(client, async (tx) => {
    // 1) Actor context first — the self-check policy needs it; nothing else is set yet.
    await sql`select set_config(${TENANT_SETTINGS.actor}, ${target.adminUserId}, ${true})`.execute(tx.kysely);
    // 2) FRESH admin standing (self-check RLS: only the actor's own row is even visible), joined to a LIVE
    //    identity: a soft-deleted user (users.status='deleted') loses admin authority here even if their
    //    platform_admins row was never revoked — the identity boundary is not the only guard. Fail closed.
    const admin = await tx.kysely
      .selectFrom('platform_admins')
      .innerJoin('users', 'users.id', 'platform_admins.user_id')
      .select(['platform_admins.user_id', 'platform_admins.status'])
      .where('platform_admins.user_id', '=', target.adminUserId)
      .where('users.status', '=', 'active')
      .executeTakeFirst();
    if (admin === undefined || admin.status !== 'active') return { outcome: 'not_admin' };
    // 3) TARGET tenant scope — transaction-local ONLY, set strictly after the admin gate passed.
    await sql`select set_config(${TENANT_SETTINGS.account}, ${target.accountId}, ${true})`.execute(tx.kysely);
    await sql`select set_config(${TENANT_SETTINGS.company}, ${target.companyId}, ${true})`.execute(tx.kysely);
    // 4) The ONE approved read, relationship verified in-database (both selectors must agree).
    const company = await tx.kysely
      .selectFrom('companies')
      .select(['id', 'status', 'creation_mode', 'created_at'])
      .where('id', '=', target.companyId)
      .where('account_id', '=', target.accountId)
      .executeTakeFirst();
    if (company === undefined) return { outcome: 'no_such_target' };
    // 5) The admin.tenant_read audit — same transaction, TARGET-tenant-scoped, admin-actor-stamped. A failure
    //    here throws → the whole transaction rolls back → the caller receives no company data.
    const scope = createTenantScope({ accountId: target.accountId, companyId: target.companyId, actorId: target.adminUserId }, tx.kysely);
    // actorType is pinned LAST so no caller-supplied ctx value can ever re-label the admin as a tenant user.
    await writeAuditEvent(scope, buildAudit(company), { ...ctx, actorType: 'admin' });
    if (failpointAfterAudit !== undefined) await failpointAfterAudit();
    // 6) Returning resolves the transaction callback → COMMIT; only then does the caller see the row.
    return { outcome: 'ok', company };
  });
}
