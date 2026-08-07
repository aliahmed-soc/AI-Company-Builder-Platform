// ACBP-P1-013 — authenticated platform-admin request use case (apps/web; CDR-019).
//
// Resolves the SERVER-VERIFIED session identity → internal user, then calls the ONE narrow admin operation in
// @acbp/core. The caller's tenant/account is NEVER resolved or consulted here — admin standing comes solely
// from the fresh in-transaction platform_admins self-check inside the domain; accountId + companyId are
// client-supplied SELECTORS relationship-verified in-database. Unlike the tenant surfaces, an unmapped
// internal user collapses into the SAME coarse `forbidden` as every other denial (no admin-surface oracle
// about user mapping, admin standing, or target existence). No ensurePersonalAccount call: the admin path
// must not provision or touch any tenant state for the caller.
import { resolveVerifiedIdentity, type VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import type { AdminCompanyOverview } from '@acbp/contracts';
import type { AdminReadParams, AdminReadResult, AdminOpOptions, InternalUserReconciliation } from '@acbp/core';

export type AdminRequestResult =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 section 8's request ceiling refused this call (ACBP-P7-013; CDR-082; NFR-010). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'unavailable' }
  | { readonly status: 'invalid_reason' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'ok'; readonly company: AdminCompanyOverview };

/** The operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface AdminRuntime {
  resolveInternalUser(providerUserId: string): Promise<InternalUserReconciliation>;
  adminReadCompanyOverview(params: AdminReadParams, options?: AdminOpOptions): Promise<AdminReadResult>;
}

export interface AdminRequestDeps {
  readonly identity?: VerifiedIdentityDeps;
  readonly runtime?: AdminRuntime;
}

function adminLogger(): Logger {
  return createLogger({ component: 'admin', context: createRootContext() });
}

async function runtimeOf(deps: AdminRequestDeps): Promise<AdminRuntime> {
  if (deps.runtime !== undefined) return deps.runtime;
  const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
  return getClerkIdentityRuntime();
}

/**
 * The single P1-013 admin request: a reason-captured, audited read of one company's registry overview.
 * `reason` is passed VERBATIM into the domain (the route already validated it; the domain revalidates —
 * defence in depth). The reason NEVER appears in any log line or error produced here.
 */
export async function readCompanyOverviewForRequest(target: { readonly accountId: string; readonly companyId: string }, reason: unknown, deps: AdminRequestDeps = {}): Promise<AdminRequestResult> {
  const runtime = await runtimeOf(deps);
  const identity = await resolveVerifiedIdentity(deps.identity);
  if (identity.status === 'unauthenticated') return { status: 'unauthenticated' };
  if (identity.status === 'email_unverified') return { status: 'email_unverified' };
  if (identity.status === 'rate_limited') return { status: 'rate_limited', retryAfterSeconds: identity.retryAfterSeconds };
  if (identity.status === 'unavailable') return { status: 'unavailable' };

  const resolution = await runtime.resolveInternalUser(identity.identity.providerUserId);
  if (resolution.status === 'unavailable') return { status: 'unavailable' };
  if (resolution.status !== 'active') {
    // deleted OR unmapped user → the SAME coarse denial as a non-admin (no mapping oracle on this surface).
    return { status: 'forbidden' };
  }

  const r = await runtime.adminReadCompanyOverview({ userId: resolution.userId, accountId: target.accountId, companyId: target.companyId, reason }, { logger: adminLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'ok', company: r.company };
    case 'invalid_reason':
      return { status: 'invalid_reason' };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}
