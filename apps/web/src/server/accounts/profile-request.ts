// ACBP-P1-003 — authenticated account-profile request use cases (apps/web).
//
// Orchestrates the ADR-022 flow for the profile surface: resolve the SERVER-VERIFIED internal user
// (via the P1-001 boundary → P1-002 mapping), idempotently ensure the personal account exists on first
// sign-in, then read/update the profile. The acting user is ALWAYS the server-verified session's user;
// no account id, email, or role from the request body/headers can target another account. Email is
// never modified here (Clerk-authoritative). All domain access goes through @acbp/core.
import { resolveInternalUserForRequest, type ResolveInternalUserDeps } from '../identity/resolve-internal-user.js';
import type { RequestLimitOutcome } from '@acbp/core';
import { isPlatformError, type PublicErrorEnvelope } from '@acbp/contracts';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import type { AccountProfileView, ProfileUpdateInput, ProvisionResult } from '@acbp/core';

/** Bounded, leakage-free outcome of a profile request. */
export type ProfileRequestResult =
  | { readonly status: 'ok'; readonly profile: AccountProfileView }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 section 8's request ceiling refused this call (ACBP-P7-013; CDR-082; NFR-010). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'validation_error'; readonly error: PublicErrorEnvelope };

/** The account operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface AccountOps {
  /** CDR-008 section 8's per-ACCOUNT ceiling (ACBP-P7-013; CDR-082). Required — see CompanyRuntime for why. */
  checkRequestLimit(scopeKind: 'session' | 'account', scopeKey: string): Promise<RequestLimitOutcome>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  getAccountProfile(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<AccountProfileView | undefined>;
  updateAccountProfile(userId: string, input: ProfileUpdateInput, options?: { correlationId?: string; logger?: Logger }): Promise<AccountProfileView | undefined>;
}

export interface ProfileRequestDeps {
  /** Inject the identity boundary in tests; production uses the real Clerk server helpers. */
  readonly identity?: ResolveInternalUserDeps;
  /** Inject account operations in tests; production lazily loads the composed @acbp/core runtime. */
  readonly accounts?: AccountOps;
}

type ActiveUser = { readonly kind: 'active'; readonly userId: string };
type EarlyResult = { readonly kind: 'result'; readonly result: ProfileRequestResult };

/** Resolve to the active internal user id, or an early (non-ok) result mapped to a safe status. */
async function resolveActiveUser(deps: ProfileRequestDeps): Promise<ActiveUser | EarlyResult> {
  const resolution = await resolveInternalUserForRequest(deps.identity ?? {});
  switch (resolution.status) {
    case 'unauthenticated':
      return { kind: 'result', result: { status: 'unauthenticated' } };
    case 'email_unverified':
      return { kind: 'result', result: { status: 'email_unverified' } };
    case 'rate_limited':
      return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: resolution.retryAfterSeconds } };
    case 'session_unavailable':
    case 'unavailable':
      return { kind: 'result', result: { status: 'unavailable' } };
    case 'deleted':
      return { kind: 'result', result: { status: 'forbidden' } };
    case 'not_found':
      return { kind: 'result', result: { status: 'not_found' } };
    case 'active':
      return { kind: 'active', userId: resolution.userId };
  }
}

async function accountOps(deps: ProfileRequestDeps): Promise<AccountOps> {
  if (deps.accounts !== undefined) return deps.accounts;
  const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
  return getClerkIdentityRuntime();
}

function accountsLogger(): Logger {
  return createLogger({ component: 'accounts', context: createRootContext() });
}

/** Resolve the request's owner, ensure their account exists, and return their profile view. */
export async function getAccountProfileForRequest(deps: ProfileRequestDeps = {}): Promise<ProfileRequestResult> {
  const resolved = await resolveActiveUser(deps);
  if (resolved.kind === 'result') return resolved.result;

  const ops = await accountOps(deps);
  const logger = accountsLogger();
  const provision = await ops.ensurePersonalAccount(resolved.userId, { logger });
  const limit = await ops.checkRequestLimit('account', provision.accountId);
  if (limit.kind === 'throttled') return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  if (limit.kind === 'unavailable') return { status: 'unavailable' };
  const profile = await ops.getAccountProfile(resolved.userId, { logger });
  if (profile === undefined) return { status: 'not_found' };
  return { status: 'ok', profile };
}

/** Resolve the request's owner, ensure their account exists, apply the edit, and return the new view. */
export async function updateAccountProfileForRequest(input: ProfileUpdateInput, deps: ProfileRequestDeps = {}): Promise<ProfileRequestResult> {
  const resolved = await resolveActiveUser(deps);
  if (resolved.kind === 'result') return resolved.result;

  const ops = await accountOps(deps);
  const logger = accountsLogger();
  const provision = await ops.ensurePersonalAccount(resolved.userId, { logger });
  const limit = await ops.checkRequestLimit('account', provision.accountId);
  if (limit.kind === 'throttled') return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  if (limit.kind === 'unavailable') return { status: 'unavailable' };
  try {
    const profile = await ops.updateAccountProfile(resolved.userId, input, { logger });
    if (profile === undefined) return { status: 'not_found' };
    return { status: 'ok', profile };
  } catch (error) {
    // A validation PlatformError becomes a safe 400 envelope; anything else propagates to the route (500).
    if (isPlatformError(error) && error.category === 'validation') {
      return { status: 'validation_error', error: error.toPublic() };
    }
    throw error;
  }
}
