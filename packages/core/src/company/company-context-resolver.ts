// @acbp/core — company-context resolver (ACBP-P1-010; CDR-015). Provider-neutral.
//
// Turns a SERVER-VERIFIED internal user id + a REQUESTED account id + a REQUESTED company id into a validated
// CompanyScope, or a deny. Both requested ids are SELECTORS only — authority comes solely from the caller's
// ACTIVE account membership (to obtain an AccountScope) AND their ACTIVE company membership row (loaded fresh,
// never cached; never a Clerk claim/header/cookie). A company membership requires an active account membership
// (structural: no AccountScope → no resolution), and account ownership NEVER auto-grants company access
// (CDR-015 §2). Deny-by-default: blank ids, no account membership, no company membership all collapse to a
// coarse reason (no existence/state oracle). Denials emit an interim `company.context_denied` structured event
// with non-PII ids only (durable company audit is written by the use cases). No global/ambient context.
import { CompanyMembershipRepository, elevateToCompanyScope, type DatabaseClient, type TenantScope } from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { isMemberRole, type MemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

/** Coarse company-access denial reasons (deliberately low-resolution — no existence/state oracle). */
export type CompanyAccessDenialReason = 'company_not_specified' | 'company_access_denied';

export interface ResolveCompanyContextParams {
  /** Server-verified internal user id (from the identity boundary). NEVER a browser claim. */
  readonly userId: string;
  /** The account the caller wants to act in. A REQUEST only — validated via an active account membership. */
  readonly requestedAccountId: string;
  /** The company the caller wants to act in. A REQUEST only — validated via an active company membership. */
  readonly requestedCompanyId: string;
}

export interface ResolveCompanyContextOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

/** Outcome of {@link runInCompanyScope}: the callback's value + the caller's company role, or a deny. */
export type CompanyScopeRun<T> =
  | { readonly kind: 'ran'; readonly value: T; readonly role: MemberRole }
  | { readonly kind: 'denied'; readonly reason: CompanyAccessDenialReason };

function denyAudit(reason: CompanyAccessDenialReason, params: ResolveCompanyContextParams, options: ResolveCompanyContextOptions): void {
  // Non-PII: opaque internal ids + coarse reason only — never an email, token, or Clerk identifier.
  options.logger?.warn('company.context_denied', {
    metadata: { reason, accountId: params.requestedAccountId, companyId: params.requestedCompanyId, actorId: params.userId },
  });
}

/**
 * Trusted composition (CDR-015 §Bootstrap/RLS): resolve account context → mint the AccountScope → verify the
 * caller's ACTIVE company membership under that scope (the self-branch read) → ONLY then elevate to a branded
 * {@link TenantScope} (CompanyScope) and run `fn` under it, passing the caller's company role. On any denial the
 * callback NEVER runs and no company scope is minted (fail-closed). The elevation happens INSIDE the same
 * account transaction; company-owned repositories take the scope `fn` receives.
 */
export async function runInCompanyScope<T>(
  client: DatabaseClient,
  params: ResolveCompanyContextParams,
  fn: (scope: TenantScope, role: MemberRole) => Promise<T>,
  options: ResolveCompanyContextOptions = {},
): Promise<CompanyScopeRun<T>> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  const accountId = typeof params.requestedAccountId === 'string' ? params.requestedAccountId.trim() : '';
  const companyId = typeof params.requestedCompanyId === 'string' ? params.requestedCompanyId.trim() : '';

  if (userId === '' || accountId === '' || companyId === '') {
    denyAudit('company_not_specified', params, options);
    return { kind: 'denied', reason: 'company_not_specified' };
  }

  const opts = options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
  const run = await runInAccountScope(
    client,
    { userId, requestedAccountId: accountId },
    async (accountScope) => {
      // Active company membership is the sole company authority; loaded fresh under the account self-branch.
      const membership = await new CompanyMembershipRepository(accountScope.db).findActiveForUser(companyId, userId);
      if (membership === undefined || !isMemberRole(membership.role)) {
        denyAudit('company_access_denied', params, options);
        return { ok: false as const };
      }
      const companyScope = await elevateToCompanyScope(accountScope, companyId);
      const value = await fn(companyScope, membership.role);
      return { ok: true as const, value, role: membership.role };
    },
    opts,
  );

  if (run.kind === 'denied') {
    // The account-level denial reason is not surfaced (coarse company deny — no oracle across the boundary).
    denyAudit('company_access_denied', params, options);
    return { kind: 'denied', reason: 'company_access_denied' };
  }
  const inner = run.value;
  if (!inner.ok) return { kind: 'denied', reason: 'company_access_denied' };
  return { kind: 'ran', value: inner.value, role: inner.role };
}
