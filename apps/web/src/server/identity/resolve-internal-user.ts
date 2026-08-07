// ACBP-P1-002 Slice 3 — server-only authenticated read-through boundary (apps/web).
//
// The use case future authenticated routes call AFTER P1-001 has verified the Clerk session. The
// provider user id comes ONLY from the server-verified identity (resolveVerifiedIdentity); the provider
// instance id comes from configuration inside the runtime. No browser header, cookie, or session claim
// (user id, org, role, permission, email) can influence the lookup or the created mapping. This does
// NOT change /auth-check and does NOT expose the internal user id through it.
import { resolveVerifiedIdentity, type VerifiedIdentityDeps } from '../auth/verified-identity.js';
import type { InternalUserReconciliation } from '@acbp/core';

/**
 * Non-authenticated request states plus the resolve-or-reconcile outcome for an authenticated one. The
 * session-boundary failure is `session_unavailable` so it never collides with the reconciliation's own
 * `unavailable` (which carries a sanitized provider error).
 */
export type InternalUserForRequest =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 section 8's request ceiling refused this call (ACBP-P7-013; CDR-082; NFR-010). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'session_unavailable' }
  | InternalUserReconciliation;

export interface ResolveInternalUserDeps {
  /** Inject the P1-001 identity boundary in tests; production uses the real Clerk server helpers. */
  readonly identity?: VerifiedIdentityDeps;
  /** Inject the reconciliation in tests; production lazily loads the composed Clerk runtime. */
  readonly resolve?: (providerUserId: string) => Promise<InternalUserReconciliation>;
}

export async function resolveInternalUserForRequest(deps: ResolveInternalUserDeps = {}): Promise<InternalUserForRequest> {
  const identity = await resolveVerifiedIdentity(deps.identity);
  if (identity.status === 'unauthenticated') return { status: 'unauthenticated' };
  if (identity.status === 'email_unverified') return { status: 'email_unverified' };
  if (identity.status === 'rate_limited') return { status: 'rate_limited', retryAfterSeconds: identity.retryAfterSeconds };
  if (identity.status === 'unavailable') return { status: 'session_unavailable' };

  // The ONLY input to the lookup is the server-verified provider user id — never a request header.
  const resolve =
    deps.resolve ??
    (async (providerUserId: string): Promise<InternalUserReconciliation> => {
      const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
      return getClerkIdentityRuntime().resolveInternalUser(providerUserId);
    });
  return resolve(identity.identity.providerUserId);
}
