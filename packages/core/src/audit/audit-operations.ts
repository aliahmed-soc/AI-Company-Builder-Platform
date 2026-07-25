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
  adminTenantRead,
  ADMIN_READ_SCOPE,
  interviewStarted,
  memoryItemCreated,
  memoryItemSuperseded,
  memoryItemDeleted,
  understandingGenerated,
  understandingItemReviewed,
  understandingConfirmed,
  understandingCorrected,
  contextConflictFlagged,
  taskCreated,
  strategyGenerated,
  strategySelected,
  decisionRecorded,
  roadmapGenerated,
  roadmapEdited,
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
  // Platform-administrative access (ACBP-P1-013; CDR-019 §7) — the one admin operation.
  'admin.tenant_read': 'admin.tenant_read',
  // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — the one durable session event.
  'interview.start': 'interview.started',
  // Typed memory (ACBP-P2-006; CDR-024 §4) — a memory item creation.
  'memory.create': 'memory.item_created',
  // Memory browser (ACBP-P2-010; CDR-025 §4) — a memory item was superseded by a corrected version.
  'memory.supersede': 'memory.item_superseded',
  // Memory browser (ACBP-P2-010; CDR-025 §0) — a memory item was soft-deleted.
  'memory.delete': 'memory.item_deleted',
  // Understanding generation (ACBP-P2-008; CDR-029 §6) — a classified understanding document version was generated.
  'understanding.generate': 'understanding.generated',
  // Understanding review + confirmation (ACBP-P2-009; CDR-030 §3/§4/§6) — three lifecycle operations.
  'understanding.review-decision': 'understanding.item_reviewed',
  'understanding.confirm': 'understanding.confirmed',
  'understanding.correct': 'understanding.corrected',
  // Context assembly (ACBP-P2-007; CDR-032 §3) — a MEM-004 conflict was flagged during assembly.
  'context.flag-conflict': 'context.conflict_flagged',
  // Task model (ACBP-P4-002; CDR-033 §4) — a task appeared on the board (draft→planned).
  'task.plan': 'task.created',
  // Strategy option generation (ACBP-P3-001; CDR-034 §4) — options were generated from a confirmed understanding.
  'strategy.generate': 'strategy.generated',
  // Owner strategy decision (ACBP-P3-004; CDR-037 §4) — select/edit/combine/reject.
  'strategy.select': 'strategy.selected',
  // Immutable decision record (ACBP-P3-005; CDR-038 §4; STRAT-006) — the durable, audit-grade record of a decision.
  'decision.record': 'decision.recorded',
  // Planning (ACBP-P4-001; CDR-039 §5; ROAD-001/002) - a roadmap version was planned, or authored by an owner edit.
  'roadmap.generate': 'roadmap.generated',
  'roadmap.edit': 'roadmap.edited',
} as const satisfies Record<string, AuditEventName>;

export type AuditedOperation = keyof typeof AUDITED_OPERATIONS;
export const AUDITED_OPERATION_IDS = Object.keys(AUDITED_OPERATIONS) as readonly AuditedOperation[];

// Domain partition (ACBP-P1-010/P1-012): each domain's producer test owns an exhaustive driver over its own subset.
export type MembershipAuditedOperation = 'membership.invite' | 'membership.revoke';
export type CompanyAuditedOperation = 'company.create' | 'company.update' | 'company.pause' | 'company.resume';
export type ProvisioningAuditedOperation = 'provisioning.start' | 'provisioning.step_start' | 'provisioning.step_complete' | 'provisioning.step_fail' | 'provisioning.retry_request' | 'provisioning.complete';
export type AdminAuditedOperation = 'admin.tenant_read';
export type InterviewAuditedOperation = 'interview.start';
export type MemoryAuditedOperation = 'memory.create' | 'memory.supersede' | 'memory.delete';
export type UnderstandingAuditedOperation = 'understanding.generate' | 'understanding.review-decision' | 'understanding.confirm' | 'understanding.correct';
export type ContextAuditedOperation = 'context.flag-conflict';
export type TaskAuditedOperation = 'task.plan';
export type StrategyAuditedOperation = 'strategy.generate' | 'strategy.select';
export type DecisionAuditedOperation = 'decision.record';
export type PlanningAuditedOperation = 'roadmap.generate' | 'roadmap.edit';
export const MEMBERSHIP_AUDITED_OPERATION_IDS: readonly MembershipAuditedOperation[] = ['membership.invite', 'membership.revoke'];
export const COMPANY_AUDITED_OPERATION_IDS: readonly CompanyAuditedOperation[] = ['company.create', 'company.update', 'company.pause', 'company.resume'];
export const PROVISIONING_AUDITED_OPERATION_IDS: readonly ProvisioningAuditedOperation[] = ['provisioning.start', 'provisioning.step_start', 'provisioning.step_complete', 'provisioning.step_fail', 'provisioning.retry_request', 'provisioning.complete'];
export const ADMIN_AUDITED_OPERATION_IDS: readonly AdminAuditedOperation[] = ['admin.tenant_read'];
export const INTERVIEW_AUDITED_OPERATION_IDS: readonly InterviewAuditedOperation[] = ['interview.start'];
export const MEMORY_AUDITED_OPERATION_IDS: readonly MemoryAuditedOperation[] = ['memory.create', 'memory.supersede', 'memory.delete'];
export const UNDERSTANDING_AUDITED_OPERATION_IDS: readonly UnderstandingAuditedOperation[] = ['understanding.generate', 'understanding.review-decision', 'understanding.confirm', 'understanding.correct'];
export const CONTEXT_AUDITED_OPERATION_IDS: readonly ContextAuditedOperation[] = ['context.flag-conflict'];
export const TASK_AUDITED_OPERATION_IDS: readonly TaskAuditedOperation[] = ['task.plan'];
export const STRATEGY_AUDITED_OPERATION_IDS: readonly StrategyAuditedOperation[] = ['strategy.generate', 'strategy.select'];
export const DECISION_AUDITED_OPERATION_IDS: readonly DecisionAuditedOperation[] = ['decision.record'];
export const PLANNING_AUDITED_OPERATION_IDS: readonly PlanningAuditedOperation[] = ['roadmap.generate', 'roadmap.edit'];

// Compile-time guard: the domain partition covers EXACTLY the full operation set (a new operation that is not
// added to one of the domain subsets is a type error here — the mutual `extends` assignment fails).
type PartitionDomains = MembershipAuditedOperation | CompanyAuditedOperation | ProvisioningAuditedOperation | AdminAuditedOperation | InterviewAuditedOperation | MemoryAuditedOperation | UnderstandingAuditedOperation | ContextAuditedOperation | TaskAuditedOperation | StrategyAuditedOperation | DecisionAuditedOperation | PlanningAuditedOperation;
type PartitionCoversAll = [PartitionDomains] extends [AuditedOperation]
  ? [AuditedOperation] extends [PartitionDomains]
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
    case 'admin.tenant_read':
      return (subjectId) => adminTenantRead({ companyId: subjectId, reason: 'canonical sample reason', scope: ADMIN_READ_SCOPE });
    case 'interview.start':
      return (subjectId) => interviewStarted({ sessionId: subjectId });
    case 'memory.create':
      return (subjectId) => memoryItemCreated({ memoryItemId: subjectId, itemType: 'user_fact', sourceType: 'interview_answer' });
    case 'memory.supersede':
      return (subjectId) => memoryItemSuperseded({ supersededItemId: subjectId, newItemType: 'user_fact', newSourceType: 'user_edit' });
    case 'memory.delete':
      return (subjectId) => memoryItemDeleted({ memoryItemId: subjectId, itemType: 'user_fact', sourceType: 'user_edit' });
    case 'understanding.generate':
      return (subjectId) => understandingGenerated({ documentId: subjectId, version: 1, status: 'complete', itemCount: 0 });
    case 'understanding.review-decision':
      return (subjectId) => understandingItemReviewed({ itemId: subjectId, decision: 'approved', version: 1 });
    case 'understanding.confirm':
      return (subjectId) => understandingConfirmed({ documentId: subjectId, version: 1 });
    case 'understanding.correct':
      return (subjectId) => understandingCorrected({ documentId: subjectId, version: 1, correctionRef: 'sample_ref', dependentsFlagged: 0 });
    case 'context.flag-conflict':
      return (subjectId) => contextConflictFlagged({ itemId: subjectId, confirmedCount: 1, assumptionCount: 1 });
    case 'task.plan':
      return (subjectId) => taskCreated({ taskId: subjectId, hasMilestone: false });
    case 'strategy.generate':
      return (subjectId) => strategyGenerated({ generationId: subjectId, understandingVersion: 1, optionCount: 3, similarityCheckResult: 'pending' });
    case 'strategy.select':
      return (subjectId) => strategySelected({ selectionId: subjectId, mode: 'select', phaseScope: null });
    case 'decision.record':
      return (subjectId) => decisionRecorded({ decisionId: subjectId, understandingVersion: 1, optionsConsideredCount: 3, mode: 'select' });
    case 'roadmap.generate':
      return (subjectId) => roadmapGenerated({ roadmapId: subjectId, roadmapVersion: 1, goalCount: 1, milestoneCount: 1, status: 'complete', modelFlaggedPartial: false });
    case 'roadmap.edit':
      return (subjectId) => roadmapEdited({ roadmapId: subjectId, roadmapVersion: 2, supersedesVersion: 1, affectedTaskCount: 0, hasReason: true });
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
