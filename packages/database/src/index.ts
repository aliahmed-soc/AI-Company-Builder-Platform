// @acbp/database — public API (ACBP-P0-018). PostgreSQL access + migration foundation.
// No product-domain schema or repositories: those arrive with their owning tickets.
export { createDatabase, closeDatabase, checkDatabaseHealth } from './client.js';
export type { DatabaseClient, DatabaseHealth, CreateDatabaseDeps, DbCallOptions } from './client.js';

export { withTransaction, withTenantTransaction, withAccountTransaction, elevateToCompanyScope, nestedTransactionError } from './transaction.js';
export type { TxExecutor } from './transaction.js';

export { TenantRepository, AccountScopedRepository } from './repository.js';
export type { TenantContext, TenantScope } from './tenant.js';
// Account-level tenancy primitive (ACBP-P1-005; CDR-012). AccountContext is re-exported from @acbp/contracts
// (the neutral currency). createAccountScope is intentionally NOT exported — an AccountScope must originate
// from withAccountTransaction so account context cannot be forged (CDR-012 #2).
export type { AccountScope, AccountContext } from './account-tenant.js';

// Global identity-root repositories (ACBP-P1-002; NOT tenant-scoped — CDR-008).
export { UserMappingRepository, WebhookReceiptRepository } from './identity-repositories.js';
export type { IdentityExecutor, ProviderIdentityKey } from './identity-repositories.js';

// Account-root repositories (ACBP-P1-003; CDR-010). Not tenant-scoped yet (RLS is P1-006).
export { AccountRepository, AccountProfileRepository } from './account-repositories.js';
export type { AccountExecutor } from './account-repositories.js';

// Membership repository (ACBP-P1-004; CDR-011). Authorization role source; not tenant-scoped yet.
export { MembershipRepository } from './membership-repositories.js';
export type { MembershipExecutor } from './membership-repositories.js';

// Append-only audit writer (ACBP-P1-008; ADR-015; CDR-014). Writes under the caller's account/company scope in-tx.
export { writeAuditEvent } from './audit-repository.js';
export type { AuditWriteContext, AuditScope } from './audit-repository.js';

// Company repositories (ACBP-P1-010; CDR-015). Company creation runs under an AccountScope; company-owned
// reads/mutations run under a CompanyScope (TenantScope). Kysely parameterized queries only.
export { CompanyRepository, CompanyProfileRepository, CompanyMembershipRepository } from './company-repositories.js';
export type { CompanyExecutor } from './company-repositories.js';

// Synchronous company activity projection writer (ACBP-P1-009; CDR-016). Writes the redacted activity_events row
// in the same CompanyScope transaction as the lifecycle mutation + audit; keyed by the source audit event id.
export { projectCompanyActivity, ActivityFeedRepository } from './activity-repository.js';
export type { ActivityWriteFn, ActivityExecutor, ActivityKeyset, ActivityFeedRow } from './activity-repository.js';

// Decision Room source reads (ACBP-P6-008; CDR-076; DEC-001). Read-only, company-scoped; the completed-work read
// carries invariant 20 as an EXISTS over a succeeded run, so an unevidenced completion cannot be returned at all.
export { DecisionRoomRepository } from './decision-room-repository.js';
export type {
  DecisionRoomExecutor,
  DecisionRoomList,
  ApprovalRequestSummaryRow,
  ApprovalDecisionSummaryRow,
  HeldWorkSummaryRow,
  TaskSummaryRow,
  FailedTaskRow,
  CompletedTaskRow,
  OpenQuestionRow,
  StrategyOptionSummaryRow,
  StrategyDecisionSummaryRow,
  CompanyUsageTotals,
} from './decision-room-repository.js';

// The company-scoped export reader (ACBP-P7-001; CDR-078 §6.1; EXPORT-001). ONE generic whole-row read over a
// CLOSED table allowlist: a mapper per entity can forget a column and nothing would ever say so, which is ADR-002's
// failure; a generic read can only pick one up, and that lands in the secret guard. Ordering comes from the
// declaration, never from the caller.
export { ExportRepository } from './export-repository.js';
export type { ExportExecutor, ExportRow } from './export-repository.js';

// Company portfolio read repository (ACBP-P1-011; CDR-017). Account-scoped, membership-filtered keyset listing
// of the actor's active-membership companies. No name (enriched separately under CompanyScope); reads only.
export { PortfolioRepository } from './portfolio-repository.js';
export type { PortfolioExecutor, PortfolioKeyset, PortfolioCandidateRow } from './portfolio-repository.js';

// Workspace-provisioning repositories (ACBP-P1-012; CDR-018). Checkpoint seeding/locking/outcomes + the
// append-only workspace-area registry. Every method requires a validated CompanyScope (dual-keyed RLS).
export { ProvisioningRepository, WorkspaceAreaRepository } from './provisioning-repository.js';
export type { ProvisioningExecutor } from './provisioning-repository.js';
export { InterviewSessionRepository } from './interview-repository.js';
export type { InterviewExecutor } from './interview-repository.js';
export { InterviewQaRepository } from './interview-qa-repository.js';
export type { InterviewQaExecutor } from './interview-qa-repository.js';
export { MemoryItemRepository } from './memory-item-repository.js';
export type { MemoryItemExecutor, NewMemoryItemInput, ListMemoryItemsOptions } from './memory-item-repository.js';
// Append-only model-gateway usage ledger (ACBP-P2-003; CDR-026). SELECT + INSERT only; every method
// requires a validated CompanyScope (dual-keyed RLS). Written in-tx with the gateway work (fail-closed).
export { UsageEventRepository } from './usage-event-repository.js';
export type { UsageEventExecutor, NewUsageEventInput, ListUsageEventsOptions } from './usage-event-repository.js';
// Account usage rollups + compensating corrections (ACBP-P6-009; CDR-073). The rollup is an account-keyed
// MUTABLE PROJECTION (never a source of truth); corrections are append-only. `toRollupFigure` is the required
// seam for every bigint figure — this repo installs no int8 type parser, so they arrive as strings.
export { AccountUsageRollupRepository, UsageCorrectionRepository, toRollupFigure, rollupRowFigures } from './usage-rollup-repository.js';
export type { UsageRollupExecutor, RollupFigureRow, NewUsageCorrectionInput } from './usage-rollup-repository.js';
// Understanding generation (ACBP-P2-008; CDR-029). Versioned append-only documents + classified items; every
// method requires a validated CompanyScope (dual-keyed RLS). Written in-tx with the audit event.
export { UnderstandingRepository } from './understanding-repository.js';
export type { UnderstandingExecutor, NewUnderstandingDocumentInput, NewUnderstandingItemInput, ListUnderstandingOptions } from './understanding-repository.js';
export { UnderstandingReviewRepository } from './understanding-review-repository.js';
export type { UnderstandingReviewExecutor, NewUnderstandingItemReviewInput, NewUnderstandingConfirmationEventInput } from './understanding-review-repository.js';
export { TaskRepository } from './task-repository.js';
export type { TaskExecutor, NewTaskInput, NewTaskDependencyInput, NewTaskDeletionInput, ListTasksOptions } from './task-repository.js';
export { TaskRunRepository } from './task-run-repository.js';
export type { TaskRunExecutor, NewTaskRunInput, TransitionTaskRunInput } from './task-run-repository.js';
export { WorkerRepository } from './worker-repository.js';
export type { WorkerExecutor, SetCompanyWorkerStateInput } from './worker-repository.js';
export { CreditRepository } from './credit-repository.js';
export type { CreditExecutor, NewCreditEntryInput } from './credit-repository.js';
export { WorkerRunRepository } from './worker-run-repository.js';
export type { WorkerRunExecutor, NewWorkerRunInput, FinishWorkerRunInput } from './worker-run-repository.js';
export { ArtifactRepository } from './artifact-repository.js';
export { ArtifactRevisionRepository } from './artifact-revision-repository.js';
export type { ArtifactRevisionExecutor, NewArtifactRevisionInput } from './artifact-revision-repository.js';
export type { ArtifactExecutor, NewArtifactInput } from './artifact-repository.js';
// Policy storage + append-only evaluation records (ACBP-P6-001b; CDR-066 §5).
export { PolicyRepository } from './policy-repository.js';
// Emergency-stop state and the held-work queue (ACBP-P6-007; CDR-072; migration 0050).
export { StopRepository } from './stop-repository.js';
export type { StopExecutor, EmergencyStopRow, NewEmergencyStopInput, NewHeldWorkInput } from './stop-repository.js';

// API request-limit buckets (ACBP-P7-013; CDR-081; migration 0055). Takes a plain executor and needs NO tenant
// scope — the table is global by design, because a session bucket is consulted before any account is known.
export { consumeBucket, bucketKeyHash } from './rate-limit-repository.js';
export type { RateLimitExecutor, RateLimitScopeKind, ConsumeBucketParams, ConsumeBucketResult } from './rate-limit-repository.js';
export { ApprovalRepository } from './approval-repository.js';
export type { NewApprovalRequestInput, NewApprovalDecisionInput } from './approval-repository.js';
export type { PolicyExecutor, NewPolicyInput, NewPolicyEvaluationInput } from './policy-repository.js';
export { ToolCallRepository } from './tool-call-repository.js';
export type { ToolCallExecutor, NewToolCallInput, CompleteToolCallInput } from './tool-call-repository.js';
export { JobRepository } from './job-repository.js';
export type { JobExecutor, NewJobInput, NewJobCheckpointInput } from './job-repository.js';
export { StrategyRepository } from './strategy-repository.js';
export type { StrategyExecutor, NewStrategyGenerationInput, NewStrategyOptionInput, NewStrategyRecommendationInput, NewStrategySelectionInput, NewDecisionInput, ListStrategyGenerationsOptions } from './strategy-repository.js';
export { PlanningRepository, CLOSED_TASK_STATES } from './planning-repository.js';
export type { PlanningExecutor, NewRoadmapInput, NewGoalInput, NewMilestoneInput, NewTaskReviewFlagInput, NewPlanningRunFields, NewPlanningRunInputLink } from './planning-repository.js';

// The PURPOSE-SPECIFIC platform-admin tenant-read primitive (ACBP-P1-013; CDR-019). Exactly ONE audited
// operation; consumed solely by @acbp/core's admin module. NOT a generic cross-tenant tool — no runAsTenant/
// arbitrary-scope helper exists or may be added.
export { executeAdminCompanyRead } from './admin-access.js';
export type { AdminCompanyReadRow, AdminCompanyReadOutcome } from './admin-access.js';

// SECURITY DEFINER bootstrap function callers (ACBP-P1-006; CDR-013). The only RLS-boundary crossings.
export { provisionAccountBootstrap, resolveOwnMembershipBootstrap, acceptInviteBootstrap } from './bootstrap-functions.js';
export type { BootstrapExecutor } from './bootstrap-functions.js';

export { applyTenantSession, buildTenantSettings, applyAccountSession, buildAccountSettings, TENANT_SETTINGS } from './session.js';
export type { TenantSettingStatement } from './session.js';

export { toDatabaseError } from './errors.js';
export { toPoolConfig } from './pool.js';

export { createMigrator, createFileMigrationProvider, migrateToLatest, migrateDown, migrationStatus, MIGRATIONS_DIR } from './migrator.js';

export type {
  DatabaseSchema,
  UsersTable,
  IdentityWebhookReceiptsTable,
  UserRow,
  NewUser,
  UserUpdate,
  IdentityWebhookReceiptRow,
  NewIdentityWebhookReceipt,
  AccountsTable,
  AccountProfilesTable,
  AccountRow,
  NewAccount,
  AccountUpdate,
  AccountProfileRow,
  NewAccountProfile,
  AccountProfileUpdate,
  MembershipsTable,
  MembershipRow,
  NewMembership,
  MembershipUpdate,
  AuditEventsTable,
  AuditEventRow,
  NewAuditEvent,
  CompaniesTable,
  CompanyRow,
  NewCompany,
  CompanyUpdate,
  CompanyProfilesTable,
  CompanyProfileRow,
  NewCompanyProfile,
  CompanyMembershipsTable,
  CompanyMembershipRow,
  NewCompanyMembership,
  ActivityEventsTable,
  ActivityEventRow,
  NewActivityEvent,
  ProvisioningStepsTable,
  ProvisioningStepRow,
  NewProvisioningStep,
  ProvisioningStepUpdate,
  CompanyWorkspaceAreasTable,
  CompanyWorkspaceAreaRow,
  NewCompanyWorkspaceArea,
  PlatformAdminsTable,
  InterviewSessionsTable,
  InterviewSessionRow,
  NewInterviewSession,
  InterviewSessionUpdate,
  InterviewQuestionsTable,
  InterviewQuestionRow,
  NewInterviewQuestion,
  InterviewAnswersTable,
  InterviewAnswerRow,
  NewInterviewAnswer,
  MemoryItemsTable,
  MemoryItemRow,
  NewMemoryItem,
  UsageEventsTable,
  UsageEventRow,
  NewUsageEvent,
  // Account usage rollups + corrections (ACBP-P6-009; migration 0051). Exported for the same reason every other
  // row type here is: `AccountUsageRollupRepository.find()` and `UsageCorrectionRepository.insert()` DECLARE these
  // as their return types, so without this line both public repositories have return types a consumer outside the
  // package cannot name.
  AccountUsageRollupsTable,
  AccountUsageRollupRow,
  NewAccountUsageRollup,
  UsageCorrectionsTable,
  UsageCorrectionRow,
  NewUsageCorrection,
  UnderstandingDocumentsTable,
  UnderstandingDocumentRow,
  NewUnderstandingDocument,
  UnderstandingItemsTable,
  UnderstandingItemRow,
  NewUnderstandingItem,
  TasksTable,
  TaskRow,
  NewTask,
  TaskUpdate,
  TaskDependenciesTable,
  TaskDependencyRow,
  NewTaskDependency,
  StrategyGenerationsTable,
  StrategyGenerationRow,
  NewStrategyGeneration,
  StrategyOptionsTable,
  StrategyOptionRow,
  NewStrategyOption,
  StrategyRecommendationsTable,
  StrategyRecommendationRow,
  NewStrategyRecommendation,
  StrategySelectionsTable,
  StrategySelectionRow,
  NewStrategySelection,
  DecisionsTable,
  DecisionRow,
  NewDecision,
  RoadmapsTable,
  RoadmapRow,
  NewRoadmap,
  GoalsTable,
  GoalRow,
  NewGoal,
  MilestonesTable,
  MilestoneRow,
  NewMilestone,
  TaskReviewFlagsTable,
  TaskReviewFlagRow,
  NewTaskReviewFlag,
  PlanningRunsTable,
  PlanningRunRow,
  NewPlanningRun,
  PlanningRunInputsTable,
  PlanningRunInputRow,
  NewPlanningRunInput,
  TaskDeletionsTable,
  TaskDeletionRow,
  JobsTable,
  JobRow,
  JobCheckpointsTable,
  JobCheckpointRow,
  NewJobCheckpoint,
  NewJob,
  ToolDefinitionsTable,
  ToolDefinitionRow,
  TaskRunsTable,
  TaskRunRow,
  ToolCallsTable,
  ToolCallRow,
  WorkerDefinitionsTable,
  WorkerDefinitionRow,
  CompanyWorkerStatesTable,
  CompanyWorkerStateRow,
  WorkerRunsTable,
  WorkerRunRow,
  CreditTransactionsTable,
  CreditTransactionRow,
  ArtifactsTable,
  ArtifactRow,
  NewArtifact,
  ArtifactRevisionsTable,
  ArtifactRevisionRow,
  NewArtifactRevision,
  NewTaskDeletion,
  // Approvals (ACBP-P6-003c; CDR-068).
  ApprovalRequestsTable,
  ApprovalRequestRow,
  NewApprovalRequest,
  ApprovalDecisionsTable,
  ApprovalDecisionRow,
  NewApprovalDecision,
} from './schema.js';

// NOTE: createTenantScope is intentionally NOT exported — a TenantScope must originate from
// withTenantTransaction so tenant context cannot be forged (ADR-007 invariant 2).
