// @acbp/core — audit completeness registry (ACBP-P1-008; extended for company lifecycle ACBP-P1-010/CDR-015).
//
// A machine-checkable map from each APPROVED high-risk operation to the durable audit event its use case MUST
// write. This makes the completeness facts enforceable (not a source-grep):
//   - membership invitation MUST write `membership.invited`; revocation MUST write `membership.revoked`;
//   - company create/update/pause/resume MUST write `company.created`/`.updated`/`.paused`/`.resumed`.
// The unit tests assert (a) every event registered in @acbp/contracts `AUDIT_EVENTS` is produced by exactly
// one approved operation (no orphan registered events), and (b) `factoryFor` is compile-time EXHAUSTIVE over
// the operation set. The registry is PARTITIONED by domain (membership vs company) so each domain's
// real-PostgreSQL producer test provides an EXHAUSTIVE driver record over ITS operations without depending on
// the other domain — a compile-time guard asserts the partition covers exactly the whole operation set.
import {
  AUDIT_EVENTS,
  membershipInvited,
  membershipRevoked,
  companyCreated,
  companyUpdated,
  companyPaused,
  companyResumed,
  provisioningStarted,
  provisioningStepStarted,
  provisioningStepCompleted,
  provisioningStepFailed,
  provisioningRetryRequested,
  provisioningCompleted,
  type AuditEvent,
  type AuditEventName,
} from '@acbp/contracts';

/** Approved high-risk operations and the durable event each MUST produce (typed to the closed registry). */
export const AUDITED_OPERATIONS = {
  'membership.invite': 'membership.invited',
  'membership.revoke': 'membership.revoked',
  'company.create': 'company.created',
  'company.update': 'company.updated',
  'company.pause': 'company.paused',
  'company.resume': 'company.resumed',
  // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — the six audit-only provisioning transitions.
  'provisioning.start': 'provisioning.started',
  'provisioning.step_start': 'provisioning.step_started',
  'provisioning.step_complete': 'provisioning.step_completed',
  'provisioning.step_fail': 'provisioning.step_failed',
  'provisioning.retry_request': 'provisioning.retry_requested',
  'provisioning.complete': 'provisioning.completed',
} as const satisfies Record<string, AuditEventName>;

export type AuditedOperation = keyof typeof AUDITED_OPERATIONS;
export const AUDITED_OPERATION_IDS = Object.keys(AUDITED_OPERATIONS) as readonly AuditedOperation[];

// Domain partition (ACBP-P1-010/P1-012): each domain's producer test owns an exhaustive driver over its own subset.
export type MembershipAuditedOperation = 'membership.invite' | 'membership.revoke';
export type CompanyAuditedOperation = 'company.create' | 'company.update' | 'company.pause' | 'company.resume';
export type ProvisioningAuditedOperation = 'provisioning.start' | 'provisioning.step_start' | 'provisioning.step_complete' | 'provisioning.step_fail' | 'provisioning.retry_request' | 'provisioning.complete';
export const MEMBERSHIP_AUDITED_OPERATION_IDS: readonly MembershipAuditedOperation[] = ['membership.invite', 'membership.revoke'];
export const COMPANY_AUDITED_OPERATION_IDS: readonly CompanyAuditedOperation[] = ['company.create', 'company.update', 'company.pause', 'company.resume'];
export const PROVISIONING_AUDITED_OPERATION_IDS: readonly ProvisioningAuditedOperation[] = ['provisioning.start', 'provisioning.step_start', 'provisioning.step_complete', 'provisioning.step_fail', 'provisioning.retry_request', 'provisioning.complete'];

// Compile-time guard: the domain partition covers EXACTLY the full operation set (a new operation that is not
// added to one of the domain subsets is a type error here — the mutual `extends` assignment fails).
type PartitionCoversAll = [MembershipAuditedOperation | CompanyAuditedOperation | ProvisioningAuditedOperation] extends [AuditedOperation]
  ? [AuditedOperation] extends [MembershipAuditedOperation | CompanyAuditedOperation | ProvisioningAuditedOperation]
    ? true
    : never
  : never;
const _partitionExhaustive: PartitionCoversAll = true;
void _partitionExhaustive;

/**
 * Events that are registered in the audit contract but intentionally NOT produced by an approved operation
 * (would appear here if a name were reserved ahead of its producer). Empty today — every registered event is
 * produced. The SEPARATE, human-readable list of events deliberately left as interim structured logs lives in
 * CDR-014 and docs/architecture/AUDIT.md; those names are deliberately NOT in `AUDIT_EVENTS`.
 */
export const DEFERRED_REGISTERED_EVENTS: readonly AuditEventName[] = [];

/**
 * Compile-time-exhaustive factory selector: returns a builder of a CANONICAL sample event for an operation
 * (used by the completeness/producer tests). Adding a member to `AuditedOperation` without a case here is a
 * TYPE ERROR (the `never` assignment). The real use cases call the specific typed factory directly with real
 * arguments — this selector exists only to prove name/subject/outcome wiring, so its payloads are canonical.
 */
export function factoryFor(operation: AuditedOperation): (subjectId: string) => AuditEvent {
  switch (operation) {
    case 'membership.invite':
      return (subjectId) => membershipInvited({ membershipId: subjectId, role: 'viewer' });
    case 'membership.revoke':
      return (subjectId) => membershipRevoked({ membershipId: subjectId, role: 'viewer' });
    case 'company.create':
      return (subjectId) => companyCreated({ companyId: subjectId, creationMode: 'own_idea' });
    case 'company.update':
      return (subjectId) => companyUpdated({ companyId: subjectId, changedFields: ['name'] });
    case 'company.pause':
      return (subjectId) => companyPaused({ companyId: subjectId });
    case 'company.resume':
      return (subjectId) => companyResumed({ companyId: subjectId });
    case 'provisioning.start':
      return (subjectId) => provisioningStarted({ companyId: subjectId, stepCount: 6 });
    case 'provisioning.step_start':
      return (subjectId) => provisioningStepStarted({ companyId: subjectId, step: 'profile', attempt: 1 });
    case 'provisioning.step_complete':
      return (subjectId) => provisioningStepCompleted({ companyId: subjectId, step: 'profile', attempt: 1, resultCode: 'profile_verified' });
    case 'provisioning.step_fail':
      return (subjectId) => provisioningStepFailed({ companyId: subjectId, step: 'profile', attempt: 1, failureCode: 'profile_missing' });
    case 'provisioning.retry_request':
      return (subjectId) => provisioningRetryRequested({ companyId: subjectId, step: 'profile', nextAttempt: 2 });
    case 'provisioning.complete':
      return (subjectId) => provisioningCompleted({ companyId: subjectId, stepCount: 6 });
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
