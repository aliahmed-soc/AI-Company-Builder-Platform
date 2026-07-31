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
  taskRepeated,
  taskDeleted,
  artifactRevisionRequested,
  strategyGenerated,
  strategySelected,
  decisionRecorded,
  roadmapGenerated,
  roadmapEdited,
  planningRunRecorded,
  jobEnqueued,
  jobDeadLettered,
  taskStarted,
  taskFailed,
  taskCancelled,
  policyEvaluated,
  policyBlocked,
  policyUnavailable,
  policyChanged,
  approvalRequested,
  approvalApproved,
  approvalRejected,
  approvalRevoked,
  approvalRevokeFailed,
  approvalConsumed,
  emergencyStopActivated,
  emergencyStopCleared,
  emergencyStopWorkReviewed,
  toolCallRequested,
  toolCallCompleted,
  workerStateChanged,
  creditReserved,
  creditSettled,
  workerRunStarted,
  workerRunFinished,
  taskCompleted,
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
  // Task detail controls (ACBP-P4-005; CDR-043 §4-G10; TASK-008 "Controls audited").
  'task.repeat': 'task.repeated',
  'task.delete': 'task.deleted',
  // Revision requests (ACBP-P5-012; CDR-064; TASK-005 lineage / J-13) - the owner asked for a revision, and the
  // TASK created to do it is named in the payload (J-13). Registered WITH its producing operation: an event in the registry
  // that no approved operation emits is an orphan, which is exactly what this partition exists to prevent.
  'artifact.request-revision': 'artifact.revision_requested',
  // Strategy option generation (ACBP-P3-001; CDR-034 §4) — options were generated from a confirmed understanding.
  'strategy.generate': 'strategy.generated',
  // Owner strategy decision (ACBP-P3-004; CDR-037 §4) — select/edit/combine/reject.
  'strategy.select': 'strategy.selected',
  // Immutable decision record (ACBP-P3-005; CDR-038 §4; STRAT-006) — the durable, audit-grade record of a decision.
  'decision.record': 'decision.recorded',
  // Planning (ACBP-P4-001; CDR-039 §5; ROAD-001/002) - a roadmap version was planned, or authored by an owner edit.
  'roadmap.generate': 'roadmap.generated',
  'roadmap.edit': 'roadmap.edited',
  // Planning transparency (ACBP-P4-006; CDR-041 §3-G6; PLAN-004) - a planning run + its linked input snapshot.
  'planning.run_record': 'planning.run_recorded',
  // Durable jobs (ACBP-P5-001a; CDR-049 §4; ADR-008 "Run trail audited") — a job entered the store.
  'job.enqueue': 'job.enqueued',
  // Dead-letter (ACBP-P5-001c; CDR-052; NFR-007) - the retry cap was reached and the job stopped.
  'job.dead_letter': 'job.dead_lettered',
  // Task runs (ACBP-P5-002; CDR-053) - the run-driven task transitions the coordinator writes.
  'run.start': 'task.started',
  'run.fail': 'task.failed',
  'run.cancel': 'task.cancelled',
  // Tool dispatch (ACBP-P5-003b; CDR-054; TOOL-002 "100% of tool calls have records"). `tool.dispatch` covers the
  // REFUSALS as well — a call turned away at the chokepoint is still a call the platform decided about, and
  // TOOL-001 requires the attempt to be audited.
  // Policy engine (ACBP-P6-001c; CDR-066 §6-G18). Three producing operations, four events: an evaluation that
  // DENIES emits `policy.blocked` in addition to `policy.evaluated`, because canon routes the two to different
  // consumers — the record, and the Decision Room + activity feed.
  'policy.evaluate': 'policy.evaluated',
  'policy.evaluate.denied': 'policy.blocked',
  // The engine could not answer at all: no active policy, or a rule set that is not readable. Separate from
  // `policy.blocked` because "the rules said no" and "there were no rules to ask" are different problems (§6-G16).
  'policy.evaluate.unavailable': 'policy.unavailable',
  'policy.initialize': 'policy.changed',
  // Emergency stop (ACBP-P6-007; CDR-072; ADMIN-001/002). THREE operations for three events, and the split is the
  // same one the approval and policy pairs make: activating a halt, lifting it, and deciding the fate of one held
  // item are three things a reader counts separately. `work.review` covers BOTH confirm and discard — a discard is
  // a decision an operator made, not an absence of one.
  'emergency_stop.activate': 'emergency_stop.activated',
  'emergency_stop.clear': 'emergency_stop.cleared',
  'emergency_stop.work.review': 'emergency_stop.work_reviewed',
  // Approvals (ACBP-P6-003c; CDR-068). THREE operations for three events. `approval.decide` and
  // `approval.decide.rejected` are separate operations rather than one carrying an outcome, mirroring the
  // `policy.evaluate` / `policy.evaluate.denied` split: the audited operation IS the authorization, so granting it
  // and withholding it are two different things a reader counts separately.
  //
  // The other three decision paths (`schedule`, `batch_approve`, and `edit_then_approve`) map onto
  // `approval.decide` too — they are approvals carrying their path in metadata, not new events, because canon's
  // catalogue names three approval events and inventing siblings puts names in the trail nothing is registered for.
  'approval.request': 'approval.requested',
  'approval.decide': 'approval.approved',
  'approval.decide.rejected': 'approval.rejected',
  // ACBP-P6-004. Revoking is its OWN operation, not a decision path: deciding answers a question that was asked,
  // revoking withdraws an answer already given. Consuming is the moment an authorization becomes an action, which is
  // the transition a reader most often needs to locate.
  'approval.revoke': 'approval.revoked',
  // The compensating alert when a revocation loses to a consumption (CDR-069 §1-G6).
  'approval.revoke_failed': 'approval.revoke_failed',
  'approval.consume': 'approval.consumed',
  'tool.dispatch': 'tool.call_requested',
  'tool.complete': 'tool.call_completed',
  'tool.fail': 'tool.call_failed',
  // Worker pause/disable per company (ACBP-P5-004; CDR-056; WORK-006).
  'worker.set_state': 'worker.state_changed',
  // Worker RUNS (ACBP-P5-005; CDR-057). Three operations, three events: a run begins, a run ends well, a run fails.
  'worker.run_start': 'worker.started',
  'worker.run_complete': 'worker.completed',
  'worker.run_fail': 'worker.failed',
  // The credit ledger (ACBP-P5-014; CDR-058). Reserve and settle - the two durable money facts.
  'credit.reserve': 'credit.reserved',
  'credit.settle': 'credit.settled',
  // Task completion (ACBP-P5-011; TASK-005). Distinct from `run.*`: a succeeded RUN is not a completed TASK, and this
  // is the operation that asserts the second fact once an artifact exists to justify it.
  'task.complete': 'task.completed',
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
export type TaskAuditedOperation = 'task.plan' | 'task.repeat' | 'task.delete' | 'task.complete';
export type StrategyAuditedOperation = 'strategy.generate' | 'strategy.select';
export type DecisionAuditedOperation = 'decision.record';
export type PlanningAuditedOperation = 'roadmap.generate' | 'roadmap.edit' | 'planning.run_record';
export type JobAuditedOperation = 'job.enqueue' | 'job.dead_letter';
export type RunAuditedOperation = 'run.start' | 'run.fail' | 'run.cancel';
export type ToolAuditedOperation = 'tool.dispatch' | 'tool.complete' | 'tool.fail';
export type WorkerAuditedOperation = 'worker.set_state' | 'worker.run_start' | 'worker.run_complete' | 'worker.run_fail';
export type BillingAuditedOperation = 'credit.reserve' | 'credit.settle';
// Artifacts (ACBP-P5-012; CDR-064). Its OWN domain rather than folded into TASK: the subject is an artifact revision,
// not a task, and BILLING was separated from RUN for the same reason.
export type ArtifactAuditedOperation = 'artifact.request-revision';
// Policy engine (ACBP-P6-001c; CDR-066 §6). Its own domain: policy decides ABOUT execution and is deliberately not
// folded into RUN or TOOL, for the same reason BILLING was separated - a different authority, a different reader.
export type PolicyAuditedOperation = 'policy.evaluate' | 'policy.evaluate.denied' | 'policy.evaluate.unavailable' | 'policy.initialize';
// Approvals (ACBP-P6-003c; CDR-068). Its OWN domain, not folded into POLICY: policy decides whether a human is
// needed, and this is the human deciding. Different authority, different reader — the same reasoning that separated
// POLICY from RUN and BILLING from RUN.
export type ApprovalAuditedOperation = 'approval.request' | 'approval.decide' | 'approval.decide.rejected' | 'approval.revoke' | 'approval.revoke_failed' | 'approval.consume';
// Emergency stop (ACBP-P6-007; CDR-072). Its OWN domain, and deliberately not folded into POLICY or APPROVAL:
// policy decides whether an action is allowed and approval is a human permitting one, whereas a STOP is a human
// halting everything in a scope regardless of either. Different authority, different reader — the same reasoning
// that separated APPROVAL from POLICY, and POLICY from RUN.
export type EmergencyStopAuditedOperation = 'emergency_stop.activate' | 'emergency_stop.clear' | 'emergency_stop.work.review';
export const MEMBERSHIP_AUDITED_OPERATION_IDS: readonly MembershipAuditedOperation[] = ['membership.invite', 'membership.revoke'];
export const COMPANY_AUDITED_OPERATION_IDS: readonly CompanyAuditedOperation[] = ['company.create', 'company.update', 'company.pause', 'company.resume'];
export const PROVISIONING_AUDITED_OPERATION_IDS: readonly ProvisioningAuditedOperation[] = ['provisioning.start', 'provisioning.step_start', 'provisioning.step_complete', 'provisioning.step_fail', 'provisioning.retry_request', 'provisioning.complete'];
export const ADMIN_AUDITED_OPERATION_IDS: readonly AdminAuditedOperation[] = ['admin.tenant_read'];
export const INTERVIEW_AUDITED_OPERATION_IDS: readonly InterviewAuditedOperation[] = ['interview.start'];
export const MEMORY_AUDITED_OPERATION_IDS: readonly MemoryAuditedOperation[] = ['memory.create', 'memory.supersede', 'memory.delete'];
export const UNDERSTANDING_AUDITED_OPERATION_IDS: readonly UnderstandingAuditedOperation[] = ['understanding.generate', 'understanding.review-decision', 'understanding.confirm', 'understanding.correct'];
export const CONTEXT_AUDITED_OPERATION_IDS: readonly ContextAuditedOperation[] = ['context.flag-conflict'];
export const TASK_AUDITED_OPERATION_IDS: readonly TaskAuditedOperation[] = ['task.plan', 'task.repeat', 'task.delete', 'task.complete'];
export const STRATEGY_AUDITED_OPERATION_IDS: readonly StrategyAuditedOperation[] = ['strategy.generate', 'strategy.select'];
export const DECISION_AUDITED_OPERATION_IDS: readonly DecisionAuditedOperation[] = ['decision.record'];
export const PLANNING_AUDITED_OPERATION_IDS: readonly PlanningAuditedOperation[] = ['roadmap.generate', 'roadmap.edit', 'planning.run_record'];
export const JOB_AUDITED_OPERATION_IDS: readonly JobAuditedOperation[] = ['job.enqueue', 'job.dead_letter'];
export const RUN_AUDITED_OPERATION_IDS: readonly RunAuditedOperation[] = ['run.start', 'run.fail', 'run.cancel'];
export const TOOL_AUDITED_OPERATION_IDS: readonly ToolAuditedOperation[] = ['tool.dispatch', 'tool.complete', 'tool.fail'];
export const WORKER_AUDITED_OPERATION_IDS: readonly WorkerAuditedOperation[] = ['worker.set_state', 'worker.run_start', 'worker.run_complete', 'worker.run_fail'];
export const BILLING_AUDITED_OPERATION_IDS: readonly BillingAuditedOperation[] = ['credit.reserve', 'credit.settle'];
export const ARTIFACT_AUDITED_OPERATION_IDS: readonly ArtifactAuditedOperation[] = ['artifact.request-revision'];
export const APPROVAL_AUDITED_OPERATION_IDS: readonly ApprovalAuditedOperation[] = ['approval.request', 'approval.decide', 'approval.decide.rejected', 'approval.revoke', 'approval.revoke_failed', 'approval.consume'];
export const POLICY_AUDITED_OPERATION_IDS: readonly PolicyAuditedOperation[] = ['policy.evaluate', 'policy.evaluate.denied', 'policy.evaluate.unavailable', 'policy.initialize'];
export const EMERGENCY_STOP_AUDITED_OPERATION_IDS: readonly EmergencyStopAuditedOperation[] = ['emergency_stop.activate', 'emergency_stop.clear', 'emergency_stop.work.review'];

// Compile-time guard: the domain partition covers EXACTLY the full operation set (a new operation that is not
// added to one of the domain subsets is a type error here — the mutual `extends` assignment fails).
type PartitionDomains = MembershipAuditedOperation | CompanyAuditedOperation | ProvisioningAuditedOperation | AdminAuditedOperation | InterviewAuditedOperation | MemoryAuditedOperation | UnderstandingAuditedOperation | ContextAuditedOperation | TaskAuditedOperation | StrategyAuditedOperation | DecisionAuditedOperation | PlanningAuditedOperation | JobAuditedOperation | RunAuditedOperation | ToolAuditedOperation | WorkerAuditedOperation | BillingAuditedOperation | ArtifactAuditedOperation | PolicyAuditedOperation | ApprovalAuditedOperation | EmergencyStopAuditedOperation;
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
    case 'task.repeat':
      return (subjectId) => taskRepeated({ newTaskId: subjectId, sourceTaskId: subjectId, sourceState: 'completed' });
    case 'task.delete':
      return (subjectId) => taskDeleted({ taskId: subjectId, stateAtDelete: 'planned', hasReason: false });
    case 'artifact.request-revision':
      return (subjectId) => artifactRevisionRequested({ revisionId: subjectId, originalArtifactId: subjectId, newTaskId: subjectId, hasGuidance: true });
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
    case 'planning.run_record':
      return (subjectId) => planningRunRecorded({ runId: subjectId, mode: 'autonomous', outcome: 'ok', taskCount: 3, tasksMissingRationale: 0, memoryItemsConsidered: 0, milestonesInScope: 1 });
    case 'job.enqueue':
      return (subjectId) => jobEnqueued({ jobId: subjectId, kind: 'understanding.generate', deduplicated: false });
    case 'job.dead_letter':
      return (subjectId) => jobDeadLettered({ jobId: subjectId, kind: 'understanding.generate', attempts: 3, reason: 'attempts_exhausted' });
    case 'run.start':
      return (subjectId) => taskStarted({ taskId: subjectId, runId: subjectId, attempt: 1 });
    case 'run.fail':
      return (subjectId) => taskFailed({ taskId: subjectId, runId: subjectId, attempt: 1, failureCategory: 'worker_lost', retryState: 'retry_eligible' });
    case 'run.cancel':
      return (subjectId) => taskCancelled({ taskId: subjectId, runId: subjectId, phase: 'queued' });
    case 'policy.evaluate':
      return (subjectId) => policyEvaluated({ evaluationId: subjectId, policyVersion: 1, decision: 'allow', evaluationPoint: 'pre_execution' });
    case 'policy.evaluate.denied':
      return (subjectId) => policyBlocked({ evaluationId: subjectId, policyVersion: 1, reason: 'policy_denied', evaluationPoint: 'pre_execution' });
    case 'policy.evaluate.unavailable':
      // SUBJECT = the COMPANY here, not an evaluation — there is none to point at (CDR-066 §6-G16).
      return (subjectId) => policyUnavailable({ companyId: subjectId, reason: 'no_active_policy', evaluationPoint: 'pre_execution' });
    case 'approval.request':
      return (subjectId) =>
        approvalRequested({ requestId: subjectId, toolId: 'send_email', riskClass: 'external_reversible', scope: 'one_action', policyVersion: 1, estimatedCostCredits: 1 });
    case 'approval.decide':
      return (subjectId) => approvalApproved({ requestId: subjectId, path: 'approve', deciderType: 'human', policyVersion: 1 });
    case 'approval.decide.rejected':
      return (subjectId) => approvalRejected({ requestId: subjectId, deciderType: 'human', policyVersion: 1 });
    case 'approval.revoke_failed':
      return (subjectId) => approvalRevokeFailed({ requestId: subjectId, attemptedByUserId: subjectId });
    case 'approval.revoke':
      return (subjectId) => approvalRevoked({ requestId: subjectId, revokedByUserId: subjectId });
    case 'approval.consume':
      return (subjectId) => approvalConsumed({ requestId: subjectId, callId: subjectId, toolId: 'send_email' });
    case 'policy.initialize':
      return (subjectId) => policyChanged({ policyId: subjectId, version: 1, baseline: 'allow', ruleCount: 1 });
    case 'tool.dispatch':
      return (subjectId) => toolCallRequested({ callId: subjectId, toolId: 'web_research', toolVersion: 1, riskClass: 'informational', externalEffect: false });
    case 'tool.complete':
      return (subjectId) => toolCallCompleted({ callId: subjectId, toolId: 'web_research', riskClass: 'informational', callOutcome: 'succeeded', hasReceipt: false });
    case 'tool.fail':
      return (subjectId) => toolCallCompleted({ callId: subjectId, toolId: 'web_research', riskClass: 'informational', callOutcome: 'failed', hasReceipt: false });
    case 'worker.set_state':
      return (subjectId) => workerStateChanged({ workerId: subjectId, state: 'paused', hasReason: false });
    case 'credit.reserve':
      return (subjectId) => creditReserved({ txnId: subjectId, runId: subjectId, credits: 1, balanceAfter: 0 });
    case 'credit.settle':
      return (subjectId) => creditSettled({ txnId: subjectId, runId: subjectId, settlement: 'release', credits: 1, balanceAfter: 1 });
    case 'worker.run_start':
      return (subjectId) => workerRunStarted({ workerRunId: subjectId, workerId: 'research', workerVersion: 1 });
    case 'worker.run_complete':
      return (subjectId) => workerRunFinished({ workerRunId: subjectId, workerId: 'research', workerVersion: 1, outcome: 'succeeded' });
    case 'worker.run_fail':
      return (subjectId) => workerRunFinished({ workerRunId: subjectId, workerId: 'research', workerVersion: 1, outcome: 'failed', failureCategory: 'policy_blocked', haltReason: 'budget_exhausted' });
    case 'task.complete':
      return (subjectId) => taskCompleted({ taskId: subjectId, runId: subjectId, artifactCount: 1, hasNoArtifactRationale: false });
    // Emergency stop (ACBP-P6-007; CDR-072 §1-G5). The driver values are representative: what this registry proves
    // is that each operation HAS a factory and that the factory's event name matches the map — the real scope,
    // target and counts come from the service and are asserted against the stored payload there.
    case 'emergency_stop.activate':
      return (subjectId) => emergencyStopActivated({ stopId: subjectId, scope: 'account_wide', target: null, heldCount: 0 });
    case 'emergency_stop.clear':
      return (subjectId) => emergencyStopCleared({ stopId: subjectId, scope: 'account_wide', pendingReviewCount: 0 });
    case 'emergency_stop.work.review':
      return (subjectId) => emergencyStopWorkReviewed({ stopId: subjectId, decision: 'confirmed', heldWorkId: subjectId });
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
