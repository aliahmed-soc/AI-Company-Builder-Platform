// @acbp/core — platform-administrative access use case (ACBP-P1-013; CDR-019; SECURITY §3). API-only.
//
// The admin surface is a SEPARATE platform-operator authority: tenant owner/viewer roles, account ownership,
// and Clerk claims NEVER grant it (the `admin:tenant_read` authz-matrix entry has an EMPTY allow-list — this
// gate is a fresh database-backed `platform_admins` self-check on every request, not a role branch). The one
// operation is a reason-captured, audited company-overview read:
//
//   1. STRICT reason validation FIRST (verbatim, ≥1 non-ws char, ≤512 code points, no NUL) — before any
//      database access; "admin action without reason impossible";
//   2. the purpose-specific database primitive runs the whole protocol in one restricted transaction
//      (actor GUC → fresh active-admin self-check → target GUCs → relationship-verified read →
//      `admin.tenant_read` audit into the TARGET tenant's trail → commit; audit failure returns nothing);
//   3. every denial cause (not an admin, revoked, unknown account, unknown company, mismatched pair) collapses
//      to ONE coarse `forbidden` — no existence oracle.
//
// NO impersonation, structurally: the audit actor is the ADMIN's own internal id with actor_type='admin'; no
// session/token is minted; no tenant-member identity is assumed; no membership row is created; ordinary
// company use cases are never invoked from this path. There is no AdminCapability value exported anywhere —
// admin standing exists only as the in-transaction verification inside the database primitive.
import { executeAdminCompanyRead, type DatabaseClient } from '@acbp/database';
import { validateAdminReason, adminTenantRead, ADMIN_READ_SCOPE, type AdminCompanyOverview } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface AdminReadParams {
  /** Server-verified internal user id of the ADMINISTRATOR (from the identity boundary). NEVER a browser claim. */
  readonly userId: string;
  /** Target account id — a client-supplied SELECTOR only (relationship verified in-database). */
  readonly accountId: string;
  /** Target company id — a client-supplied SELECTOR only. */
  readonly companyId: string;
  /** The mandatory reason (validated strictly; retained verbatim). */
  readonly reason: unknown;
}

export interface AdminOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type AdminReadResult =
  | { readonly status: 'ok'; readonly company: AdminCompanyOverview }
  | { readonly status: 'invalid_reason' }
  | { readonly status: 'forbidden' };

// Selector shape gate: ids must LOOK like UUIDs before touching the database. A malformed selector would
// otherwise surface as a uuid-cast error (bounded 500) — shape-checking keeps every bad-target cause inside
// the ONE coarse `forbidden` (no malformed-vs-nonexistent distinction) and off the database entirely.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The single P1-013 admin operation: a reason-captured, audited read of one company's registry overview.
 * Returns ONLY the four approved fields — never accountId, actor ids, admin-standing details, profile/member
 * data, or audit/activity data.
 */
export async function adminReadCompanyOverview(client: DatabaseClient, params: AdminReadParams, options: AdminOpOptions = {}): Promise<AdminReadResult> {
  // 1) Reason gate FIRST — before the admin lookup, before any database read.
  const validated = validateAdminReason(params.reason);
  if (!validated.ok) return { status: 'invalid_reason' };
  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  const accountId = typeof params.accountId === 'string' ? params.accountId.trim() : '';
  const companyId = typeof params.companyId === 'string' ? params.companyId.trim() : '';
  if (!UUID_SHAPE.test(userId) || !UUID_SHAPE.test(accountId) || !UUID_SHAPE.test(companyId)) return { status: 'forbidden' };

  // 2) The one-transaction protocol (gate → target scope → read → audit → commit) in the database primitive.
  const result = await executeAdminCompanyRead(
    client,
    { adminUserId: userId, accountId, companyId },
    (row) => adminTenantRead({ companyId: row.id, reason: validated.reason, scope: ADMIN_READ_SCOPE }),
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  // 3) ONE coarse denial for every non-success cause (no existence/standing oracle). Non-PII structured log only.
  if (result.outcome !== 'ok') {
    options.logger?.warn('admin.access_denied', { metadata: { actorId: userId, accountId, companyId } });
    return { status: 'forbidden' };
  }
  options.logger?.info('admin.tenant_read', { metadata: { actorId: userId, accountId, companyId } });
  return {
    status: 'ok',
    company: {
      companyId: result.company.id,
      status: result.company.status,
      creationMode: result.company.creation_mode,
      createdAt: result.company.created_at.toISOString(),
    },
  };
}
