// @acbp/core — audit completeness registry (ACBP-P1-008; CDR-014 Option A).
//
// A machine-checkable map from each APPROVED high-risk operation to the durable audit event its use case MUST
// write. This makes the P1-008 completeness facts enforceable (not a source-grep):
//   - membership invitation MUST write `membership.invited`;
//   - membership revocation MUST write `membership.revoked`.
// The unit tests assert (a) every event registered in @acbp/contracts `AUDIT_EVENTS` is produced by exactly
// one approved operation (no orphan registered events), and (b) `factoryFor` is compile-time EXHAUSTIVE over
// the operation set (adding an operation without a factory fails to compile). The real-PostgreSQL producer
// tests then prove each operation actually writes its event in-transaction — so a migrated use case that
// loses its durable write fails CI.
import { AUDIT_EVENTS, membershipInvited, membershipRevoked, type AuditEvent, type AuditEventName } from '@acbp/contracts';

/** Approved high-risk operations and the durable event each MUST produce (typed to the closed registry). */
export const AUDITED_OPERATIONS = {
  'membership.invite': 'membership.invited',
  'membership.revoke': 'membership.revoked',
} as const satisfies Record<string, AuditEventName>;

export type AuditedOperation = keyof typeof AUDITED_OPERATIONS;
export const AUDITED_OPERATION_IDS = Object.keys(AUDITED_OPERATIONS) as readonly AuditedOperation[];

/**
 * Events that are registered in the audit contract but intentionally NOT produced by P1-008 (would appear
 * here if a name were reserved ahead of its producer). Empty today — every registered event is produced.
 * The SEPARATE, human-readable list of events deliberately left as interim structured logs (account.created,
 * authz.denied, tenant.context_denied, membership.accepted, account.profile_updated, webhook.*, reconcile.*)
 * lives in CDR-014 and docs/architecture/AUDIT.md; those names are deliberately NOT in `AUDIT_EVENTS`.
 */
export const DEFERRED_REGISTERED_EVENTS: readonly AuditEventName[] = [];

/**
 * Compile-time-exhaustive factory selector for an approved operation. Adding a member to `AuditedOperation`
 * without a case here is a TYPE ERROR (the `never` assignment), so a new approved high-risk operation cannot
 * be registered without wiring its event factory.
 */
export function factoryFor(operation: AuditedOperation): (subjectId: string, role: 'owner' | 'viewer') => AuditEvent {
  switch (operation) {
    case 'membership.invite':
      return (subjectId, role) => membershipInvited({ membershipId: subjectId, role });
    case 'membership.revoke':
      return (subjectId, role) => membershipRevoked({ membershipId: subjectId, role });
    default: {
      const exhaustive: never = operation;
      throw new Error(`No audit factory registered for operation: ${String(exhaustive)}`);
    }
  }
}

/** The set of event names produced by approved operations (for the no-orphan completeness assertion). */
export function producedEventNames(): ReadonlySet<AuditEventName> {
  return new Set(Object.values(AUDITED_OPERATIONS));
}

/** All names registered in the audit contract. */
export function registeredEventNames(): readonly AuditEventName[] {
  return Object.keys(AUDIT_EVENTS) as AuditEventName[];
}
