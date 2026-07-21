// @acbp/contracts — provider-neutral account-level tenant context (ACBP-P1-005; ADR-007; CDR-012).
//
// The transport- and provider-neutral currency for account-scoped work. An AccountContext carries an
// account id and (optionally) the acting internal user id — and NEVER a company id (CDR-012 #1:
// company-level tenancy is a separate primitive that must stay type-distinct). No framework, Clerk, or
// database type appears here; this file stays zero-dependency like the rest of @acbp/contracts.
import { platformError, ErrorCodes, type PublicErrorEnvelope } from '../errors.js';

/** Validated account-scoped context. `accountId` is an internal id; `actorId` is the internal user id. */
export interface AccountContext {
  readonly accountId: string;
  readonly actorId?: string;
}

/**
 * Stable, safe denial reasons for account-context resolution. Deliberately COARSE: a denial must never
 * reveal whether the account exists, whether the caller was invited, or whether a membership was revoked
 * (no existence/state oracle — CDR-012 #11). `membership_not_active` collapses missing / invited /
 * revoked / inactive / cross-account; `account_not_specified` is a pure input error with no existence
 * signal. The reason is for SERVER-SIDE audit only; any public mapping collapses to one opaque envelope.
 */
export type AccountAccessDenialReason = 'membership_not_active' | 'account_not_specified';

/** Outcome of resolving account context from active membership: an explicit resolved/denied union. */
export type AccountContextResolution =
  | { readonly kind: 'resolved'; readonly context: AccountContext }
  | { readonly kind: 'denied'; readonly reason: AccountAccessDenialReason };

export function resolvedAccountContext(context: AccountContext): AccountContextResolution {
  return { kind: 'resolved', context };
}

export function deniedAccountContext(reason: AccountAccessDenialReason): AccountContextResolution {
  return { kind: 'denied', reason };
}

export function isResolvedAccountContext(
  r: AccountContextResolution,
): r is { readonly kind: 'resolved'; readonly context: AccountContext } {
  return r.kind === 'resolved';
}

export function isDeniedAccountContext(
  r: AccountContextResolution,
): r is { readonly kind: 'denied'; readonly reason: AccountAccessDenialReason } {
  return r.kind === 'denied';
}

/**
 * Safe, client-facing envelope for a denied account-context resolution. ALWAYS the same opaque authz
 * envelope regardless of the (private) reason, so a denial never becomes an existence/state oracle
 * (CDR-012 #11). The reason stays server-side (audit only) and is never mapped into public output.
 */
export function accountAccessDeniedEnvelope(correlationId?: string): PublicErrorEnvelope {
  return platformError('authz', {
    code: ErrorCodes.AUTHORIZATION_DENIED,
    ...(correlationId !== undefined ? { correlationId } : {}),
  }).toPublic();
}
