// @acbp/core — central authorization check (ACBP-P1-007; ADR-022; SECURITY-ARCHITECTURE §1).
//
// The single enforcement point for the INTERNAL ROLE-CHECK step of the mandatory ADR-022 flow. It wraps the
// pure @acbp/contracts `authorize` matrix with denial AUDITING (a binding acceptance criterion: "denials
// audited"). Deny-by-default is inherited from the matrix.
//
// This is a decision plus one audit side effect ONLY: it loads no data, opens no transaction, mints no
// AccountScope, selects no database connection, and consults no Clerk org/role claim. WHICH account a caller
// may touch is already decided by AccountContext (ACBP-P1-005) and enforced by row-level security
// (ACBP-P1-006); this answers only "may THIS role perform THIS action?". Callers MUST pass a `role` that was
// resolved SERVER-SIDE from the caller's ACTIVE membership row under their own scope — never a request field,
// header, cookie, or Clerk claim.
import { authorize, isAllowed, type AuthzAction, type AuthzDecision, type AuthzRole } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

/** Non-PII identifiers stamped onto a denial audit event. Both are opaque internal ids. */
export interface AuthzAuditContext {
  /** Internal account id the action targets. */
  readonly accountId: string;
  /** Server-verified internal user id of the actor. */
  readonly actorId: string;
}

export interface AuthzCheckOptions {
  readonly logger?: Logger;
}

/**
 * Decide whether `role` may perform `action`, AUDITING every denial. Returns the contract {@link AuthzDecision}
 * unchanged (deny-by-default from the matrix). On a denial, emits a warn-level `authz.denied` event carrying
 * NON-PII fields only — `{ action, reason, accountId, actorId }` — mirroring `tenant.context_denied`; never an
 * email, invite token, or Clerk identifier. An ALLOW emits nothing (avoid audit noise; the criterion is
 * "denials audited"). `role` MUST be the caller's server-resolved active-membership role (`null` = no active
 * membership → denies).
 */
export function checkAuthorization(
  role: AuthzRole | null,
  action: AuthzAction,
  audit: AuthzAuditContext,
  options: AuthzCheckOptions = {},
): AuthzDecision {
  const decision = authorize(role, action);
  if (decision.kind === 'deny') {
    options.logger?.warn('authz.denied', {
      metadata: { action, reason: decision.reason, accountId: audit.accountId, actorId: audit.actorId },
    });
  }
  return decision;
}

/** Convenience boolean: `true` iff `role` may perform `action`. Audits the denial as a side effect. */
export function isAuthorized(
  role: AuthzRole | null,
  action: AuthzAction,
  audit: AuthzAuditContext,
  options: AuthzCheckOptions = {},
): boolean {
  return isAllowed(checkAuthorization(role, action, audit, options));
}
