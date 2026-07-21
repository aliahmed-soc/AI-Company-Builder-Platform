// @acbp/core — membership-backed account-context resolver (ACBP-P1-005; CDR-012).
//
// Provider-neutral. Turns a SERVER-VERIFIED internal user id + a REQUESTED account id into a validated
// AccountContext, or a deny. The requested account id is a REQUEST ONLY — authority comes solely from the
// caller's ACTIVE internal membership row (CDR-011), never from the request, a header/cookie, or a Clerk
// org/role claim. Deny-by-default; invited / revoked / missing / inactive / cross-account all collapse to
// one coarse reason (no existence/state oracle). Revocation takes effect on the next resolution (the query
// filters status='active'). Deterministic under multiple memberships: resolution is keyed to the explicit
// requested account. Denials emit an interim `tenant.context_denied` structured event with non-PII ids
// only (durable audit store is ACBP-P1-008). No global mutable state / AsyncLocalStorage — context is
// explicit at the call boundary.
import { MembershipRepository, type DatabaseClient } from '@acbp/database';
import { resolvedAccountContext, deniedAccountContext, type AccountAccessDenialReason, type AccountContextResolution } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface ResolveAccountContextParams {
  /** Server-verified internal user id (from the P1-001/P1-002 identity boundary). NEVER a browser claim. */
  readonly userId: string;
  /** The account the caller wants to act in. A REQUEST only — validated against an active membership. */
  readonly requestedAccountId: string;
}

export interface ResolveAccountContextOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

/** Narrow persistence seam so the resolver is unit-testable without a database. */
export interface AccountMembershipStore {
  /** True IFF the user has an ACTIVE membership in the account (invited / revoked / none → false). */
  hasActiveMembership(accountId: string, userId: string): Promise<boolean>;
}

function denyAndAudit(
  reason: AccountAccessDenialReason,
  accountId: string,
  userId: string,
  options: ResolveAccountContextOptions,
): AccountContextResolution {
  // Non-PII: opaque internal ids + coarse reason only — never an email, token, or Clerk identifier.
  // Correlation is carried by the logger's bound context (ADR-017), not passed as a metadata field.
  options.logger?.warn('tenant.context_denied', {
    metadata: { reason, accountId, actorId: userId },
  });
  return deniedAccountContext(reason);
}

/**
 * Resolve account context from an active membership (store-based; unit-testable). Deny-by-default:
 * a blank account or user id denies with `account_not_specified` WITHOUT consulting the store (no
 * existence signal); otherwise the ACTIVE membership is the sole authority.
 */
export async function resolveAccountContextWithStore(
  store: AccountMembershipStore,
  params: ResolveAccountContextParams,
  options: ResolveAccountContextOptions = {},
): Promise<AccountContextResolution> {
  const userId = typeof params.userId === 'string' ? params.userId.trim() : '';
  const accountId = typeof params.requestedAccountId === 'string' ? params.requestedAccountId.trim() : '';

  if (accountId === '' || userId === '') {
    return denyAndAudit('account_not_specified', accountId, userId, options);
  }

  const active = await store.hasActiveMembership(accountId, userId);
  if (!active) {
    return denyAndAudit('membership_not_active', accountId, userId, options);
  }
  return resolvedAccountContext({ accountId, actorId: userId });
}

/** Live store backed by the P1-004 MembershipRepository (active-only lookup on the server-verified user). */
export function liveAccountMembershipStore(repo: MembershipRepository): AccountMembershipStore {
  return {
    async hasActiveMembership(accountId, userId) {
      return (await repo.findActiveByAccountAndUser(accountId, userId)) !== undefined;
    },
  };
}

/**
 * Resolve account context using the live database client. A read (no transaction): the membership row is
 * the authority; the branded AccountScope is minted only AFTER this resolution succeeds (see runInAccountScope).
 */
export function resolveAccountContext(
  client: DatabaseClient,
  params: ResolveAccountContextParams,
  options: ResolveAccountContextOptions = {},
): Promise<AccountContextResolution> {
  return resolveAccountContextWithStore(liveAccountMembershipStore(new MembershipRepository(client.kysely)), params, options);
}
