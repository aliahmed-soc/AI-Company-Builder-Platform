// @acbp/core — Clerk identity COMPOSITION layer (ACBP-P1-002 Slice 3; ADR-022 §13).
//
// This is the ONLY module that knows every concrete implementation at once (per §8): the Clerk webhook
// verifier + Clerk authoritative reader (@acbp/adapters), the database client + repositories
// (@acbp/database, via the processor/use case), the transactional processor + read-through use case
// (this package), and the validated config (@acbp/config types). It exists so apps/web can compose the
// webhook route and the authenticated read-through through @acbp/core ALONE — the web layer never
// imports @acbp/adapters or @acbp/database directly, and no Clerk SDK type ever reaches core's other
// modules (the adapter classes encapsulate the SDK; the signing secret is unwrapped only inside them).
import { ClerkIdentityWebhookVerifier, ClerkAuthoritativeIdentityReader } from '@acbp/adapters';
import { createDatabase, closeDatabase, type DatabaseClient, type ProviderIdentityKey } from '@acbp/database';
import type { ClerkConfig, ClerkWebhookConfig, DatabaseConfig } from '@acbp/config';
import type { Logger } from '@acbp/observability';
import { createIdentityWebhookService, type IdentityWebhookService } from '../identity/webhook-service.js';
import { resolveOrReconcileInternalUser, type InternalUserReconciliation, type ReconcileOptions } from '../identity/read-through.js';
import { reconcileAllUsers, type ReconciliationSummary, type ReconcileOptions as ReconcileAllOptions } from '../identity/reconciliation.js';
import { provisionPersonalAccount, type ProvisionResult } from '../accounts/provisioning.js';
// ACBP-P7-013 — CDR-008 §8's request ceilings (CDR-082; NFR-010). A DIFFERENT limit from the usage caps: this
// bounds request frequency, those bound money (CDR-082 §5).
import { checkRequestLimit, type RequestLimitOptions, type RequestLimitOutcome } from '../limits/request-limit-service.js';
import type { RateLimitScopeKind } from '@acbp/database';

// Re-exported so `apps/web` can NAME the outcome it must handle. A status a caller cannot spell is a status a
// caller silently drops, and dropping this one means admitting a request the limiter refused.
export type { RequestLimitOptions, RequestLimitOutcome } from '../limits/request-limit-service.js';
export type { RateLimitScopeKind } from '@acbp/database';
import { getProfileForOwner, updateProfileForOwner, type AccountProfileView, type ProfileUpdateInput } from '../accounts/profile.js';
import {
  inviteMember,
  acceptInvite,
  revokeMember,
  listMembers,
  type InviteResult,
  type AcceptResult,
  type RevokeResult,
  type ListResult,
  type MembershipOpOptions,
} from '../members/membership-service.js';
import {
  resolveAccountContext as resolveAccountContextUseCase,
  type ResolveAccountContextParams,
  type ResolveAccountContextOptions,
} from '../tenancy/account-context-resolver.js';
import { createCompany, type CreateCompanyParams, type CreateCompanyResult, type CompanyOpOptions } from '../company/company-service.js';
import {
  getCompany,
  renameCompany,
  pauseCompany,
  resumeCompany,
  type GetCompanyResult,
  type RenameResult,
  type StatusTransitionResult,
  type RenameParams,
  type PauseParams,
  type CompanyLifecycleOptions,
} from '../company/company-lifecycle.js';
import { getCompanyActivity, type GetActivityParams, type GetActivityResult, type GetActivityOptions } from '../company/activity-service.js';
import { readDecisionRoom, type ReadDecisionRoomParams, type ReadDecisionRoomResult, type ReadDecisionRoomOptions } from '../decision-room/decision-room-service.js';
import { getCompanyPortfolio, type GetPortfolioParams, type GetPortfolioResult, type GetPortfolioOptions } from '../company/portfolio-service.js';
import { getProvisioningStatus, resumeProvisioning, type ProvisioningParams, type GetProvisioningResult, type ResumeProvisioningResult, type ProvisioningOpOptions } from '../company/provisioning-service.js';
import { adminReadCompanyOverview, type AdminReadParams, type AdminReadResult, type AdminOpOptions } from '../admin/admin-service.js';
import { startInterviewSession, suspendInterviewSession, resumeInterviewSession, getInterviewSession, type InterviewSessionParams, type InterviewSessionOptions, type StartInterviewResult, type InterviewTransitionResult, type GetInterviewResult } from '../discovery/interview-session.js';
import { recordInterviewAnswer, getSessionQa, type InterviewQaParams, type InterviewQaOptions, type RecordAnswerResult, type GetSessionQaResult } from '../discovery/interview-qa.js';
import { createMemoryItem, listMemoryItems, editMemoryItem, getMemoryItem, deleteMemoryItem, type CreateMemoryItemParams, type ListMemoryItemsParams, type EditMemoryItemParams, type GetMemoryItemParams, type DeleteMemoryItemParams, type MemoryOptions, type CreateMemoryItemResult, type ListMemoryItemsResult, type EditMemoryItemResult, type GetMemoryItemResult, type DeleteMemoryItemResult } from '../memory/memory-item.js';
// CDR-087 — strategy read and decision recording, exposed over HTTP by apps/web. Composition only: the
// authorization for each lives inside the use case, not here and not at the route (CDR-087 §1).
import { getLatestStrategyGeneration, type StrategyReadParams, type StrategyGenerationOptions, type LatestStrategyResult } from '../strategy/strategy-generation.js';
import { getLatestRoadmap, type RoadmapReadParams, type RoadmapGenerationOptions, type LatestRoadmapResult } from '../planning/roadmap-generation.js';
import { getTaskBoard, type GetTaskBoardParams, type TaskBoardOptions, type GetTaskBoardResult } from '../tasks/task-board.js';
import { recordStrategyDecision, type RecordStrategyDecisionParams, type RecordStrategyDecisionResult, type RecordStrategyDecisionDeps } from '../strategy/strategy-selection.js';
import { recordDecision, type RecordDecisionParams, type RecordDecisionResult, type RecordDecisionDeps } from '../strategy/decision-record.js';
import type { AccountContextResolution } from '@acbp/contracts';

/** Company id + acting user + account, the shared identity of a company-scoped request. */
export interface CompanyRequestKey {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

/** Options for account operations: an optional correlation id and audit/structured logger. */
export interface AccountOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export interface ClerkIdentityRuntimeConfig {
  readonly databaseConfig: DatabaseConfig;
  readonly clerkWebhookConfig: ClerkWebhookConfig;
  readonly clerkConfig: ClerkConfig;
  /** Required expected Clerk instance id: the read-through providerInstanceId (never browser-supplied). */
  readonly expectedInstanceId: string;
}

export interface ClerkIdentityRuntimeDeps {
  /** Inject a database client (e.g. in tests, or to share one pool); production creates its own. */
  readonly client?: DatabaseClient;
}

/**
 * A composed, server-only runtime shared by the webhook route and the authenticated read-through. Holds
 * one database client (pool). Callers should create it once (module singleton) and `close()` at shutdown.
 */
export interface ClerkIdentityRuntime {
  /** Neutral webhook service for the public Route Handler. */
  readonly webhook: IdentityWebhookService;
  /**
   * Consume one request against CDR-008 §8's per-session or per-account ceiling (ACBP-P7-013; CDR-082; NFR-010).
   *
   * On the runtime rather than free-standing so `apps/web` reaches it the way it reaches everything else — the
   * composition already owns the one restricted database pool, and a route that had to build its own client to
   * be rate limited is a route that will be written without one.
   */
  checkRequestLimit(scopeKind: RateLimitScopeKind, scopeKey: string, options?: RequestLimitOptions): Promise<RequestLimitOutcome>;
  /**
   * Resolve-or-reconcile the internal user for a SERVER-VERIFIED provider user id (from the P1-001
   * boundary). The provider instance id comes from configuration — never from the request/headers.
   */
  resolveInternalUser(providerUserId: string, options?: ReconcileOptions): Promise<InternalUserReconciliation>;
  /** Nightly drift reconciliation over all active mappings (forward-drift repair; non-destructive). */
  reconcile(options?: ReconcileAllOptions): Promise<ReconciliationSummary>;
  /**
   * Idempotently ensure the personal account (+ profile) for a SERVER-VERIFIED internal user id
   * (ACBP-P1-003). Safe to call on every authenticated request; creates on the first only.
   */
  ensurePersonalAccount(userId: string, options?: AccountOpOptions): Promise<ProvisionResult>;
  /** Read the owner's profile view (email read-only), or undefined when the user has no account. */
  getAccountProfile(userId: string, options?: AccountOpOptions): Promise<AccountProfileView | undefined>;
  /** Apply a profile edit for the owner and return the resulting view (undefined when no account). */
  updateAccountProfile(userId: string, input: ProfileUpdateInput, options?: AccountOpOptions): Promise<AccountProfileView | undefined>;
  /** Membership (ACBP-P1-004; CDR-011). Authorization is enforced inside the use case from the role. */
  inviteMember(params: { accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown }, options?: MembershipOpOptions): Promise<InviteResult>;
  acceptInvite(params: { token: string; acceptingUserId: string }, options?: MembershipOpOptions): Promise<AcceptResult>;
  revokeMember(params: { accountId: string; actingUserId: string; membershipId: string }, options?: MembershipOpOptions): Promise<RevokeResult>;
  listMembers(params: { accountId: string; actingUserId: string }, options?: MembershipOpOptions): Promise<ListResult>;
  /**
   * Resolve account-level tenant context (ACBP-P1-005; CDR-012) for a SERVER-VERIFIED internal user id and
   * a REQUESTED account id. Returns a resolved AccountContext only when the caller has an ACTIVE membership;
   * otherwise a coarse deny. The requested account id is never trusted without that membership.
   */
  resolveAccountContext(params: ResolveAccountContextParams, options?: ResolveAccountContextOptions): Promise<AccountContextResolution>;
  /**
   * Company lifecycle (ACBP-P1-010; CDR-015). `create` is owner-gated by the caller's ACCOUNT role; the rest
   * run under a resolved CompanyScope (active company membership) with owner-only mutations enforced inside
   * the use case from the company role. `accountId` is the caller's own account; `companyId` is a request
   * selector validated by membership — never trusted on its own.
   */
  createCompany(params: CreateCompanyParams, options?: CompanyOpOptions): Promise<CreateCompanyResult>;
  getCompany(params: CompanyRequestKey, options?: CompanyLifecycleOptions): Promise<GetCompanyResult>;
  renameCompany(params: RenameParams, options?: CompanyLifecycleOptions): Promise<RenameResult>;
  pauseCompany(params: PauseParams, options?: CompanyLifecycleOptions): Promise<StatusTransitionResult>;
  resumeCompany(params: PauseParams, options?: CompanyLifecycleOptions): Promise<StatusTransitionResult>;
  /** Read a page of the company activity feed (ACBP-P1-009). Owner|viewer company member; keyset-paginated. */
  getCompanyActivity(params: GetActivityParams, options?: GetActivityOptions): Promise<GetActivityResult>;
  /**
   * Read the Decision Room (ACBP-P6-008; DEC-001). Owner|viewer company member; always ten queues, each `ok`,
   * `restricted` or `unavailable` — a section the caller may not read or whose query failed is never an empty one.
   */
  readDecisionRoom(params: ReadDecisionRoomParams, options?: ReadDecisionRoomOptions): Promise<ReadDecisionRoomResult>;
  /**
   * Read a page of the caller's company portfolio (ACBP-P1-011; CDR-017). Active account member (owner|viewer);
   * rows are filtered to the actor's ACTIVE company memberships (account ownership grants none). Keyset-paginated;
   * the cursor is bound to the account+actor. `accountId` is the caller's own account (server-resolved).
   */
  getCompanyPortfolio(params: GetPortfolioParams, options?: GetPortfolioOptions): Promise<GetPortfolioResult>;
  /**
   * Workspace provisioning (ACBP-P1-012; CDR-018). Status read = any active company member (owner|viewer);
   * resume = company owner only. Request-driven sequential execution; no worker/queue exists. companyId is a
   * membership-validated selector.
   */
  getProvisioningStatus(params: ProvisioningParams, options?: ProvisioningOpOptions): Promise<GetProvisioningResult>;
  resumeProvisioning(params: ProvisioningParams, options?: ProvisioningOpOptions): Promise<ResumeProvisioningResult>;
  /**
   * Platform-administrative company-overview read (ACBP-P1-013; CDR-019). NOT a tenant operation: authority
   * comes ONLY from a fresh in-transaction platform_admins self-check (tenant roles/account ownership/Clerk
   * claims never grant it); the mandatory reason is validated before any database access; the read is audited
   * (admin.tenant_read, target-tenant trail) atomically or nothing is returned. Every denial is one coarse
   * `forbidden`.
   */
  adminReadCompanyOverview(params: AdminReadParams, options?: AdminOpOptions): Promise<AdminReadResult>;
  /**
   * Interview session lifecycle (ACBP-P2-001; CDR-022). Company-scoped; participate/read = any active company
   * member. `start` (not_started→in_progress) requires the company be active and emits interview.started in the
   * same transaction; suspend/resume are the exact-resume in_progress⇄waiting_for_user transitions; get returns
   * the company's current open session. companyId is a membership-validated selector.
   */
  startInterviewSession(params: InterviewSessionParams, options?: InterviewSessionOptions): Promise<StartInterviewResult>;
  suspendInterviewSession(params: InterviewSessionParams, options?: InterviewSessionOptions): Promise<InterviewTransitionResult>;
  resumeInterviewSession(params: InterviewSessionParams, options?: InterviewSessionOptions): Promise<InterviewTransitionResult>;
  getInterviewSession(params: InterviewSessionParams, options?: InterviewSessionOptions): Promise<GetInterviewResult>;
  /**
   * Interview Q&A persistence (ACBP-P2-002; CDR-023). `recordInterviewAnswer` appends an answer/skip revision
   * (append-only; idempotent no-op on an identical resubmit); `getSessionQa` reads the session's questions +
   * current answers + revision history. Both company-scoped; participate/read = any active company member.
   */
  recordInterviewAnswer(params: InterviewQaParams & { questionId: string; status: unknown; content?: unknown }, options?: InterviewQaOptions): Promise<RecordAnswerResult>;
  getSessionQa(params: InterviewQaParams, options?: InterviewQaOptions): Promise<GetSessionQaResult>;
  /**
   * Typed memory (ACBP-P2-006; CDR-024). `createMemoryItem` persists a typed item (type set by source path)
   * and audits `memory.item_created` in the same transaction; `listMemoryItems` returns the company's items.
   * Both company-scoped; write/read = any active company member.
   */
  createMemoryItem(params: CreateMemoryItemParams, options?: MemoryOptions): Promise<CreateMemoryItemResult>;
  listMemoryItems(params: ListMemoryItemsParams, options?: MemoryOptions): Promise<ListMemoryItemsResult>;
  editMemoryItem(params: EditMemoryItemParams, options?: MemoryOptions): Promise<EditMemoryItemResult>;
  getMemoryItem(params: GetMemoryItemParams, options?: MemoryOptions): Promise<GetMemoryItemResult>;
  deleteMemoryItem(params: DeleteMemoryItemParams, options?: MemoryOptions): Promise<DeleteMemoryItemResult>;

  // CDR-087 slice 1. Required members, matching every other domain surface on this runtime.
  getLatestStrategy(params: StrategyReadParams, options?: StrategyGenerationOptions): Promise<LatestStrategyResult>;
  getLatestRoadmap(params: RoadmapReadParams, options?: RoadmapGenerationOptions): Promise<LatestRoadmapResult>;
  getTaskBoard(params: GetTaskBoardParams, options?: TaskBoardOptions): Promise<GetTaskBoardResult>;
  recordStrategySelection(params: RecordStrategyDecisionParams, options?: RecordStrategyDecisionDeps): Promise<RecordStrategyDecisionResult>;
  recordDecision(params: RecordDecisionParams, options?: RecordDecisionDeps): Promise<RecordDecisionResult>;
  /** Close the owned database client (no-op when a client was injected). */
  close(): Promise<void>;
}

export function createClerkIdentityRuntime(config: ClerkIdentityRuntimeConfig, deps: ClerkIdentityRuntimeDeps = {}): ClerkIdentityRuntime {
  const ownsClient = deps.client === undefined;
  const client = deps.client ?? createDatabase(config.databaseConfig);
  const verifier = new ClerkIdentityWebhookVerifier({ config: config.clerkWebhookConfig });
  const reader = new ClerkAuthoritativeIdentityReader({ config: config.clerkConfig, expectedInstanceId: config.expectedInstanceId });
  const webhook = createIdentityWebhookService({ verifier, client });

  return {
    webhook,
    checkRequestLimit(scopeKind, scopeKey, options) {
      return checkRequestLimit(client, scopeKind, scopeKey, options ?? {});
    },
    resolveInternalUser(providerUserId, options) {
      const key: ProviderIdentityKey = { provider: 'clerk', providerInstanceId: config.expectedInstanceId, providerUserId };
      return resolveOrReconcileInternalUser(client, reader, key, options);
    },
    reconcile(options) {
      return reconcileAllUsers(client, reader, options);
    },
    ensurePersonalAccount(userId, options) {
      return provisionPersonalAccount(client, userId, options ?? {});
    },
    getAccountProfile(userId, options) {
      return getProfileForOwner(client, userId, options ?? {});
    },
    updateAccountProfile(userId, input, options) {
      return updateProfileForOwner(client, userId, input, options ?? {});
    },
    inviteMember(params, options) {
      return inviteMember(client, params, options ?? {});
    },
    acceptInvite(params, options) {
      return acceptInvite(client, params, options ?? {});
    },
    revokeMember(params, options) {
      return revokeMember(client, params, options ?? {});
    },
    listMembers(params, options) {
      return listMembers(client, params, options ?? {});
    },
    resolveAccountContext(params, options) {
      return resolveAccountContextUseCase(client, params, options ?? {});
    },
    createCompany(params, options) {
      return createCompany(client, params, options ?? {});
    },
    getCompany(params, options) {
      return getCompany(client, params, options ?? {});
    },
    renameCompany(params, options) {
      return renameCompany(client, params, options ?? {});
    },
    pauseCompany(params, options) {
      return pauseCompany(client, params, options ?? {});
    },
    resumeCompany(params, options) {
      return resumeCompany(client, params, options ?? {});
    },
    getCompanyActivity(params, options) {
      return getCompanyActivity(client, params, options ?? {});
    },
    readDecisionRoom(params, options) {
      return readDecisionRoom(client, params, options ?? {});
    },
    getCompanyPortfolio(params, options) {
      return getCompanyPortfolio(client, params, options ?? {});
    },
    getProvisioningStatus(params, options) {
      return getProvisioningStatus(client, params, options ?? {});
    },
    startInterviewSession(params, options) {
      return startInterviewSession(client, params, options ?? {});
    },
    suspendInterviewSession(params, options) {
      return suspendInterviewSession(client, params, options ?? {});
    },
    resumeInterviewSession(params, options) {
      return resumeInterviewSession(client, params, options ?? {});
    },
    getInterviewSession(params, options) {
      return getInterviewSession(client, params, options ?? {});
    },
    recordInterviewAnswer(params, options) {
      return recordInterviewAnswer(client, params, options ?? {});
    },
    getSessionQa(params, options) {
      return getSessionQa(client, params, options ?? {});
    },
    createMemoryItem(params, options) {
      return createMemoryItem(client, params, options ?? {});
    },
    listMemoryItems(params, options) {
      return listMemoryItems(client, params, options ?? {});
    },
    editMemoryItem(params, options) {
      return editMemoryItem(client, params, options ?? {});
    },
    getMemoryItem(params, options) {
      return getMemoryItem(client, params, options ?? {});
    },
    deleteMemoryItem(params, options) {
      return deleteMemoryItem(client, params, options ?? {});
    },
    getLatestStrategy(params, options) {
      return getLatestStrategyGeneration(client, params, options ?? {});
    },
    // CDR-088. THREE positional args and no `deps` slot — the arity differs per use case (recordStrategyDecision
    // below takes four), which is why each signature is read rather than assumed.
    getLatestRoadmap(params, options) {
      return getLatestRoadmap(client, params, options ?? {});
    },
    getTaskBoard(params, options) {
      return getTaskBoard(client, params, options ?? {});
    },
    recordStrategySelection(params, options) {
      return recordStrategyDecision(client, params, options ?? {});
    },
    recordDecision(params, options) {
      return recordDecision(client, params, options ?? {});
    },
    resumeProvisioning(params, options) {
      return resumeProvisioning(client, params, options ?? {});
    },
    adminReadCompanyOverview(params, options) {
      return adminReadCompanyOverview(client, params, options ?? {});
    },
    async close() {
      if (ownsClient) await closeDatabase(client);
    },
  };
}
