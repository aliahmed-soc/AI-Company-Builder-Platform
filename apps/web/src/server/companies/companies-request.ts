// ACBP-P1-010 — authenticated company-management request use cases (apps/web).
//
// Orchestrates the ADR-022 flow for the companies surface: resolve the SERVER-VERIFIED identity → internal
// user → the caller's OWN account, then create/read/rename/pause/resume. The acting user is always the
// session user; the account is the caller's own personal account; the companyId is a REQUEST selector that
// @acbp/core validates against an active company membership (never trusted on its own). Owner-only lifecycle
// authorization is enforced inside @acbp/core from the company role — never from a request field. All domain
// access goes through @acbp/core (no @acbp/database / @acbp/adapters import here).
import { resolveVerifiedIdentity, type VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import type { RequestLimitOutcome } from '@acbp/core';
import type { PublicErrorEnvelope, ActivityPage, DecisionRoomView, PortfolioPage, ProvisioningStatusDTO, InterviewSessionDTO, AnswerDTO, SessionQADTO, MemoryItemDTO } from '@acbp/contracts';
import type { ReadDecisionRoomResult } from '@acbp/core';
import type { CreateCompanyResult, GetCompanyResult, RenameResult, StatusTransitionResult, GetActivityResult, GetPortfolioResult, GetProvisioningResult, ResumeProvisioningResult, CompanyView, InternalUserReconciliation, ProvisionResult, StartInterviewResult, InterviewTransitionResult, GetInterviewResult, RecordAnswerResult, GetSessionQaResult, CreateMemoryItemResult, ListMemoryItemsResult, EditMemoryItemResult, GetMemoryItemResult, DeleteMemoryItemResult, LatestStrategyResult, LatestRoadmapResult, RoadmapReadParams, RoadmapGenerationOptions, GetTaskBoardResult, GetTaskBoardParams, TaskBoardOptions, GetTaskDetailResult, GetTaskDetailParams, TaskOptions, ArtifactDTO, PersistArtifactOptions, ReadLineageResult, ReadLineageParams, ReadLineageOptions, ListApprovalInboxParams, ListApprovalInboxResult, ApprovalServiceOptions, EditRoadmapParams, EditRoadmapResult, RoadmapEditOptions, GetTaskRunParams, GetTaskRunResult, ListTaskRunsParams, ListTaskRunsResult, RunReadOptions, RecordStrategyDecisionResult, RecordDecisionResult, StrategyReadParams, StrategyGenerationOptions, RecordStrategyDecisionParams, RecordStrategyDecisionDeps, RecordDecisionParams, RecordDecisionDeps } from '@acbp/core';

export type CompaniesRequestResult =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 §8's request ceiling refused this call (ACBP-P7-013; CDR-082; NFR-010). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'unavailable' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope }
  | { readonly status: 'invalid_transition'; readonly from: string }
  | { readonly status: 'conflict' }
  | { readonly status: 'invalid_cursor' }
  | { readonly status: 'invalid_limit' }
  | { readonly status: 'created'; readonly companyId: string; readonly companyStatus: string; readonly creationMode: string }
  | { readonly status: 'company'; readonly company: CompanyView }
  | { readonly status: 'renamed'; readonly changed: boolean; readonly version?: number }
  | { readonly status: 'transitioned'; readonly companyStatus: string }
  | { readonly status: 'activity'; readonly page: ActivityPage }
  | { readonly status: 'decision_room'; readonly room: DecisionRoomView }
  | { readonly status: 'portfolio'; readonly page: PortfolioPage }
  | { readonly status: 'provisioning'; readonly provisioning: ProvisioningStatusDTO }
  | { readonly status: 'interview'; readonly session: InterviewSessionDTO }
  | { readonly status: 'company_not_active' }
  | { readonly status: 'answer'; readonly answer: AnswerDTO; readonly created: boolean }
  | { readonly status: 'qa'; readonly qa: SessionQADTO }
  | { readonly status: 'memory_item'; readonly item: MemoryItemDTO }
  | { readonly status: 'memory_list'; readonly items: readonly MemoryItemDTO[] }
  | { readonly status: 'memory_edited'; readonly item: MemoryItemDTO }
  | { readonly status: 'memory_item_single'; readonly item: MemoryItemDTO }
  | { readonly status: 'memory_deleted'; readonly memoryItemId: string }
  /**
   * CDR-087 §5.0 — the company's latest strategy generation, or NULL when none exists. Null is a SUCCESS, not a
   * not-found: the company exists and the caller may read it, there is simply nothing generated yet (G9).
   */
  | { readonly status: 'strategy'; readonly generation: Extract<LatestStrategyResult, { status: 'ok' }>['generation'] }
  // CDR-088. Payload type DERIVED from core's result, never copied — a hand-written shape drifts the first time
  // core changes and nothing catches it.
  | { readonly status: 'roadmap'; readonly roadmap: Extract<LatestRoadmapResult, { status: 'ok' }>['roadmap'] }
  // CDR-088. `board` is NOT nullable — an empty board is still a board, so there is no absent-carrying-null
  // case here and none is invented for symmetry with the roadmap read above.
  | { readonly status: 'tasks'; readonly board: Extract<GetTaskBoardResult, { status: 'ok' }>['board'] }
  | { readonly status: 'task'; readonly task: Extract<GetTaskDetailResult, { status: 'ok' }>['task'] }
  // CDR-088 §2.1a. `getArtifact` and `listRunArtifacts` return BARE unions carrying string literals, not the
  // tagged shape everything else here uses, so the payload types are derived with `Exclude<…, string>` rather
  // than `Extract<…, {status:'ok'}>`. Hand-copying ArtifactDTO would drift the moment core changes.
  | { readonly status: 'artifact'; readonly artifact: Exclude<Awaited<ReturnType<CompanyRuntime['getArtifact']>>, string> }
  | { readonly status: 'artifacts'; readonly artifacts: Exclude<Awaited<ReturnType<CompanyRuntime['listRunArtifacts']>>, string> }
  | { readonly status: 'lineage'; readonly lineage: Extract<ReadLineageResult, { status: 'ok' }> }
  | { readonly status: 'approvals'; readonly approvals: readonly ApprovalInboxItem[] }
  // CDR-088. `flaggedTaskCount` travels WITH the roadmap deliberately: ROAD-002 flags tasks the edit invalidated,
  // and a client that saw the new plan without learning how many tasks it disturbed would under-report the
  // consequence of the owner's own edit.
  | {
      readonly status: 'roadmap_edited';
      readonly roadmap: Extract<EditRoadmapResult, { status: 'ok' }>['roadmap'];
      readonly flaggedTaskCount: number;
    }
  | { readonly status: 'stale_version' }
  | { readonly status: 'decision_rejected' }
  // CDR-089. The run DTO is an ALLOWLIST built in core, so this layer forwards it rather than re-shaping it —
  // re-mapping here would create a second field list to keep in step with `task_runs`, which is exactly the
  // drift the allowlist exists to prevent.
  | { readonly status: 'run'; readonly run: Extract<GetTaskRunResult, { status: 'ok' }>['run'] }
  | { readonly status: 'runs'; readonly runs: Extract<ListTaskRunsResult, { status: 'ok' }>['runs'] }
  | { readonly status: 'strategy_selected'; readonly selection: Extract<RecordStrategyDecisionResult, { status: 'ok' }>['selection'] }
  | { readonly status: 'decision_recorded'; readonly decision: Extract<RecordDecisionResult, { status: 'ok' }>['decision'] };

/** The company operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface CompanyRuntime {
  /**
   * Consume one request against CDR-008 section 8's per-ACCOUNT ceiling (ACBP-P7-013; CDR-082).
   *
   * REQUIRED on this interface, never optional: the session ceiling alone does not bound a user holding many
   * sessions, which is precisely why section 8 rules two layers rather than one (CDR-082 section 6.4). A fake
   * runtime in a test must declare it, so no surface can be admitted by forgetting it.
   */
  checkRequestLimit(scopeKind: 'session' | 'account', scopeKey: string): Promise<RequestLimitOutcome>;

  resolveInternalUser(providerUserId: string): Promise<InternalUserReconciliation>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  createCompany(params: { accountId: string; actingUserId: string; creationMode: unknown; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<CreateCompanyResult>;
  getCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<GetCompanyResult>;
  renameCompany(params: { userId: string; accountId: string; companyId: string; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<RenameResult>;
  pauseCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
  resumeCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
  getCompanyActivity(params: { userId: string; accountId: string; companyId: string; cursor?: unknown; limit?: unknown }, options?: { logger?: Logger }): Promise<GetActivityResult>;
  readDecisionRoom(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<ReadDecisionRoomResult>;
  getCompanyPortfolio(params: { userId: string; accountId: string; cursor?: unknown; limit?: unknown }, options?: { logger?: Logger }): Promise<GetPortfolioResult>;
  getProvisioningStatus(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<GetProvisioningResult>;
  resumeProvisioning(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<ResumeProvisioningResult>;
  startInterviewSession(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<StartInterviewResult>;
  suspendInterviewSession(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<InterviewTransitionResult>;
  resumeInterviewSession(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<InterviewTransitionResult>;
  getInterviewSession(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<GetInterviewResult>;
  recordInterviewAnswer(params: { userId: string; accountId: string; companyId: string; sessionId: string; questionId: string; status: unknown; content?: unknown }, options?: { logger?: Logger }): Promise<RecordAnswerResult>;
  getSessionQa(params: { userId: string; accountId: string; companyId: string; sessionId: string }, options?: { logger?: Logger }): Promise<GetSessionQaResult>;
  createMemoryItem(params: { userId: string; accountId: string; companyId: string; type: unknown; content: unknown; sourceType: unknown; sourceRef: unknown; confidence?: unknown }, options?: { logger?: Logger }): Promise<CreateMemoryItemResult>;
  listMemoryItems(params: { userId: string; accountId: string; companyId: string; type?: unknown; currentOnly?: boolean }, options?: { logger?: Logger }): Promise<ListMemoryItemsResult>;
  editMemoryItem(params: { userId: string; accountId: string; companyId: string; targetId: string; type: unknown; content: unknown; confidence?: unknown }, options?: { logger?: Logger }): Promise<EditMemoryItemResult>;
  getMemoryItem(params: { userId: string; accountId: string; companyId: string; memoryItemId: string }, options?: { logger?: Logger }): Promise<GetMemoryItemResult>;
  deleteMemoryItem(params: { userId: string; accountId: string; companyId: string; memoryItemId: string }, options?: { logger?: Logger }): Promise<DeleteMemoryItemResult>;

  // CDR-087 — strategy read and decision recording. REQUIRED, never optional, for the reason recorded on
  // `checkRequestLimit`: a fake runtime must declare every surface, so none is admitted by being forgotten.
  getLatestStrategy(params: StrategyReadParams, options?: StrategyGenerationOptions): Promise<LatestStrategyResult>;
  // REQUIRED, not optional (CDR-088 §2.1): an optional method lets a runtime that never implements it ship
  // silently. Missing it must be a compile error.
  getLatestRoadmap(params: RoadmapReadParams, options?: RoadmapGenerationOptions): Promise<LatestRoadmapResult>;
  getTaskBoard(params: GetTaskBoardParams, options?: TaskBoardOptions): Promise<GetTaskBoardResult>;
  getTaskDetail(params: GetTaskDetailParams, options?: TaskOptions): Promise<GetTaskDetailResult>;
  getArtifact(params: { userId: string; accountId: string; companyId: string; artifactId: string }, options?: PersistArtifactOptions): Promise<ArtifactDTO | 'forbidden' | 'not_found'>;
  listRunArtifacts(params: { userId: string; accountId: string; companyId: string; runId: string }, options?: PersistArtifactOptions): Promise<readonly ArtifactDTO[] | 'forbidden'>;
  readArtifactLineage(params: ReadLineageParams, options?: ReadLineageOptions): Promise<ReadLineageResult>;
  listApprovalInbox(params: ListApprovalInboxParams, options?: ApprovalServiceOptions): Promise<ListApprovalInboxResult>;
  editRoadmap(params: EditRoadmapParams, options?: RoadmapEditOptions): Promise<EditRoadmapResult>;
  getTaskRun(params: GetTaskRunParams, options?: RunReadOptions): Promise<GetTaskRunResult>;
  listTaskRuns(params: ListTaskRunsParams, options?: RunReadOptions): Promise<ListTaskRunsResult>;
  recordStrategySelection(params: RecordStrategyDecisionParams, options?: RecordStrategyDecisionDeps): Promise<RecordStrategyDecisionResult>;
  recordDecision(params: RecordDecisionParams, options?: RecordDecisionDeps): Promise<RecordDecisionResult>;
}

export interface CompaniesRequestDeps {
  readonly identity?: VerifiedIdentityDeps;
  readonly runtime?: CompanyRuntime;
}

type Actor = { readonly kind: 'actor'; readonly userId: string };
type Early = { readonly kind: 'result'; readonly result: CompaniesRequestResult };

function companiesLogger(): Logger {
  return createLogger({ component: 'companies', context: createRootContext() });
}

async function runtimeOf(deps: CompaniesRequestDeps): Promise<CompanyRuntime> {
  if (deps.runtime !== undefined) return deps.runtime;
  const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
  return getClerkIdentityRuntime();
}

/** Resolve the server-verified actor (internal user id), or an early mapped result. */
async function resolveActor(deps: CompaniesRequestDeps, runtime: CompanyRuntime): Promise<Actor | Early> {
  const identity = await resolveVerifiedIdentity(deps.identity);
  if (identity.status === 'unauthenticated') return { kind: 'result', result: { status: 'unauthenticated' } };
  if (identity.status === 'email_unverified') return { kind: 'result', result: { status: 'email_unverified' } };
  if (identity.status === 'rate_limited') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: identity.retryAfterSeconds } };
  if (identity.status === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };

  const resolution = await runtime.resolveInternalUser(identity.identity.providerUserId);
  switch (resolution.status) {
    case 'active':
      return { kind: 'actor', userId: resolution.userId };
    case 'deleted':
      return { kind: 'result', result: { status: 'forbidden' } };
    case 'not_found':
      return { kind: 'result', result: { status: 'not_found' } };
    case 'unavailable':
      return { kind: 'result', result: { status: 'unavailable' } };
  }
}

/** Resolve the actor AND ensure their personal account exists; returns { userId, accountId } or an early result. */
async function resolveActorWithAccount(deps: CompaniesRequestDeps, runtime: CompanyRuntime): Promise<{ userId: string; accountId: string } | Early> {
  const actor = await resolveActor(deps, runtime);
  if (actor.kind === 'result') return actor;
  const provision = await runtime.ensurePersonalAccount(actor.userId, { logger: companiesLogger() });
  // The ACCOUNT ceiling, checked at the earliest point the account id exists (CDR-008 section 8; CDR-082).
  const limit = await runtime.checkRequestLimit('account', provision.accountId);
  if (limit.kind === 'throttled') return { kind: 'result', result: { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds } };
  if (limit.kind === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };
  return { userId: actor.userId, accountId: provision.accountId };
}

export async function createCompanyForRequest(input: { creationMode: unknown; name: unknown; description?: unknown }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.createCompany({ accountId: ctx.accountId, actingUserId: ctx.userId, creationMode: input.creationMode, name: input.name, description: input.description }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'created', companyId: r.companyId, companyStatus: r.companyStatus, creationMode: r.creationMode };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

export async function getCompanyForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getCompany({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'company', company: r.company };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

export async function renameCompanyForRequest(companyId: string, input: { name: unknown; description?: unknown }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.renameCompany({ userId: ctx.userId, accountId: ctx.accountId, companyId, name: input.name, description: input.description }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return r.version !== undefined ? { status: 'renamed', changed: r.changed, version: r.version } : { status: 'renamed', changed: r.changed };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'conflict':
      return { status: 'conflict' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

async function transitionForRequest(kind: 'pause' | 'resume', companyId: string, deps: CompaniesRequestDeps): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const params = { userId: ctx.userId, accountId: ctx.accountId, companyId };
  const r = kind === 'pause' ? await runtime.pauseCompany(params, { logger: companiesLogger() }) : await runtime.resumeCompany(params, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'transitioned', companyStatus: r.companyStatus };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'invalid_transition':
      return { status: 'invalid_transition', from: r.from };
  }
}

// Read a page of the company activity feed. `cursor`/`limit` come from the query string (raw; the domain
// validates + clamps). accountId + actingUserId are server-resolved; companyId is a membership-validated selector.
export async function getCompanyActivityForRequest(companyId: string, query: { cursor?: string; limit?: string }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getCompanyActivity({ userId: ctx.userId, accountId: ctx.accountId, companyId, cursor: query.cursor, limit: query.limit }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'activity', page: r.page };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'invalid_cursor':
      return { status: 'invalid_cursor' };
  }
}

/**
 * Read the Decision Room (ACBP-P6-008; DEC-001). accountId + userId are server-resolved; companyId is a
 * membership-validated selector. There is no query surface at all: no filters, no cursor, no section selector,
 * because the room's whole claim is that the ten queues are shown TOGETHER and that a caller cannot be handed a
 * subset that looks complete.
 */
export async function getDecisionRoomForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.readDecisionRoom({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'decision_room', room: r.room };
    case 'forbidden':
      // There is no `not_found` arm to map: the domain answers an unknown, foreign and unauthorized company
      // identically, so this surface cannot become a company-existence oracle.
      return { status: 'forbidden' };
  }
}

// Read a page of the caller's company portfolio (ACBP-P1-011; CDR-017). `cursor`/`limit` come from the query
// string (raw; the domain validates — invalid limit REJECTED, not clamped). accountId + userId are server-
// resolved (the caller's OWN account); the listing is filtered to the actor's ACTIVE company memberships.
export async function getPortfolioForRequest(query: { cursor?: string; limit?: string }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getCompanyPortfolio({ userId: ctx.userId, accountId: ctx.accountId, cursor: query.cursor, limit: query.limit }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'portfolio', page: r.page };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'invalid_cursor':
      return { status: 'invalid_cursor' };
    case 'invalid_limit':
      return { status: 'invalid_limit' };
  }
}

// Workspace provisioning (ACBP-P1-012; CDR-018). Status read = any active company member; resume = company owner
// only (the domain enforces both from the fresh company role). companyId is a membership-validated selector;
// accountId + userId are server-resolved. No caller input beyond the route's companyId reaches the domain.
export async function getProvisioningForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getProvisioningStatus({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'provisioning', provisioning: r.provisioning };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

export async function resumeProvisioningForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.resumeProvisioning({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'provisioning', provisioning: r.provisioning };
    case 'conflict':
      return { status: 'conflict' };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

// Pause/resume carry NO request body — the transition fact is the whole payload; no caller-supplied free-text
// reason is accepted or persisted (security review LOW-1).
export function pauseCompanyForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return transitionForRequest('pause', companyId, deps);
}
export function resumeCompanyForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return transitionForRequest('resume', companyId, deps);
}

// Interview sessions (ACBP-P2-001; CDR-022). participate/read = any active company member (the domain enforces
// it from the fresh company role). companyId is a membership-validated selector; accountId + userId are
// server-resolved. NO request body — the action is the whole payload (like pause/resume). start returns the
// company's (possibly pre-existing) open session; suspend/resume are the exact-resume transitions; get reads it.
export async function startInterviewForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.startInterviewSession({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'interview', session: r.session };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'company_not_active':
      return { status: 'company_not_active' };
  }
}

async function interviewTransitionForRequest(kind: 'suspend' | 'resume', companyId: string, deps: CompaniesRequestDeps): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const params = { userId: ctx.userId, accountId: ctx.accountId, companyId };
  const r = kind === 'suspend' ? await runtime.suspendInterviewSession(params, { logger: companiesLogger() }) : await runtime.resumeInterviewSession(params, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'interview', session: r.session };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'invalid_transition':
      return { status: 'invalid_transition', from: r.from };
  }
}

export function suspendInterviewForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return interviewTransitionForRequest('suspend', companyId, deps);
}
export function resumeInterviewForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return interviewTransitionForRequest('resume', companyId, deps);
}

export async function getInterviewForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getInterviewSession({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'interview', session: r.session };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

// Q&A persistence (ACBP-P2-002; CDR-023). The operations target the company's OPEN interview session (resolved
// via getInterviewSession — a null/no session collapses to not_found), so the client never supplies a session
// id. participate/read = any active company member (enforced in @acbp/core). accountId + userId are
// server-resolved; companyId + questionId are membership-validated selectors.
type ResolvedSession = { readonly userId: string; readonly accountId: string; readonly sessionId: string } | Early;
async function resolveActorAccountSession(companyId: string, deps: CompaniesRequestDeps): Promise<ResolvedSession> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx;
  const session = await runtime.getInterviewSession({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (session.status) {
    case 'ok':
      return { userId: ctx.userId, accountId: ctx.accountId, sessionId: session.session.sessionId };
    case 'forbidden':
      return { kind: 'result', result: { status: 'forbidden' } };
    case 'not_found':
      return { kind: 'result', result: { status: 'not_found' } };
  }
}

export async function recordAnswerForRequest(companyId: string, questionId: string, input: { status: unknown; content?: unknown }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const s = await resolveActorAccountSession(companyId, deps);
  if ('kind' in s) return s.result;
  const runtime = await runtimeOf(deps);
  const r = await runtime.recordInterviewAnswer({ userId: s.userId, accountId: s.accountId, companyId, sessionId: s.sessionId, questionId, status: input.status, content: input.content }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'answer', answer: r.answer, created: r.created };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

export async function getQaForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const s = await resolveActorAccountSession(companyId, deps);
  if ('kind' in s) return s.result;
  const runtime = await runtimeOf(deps);
  const r = await runtime.getSessionQa({ userId: s.userId, accountId: s.accountId, companyId, sessionId: s.sessionId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'qa', qa: r.qa };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

// Typed memory (ACBP-P2-006; CDR-024). accountId + userId are server-resolved; companyId is a membership-
// validated selector. The type is set by the source path (a generated claim can never become a user_fact —
// enforced in @acbp/core). write/read = any active company member.
export async function createMemoryForRequest(companyId: string, input: { type: unknown; content: unknown; sourceType: unknown; sourceRef: unknown; confidence: unknown }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.createMemoryItem({ userId: ctx.userId, accountId: ctx.accountId, companyId, type: input.type, content: input.content, sourceType: input.sourceType, sourceRef: input.sourceRef, confidence: input.confidence }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_item', item: r.item };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

export async function listMemoryForRequest(companyId: string, filter: { type?: unknown; currentOnly?: boolean } = {}, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const params: { userId: string; accountId: string; companyId: string; type?: unknown; currentOnly?: boolean } = { userId: ctx.userId, accountId: ctx.accountId, companyId };
  if (filter.type !== undefined) params.type = filter.type;
  if (filter.currentOnly === true) params.currentOnly = true;
  const r = await runtime.listMemoryItems(params, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_list', items: r.items };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

export async function getMemoryForRequest(companyId: string, memoryItemId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getMemoryItem({ userId: ctx.userId, accountId: ctx.accountId, companyId, memoryItemId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_item_single', item: r.item };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

// Edit = a versioned supersede (owner-only, enforced in @acbp/core). accountId + userId server-resolved;
// companyId + memoryItemId are membership-validated selectors; the body is the corrected {type, content, confidence?}.
export async function editMemoryForRequest(companyId: string, memoryItemId: string, input: { type: unknown; content: unknown; confidence: unknown }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.editMemoryItem({ userId: ctx.userId, accountId: ctx.accountId, companyId, targetId: memoryItemId, type: input.type, content: input.content, confidence: input.confidence }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_edited', item: r.item };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'conflict':
      return { status: 'conflict' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

// Delete = a soft delete (owner-only, enforced in @acbp/core). account/actor server-resolved; companyId +
// memoryItemId are membership-validated selectors; no request body.
export async function deleteMemoryForRequest(companyId: string, memoryItemId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.deleteMemoryItem({ userId: ctx.userId, accountId: ctx.accountId, companyId, memoryItemId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_deleted', memoryItemId: r.memoryItemId };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'conflict':
      return { status: 'conflict' };
  }
}

/**
 * Read the company's latest strategy generation (CDR-087; STRAT-001; `strategy:read` → owner + viewer).
 *
 * NO AUTHORIZATION CHECK HERE, DELIBERATELY (CDR-087 §1). `@acbp/core` decides from the company role resolved
 * against an active membership. A second place answering the same question is the defect ACBP-P6-002 paid to
 * remove when the caller-injectable approval port was deleted, and the copy here is the one no test of the
 * registry would cover.
 *
 * `LatestStrategyResult` has TWO arms only — there is no `not_found` to map, because an unknown, foreign or
 * unauthorized company is answered identically by scope resolution.
 */
export async function getStrategyForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  // No logger option here: StrategyGenerationOptions carries correlationId and two TEST SEAMS only, so passing
  // one would not compile. The use case builds its own logger internally.
  const r = await runtime.getLatestStrategy({ userId: ctx.userId, accountId: ctx.accountId, companyId }, {});
  switch (r.status) {
    case 'ok':
      // `generation` may be null. That is G9: an absent generation is a success carrying null.
      return { status: 'strategy', generation: r.generation };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

/**
 * The company's current roadmap (CDR-088; `roadmap:read`, enforced in `@acbp/core`).
 *
 * NO AUTHORIZATION CHECK HERE — CDR-088 §1, inherited verbatim from CDR-087 §1. Core decides from the company
 * role; a second authority answering the same question is the defect ACBP-P6-002 paid to remove.
 *
 * `LatestRoadmapResult` has TWO arms and a NULLABLE payload, exactly like the strategy read. An absent roadmap is
 * a success carrying null, never a not-found: the company exists and the caller may read it, there is simply
 * nothing planned yet. Mapping that to 404 is how a UI shows an error page on a normal first visit.
 *
 * A correlationId IS threaded here (CDR-088 §6). The strategy read omits one, which makes it less traceable in
 * the logs than the writes beside it — that is the open slice-1 finding, and it is not repeated.
 */
export async function getRoadmapForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getLatestRoadmap({ userId: ctx.userId, accountId: ctx.accountId, companyId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'roadmap', roadmap: r.roadmap };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

/**
 * The company's task board (CDR-088; `task:read`, enforced in `@acbp/core`).
 *
 * NO AUTHORIZATION CHECK HERE — CDR-088 §1. Core decides from the company role.
 *
 * `GetTaskBoardResult` has two arms and a NON-nullable payload: an empty board is still a board, so unlike the
 * roadmap read there is no absent-carrying-null case, and none is invented for symmetry.
 */
export async function getTaskBoardForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getTaskBoard({ userId: ctx.userId, accountId: ctx.accountId, companyId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'tasks', board: r.board };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

/**
 * One task's detail (CDR-088; `task:read`, enforced in `@acbp/core`).
 *
 * NO AUTHORIZATION CHECK HERE — CDR-088 §1.
 *
 * THREE arms, and `not_found` stays DISTINCT from `forbidden` (§5). They answer at different granularities:
 * `forbidden` is the company-level refusal, where a foreign and an unknown company are indistinguishable;
 * `not_found` is the task-level one, where a foreign and an unknown task id are equally indistinguishable because
 * RLS makes another company's row invisible rather than denied. Collapsing the two would discard the difference
 * between "not yours" and "not there", which the client legitimately needs.
 */
export async function getTaskDetailForRequest(companyId: string, taskId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getTaskDetail({ userId: ctx.userId, accountId: ctx.accountId, companyId, taskId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'task', task: r.task };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

/**
 * Revise the company's current roadmap (CDR-088; ROAD-002; owner-only, enforced in `@acbp/core`).
 *
 * THE ONLY STATE-CHANGING ROUTE IN SLICE 2, and the only one with SIX result arms. Three of them are refusals
 * that are NOT interchangeable, and mapping them to one status would destroy information the caller acts on:
 *
 * - `stale_version` — the owner edited a view that is no longer current. Nothing was written; the fix is
 *   re-read and retry. A client shown a generic error would have no way to know retrying is the right move.
 * - `decision_rejected` — the company's latest decision REJECTED the strategy, and an edit authors the new
 *   current plan, so it is gated exactly like generation (CDR-039 §7-G1). Otherwise a rejection could be
 *   side-stepped by editing. Retrying will never help; the strategy decision has to change first.
 * - `not_found` — no such roadmap, at the sub-resource granularity.
 *
 * The body is PARSED, NOT VALIDATED here: `plan` is a string the domain's deny-by-default parser judges, and
 * `reason` is typed `unknown` in the contract precisely so the domain rules on it. Re-checking either here would
 * create the second authority §1 forbids.
 */
export async function editRoadmapForRequest(
  companyId: string,
  body: { readonly expectedRoadmapId: string; readonly plan: string; readonly reason: unknown },
  deps: CompaniesRequestDeps = {},
): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.editRoadmap(
    { userId: ctx.userId, accountId: ctx.accountId, companyId, expectedRoadmapId: body.expectedRoadmapId, plan: body.plan, reason: body.reason },
    {},
  );
  switch (r.status) {
    case 'ok':
      return { status: 'roadmap_edited', roadmap: r.roadmap, flaggedTaskCount: r.flaggedTaskCount };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'stale_version':
      return { status: 'stale_version' };
    case 'decision_rejected':
      return { status: 'decision_rejected' };
    case 'invalid':
      // The domain validated and refused; nothing was persisted, and no field is echoed back.
      return { status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'The roadmap edit was rejected.', retryable: false } };
  }
}

/**
 * One run's detail (CDR-089; `run:read` → owner + viewer, enforced in `@acbp/core`).
 *
 * NO AUTHORIZATION CHECK HERE — CDR-088 §1, which CDR-089 inherits. Core decides from the company role.
 *
 * `not_found` stays DISTINCT from `forbidden`: company-level refusal versus run-level. Within each granularity a
 * foreign id and an unknown one are indistinguishable, enforced by RLS rather than by a decision in this layer —
 * which is why CDR-089 §5 spends no mutation runs on it.
 */
export async function getTaskRunForRequest(companyId: string, runId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getTaskRun({ userId: ctx.userId, accountId: ctx.accountId, companyId, runId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'run', run: r.run };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
  }
}

/**
 * Every run of one task, newest first (CDR-089; `run:read`).
 *
 * TWO arms only — there is NO `not_found`, and that is CDR-089 §3 rather than an omission. `listForTask` cannot
 * distinguish an unknown task from a task with no runs; both are an empty list. Inventing a 404 here would claim
 * a distinction the query does not make. A caller needing that difference reads the task, which has its own.
 */
export async function listTaskRunsForRequest(companyId: string, taskId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.listTaskRuns({ userId: ctx.userId, accountId: ctx.accountId, companyId, taskId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'runs', runs: r.runs };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

/**
 * What an approval request looks like ON THE WIRE.
 *
 * WRITTEN AS AN ALLOWLIST, NOT A REDACTION, AND THAT IS THE POINT. `listApprovalInbox` returns
 * `ApprovalRequestRow`, which is `Selectable<ApprovalRequestsTable>` — every column of the table, including any
 * column added to it in future. Spreading a row and deleting the unwanted keys would silently publish the next
 * column somebody adds. Naming the fields means a new column is invisible here until a human adds it.
 *
 * DELIBERATELY ABSENT, each for a reason:
 * - `data` — `ColumnType<unknown, …>`, the raw tool payload. Arbitrary content, the single highest leak risk on
 *   this table, and nothing an inbox list needs to render.
 * - `account_id`, `company_id` — internal scoping. The caller already knows which company they asked about, and
 *   echoing tenant ids back is how they end up in client logs and URLs.
 * - `run_id` — an internal execution id the caller cannot read anyway; there is no run-read route (ACBP-API-003).
 * - `policy_id`, `policy_version` — evaluation-point machinery, not a decision the approver makes.
 */
export interface ApprovalInboxItem {
  readonly approvalRequestId: string;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly preview: string;
  readonly riskClass: string;
  readonly reversibility: string;
  readonly scope: string;
  readonly estimatedCostCredits: number;
  readonly toolId: string;
  readonly toolVersion: number;
}

/**
 * The approvals awaiting a human in this company (CDR-088; enforced in `@acbp/core`).
 *
 * The mapper below is the ONLY thing standing between a raw database row and the wire — see `ApprovalInboxItem`.
 */
export async function listApprovalInboxForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.listApprovalInbox({ userId: ctx.userId, accountId: ctx.accountId, companyId }, {});
  switch (r.status) {
    case 'ok':
      return {
        status: 'approvals',
        approvals: r.requests.map((row) => ({
          approvalRequestId: row.id,
          action: row.action,
          reason: row.reason,
          expectedResult: row.expected_result,
          preview: row.preview,
          riskClass: row.risk_class,
          reversibility: row.reversibility,
          scope: row.scope,
          estimatedCostCredits: row.estimated_cost_credits,
          toolId: row.tool_id,
          toolVersion: row.tool_version,
        })),
      };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}

/**
 * One artifact (CDR-088 §2.1a; `artifact:read`, enforced in `@acbp/core`).
 *
 * THE REFUSAL IS A BARE STRING, NOT A TAGGED ARM, AND THAT IS THE WHOLE RISK HERE. `getArtifact` resolves to
 * `ArtifactDTO | 'forbidden' | 'not_found'`. If this adapter failed to check, `'forbidden'` would be serialized
 * into a 200 body AS THOUGH IT WERE THE ARTIFACT — a defect the tagged convention makes impossible on every
 * other route in this programme, and which only this function prevents. The string check therefore comes FIRST,
 * before anything touches the value as a DTO.
 */
export async function getArtifactForRequest(companyId: string, artifactId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.getArtifact({ userId: ctx.userId, accountId: ctx.accountId, companyId, artifactId }, {});
  if (r === 'forbidden') return { status: 'forbidden' };
  if (r === 'not_found') return { status: 'not_found' };
  return { status: 'artifact', artifact: r };
}

/**
 * Every artifact produced by one run (CDR-088 §2.1a).
 *
 * `listRunArtifacts` resolves to `readonly ArtifactDTO[] | 'forbidden'` and has NO `not_found` arm. An unknown
 * run id and a real run with zero artifacts are therefore INDISTINGUISHABLE — both are an empty array. That is
 * oracle-safe by construction, but it means this route cannot honestly 404 an unknown run, and it does not
 * pretend to. Distinguishing them would need a run read, which is ACBP-API-003.
 */
export async function listRunArtifactsForRequest(companyId: string, runId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.listRunArtifacts({ userId: ctx.userId, accountId: ctx.accountId, companyId, runId }, {});
  if (r === 'forbidden') return { status: 'forbidden' };
  return { status: 'artifacts', artifacts: r };
}

/**
 * An artifact's lineage — what it was revised from, and what revised it (CDR-088).
 *
 * `readArtifactLineage` IS tagged, unlike its two neighbours, so it is mapped by `status` like every other route.
 * The inconsistency is core's, not this layer's; §2.1a records the decision to adapt rather than normalize.
 */
export async function readArtifactLineageForRequest(companyId: string, artifactId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.readArtifactLineage({ userId: ctx.userId, accountId: ctx.accountId, companyId, artifactId }, {});
  switch (r.status) {
    case 'ok':
      return { status: 'lineage', lineage: r };
    case 'forbidden':
      return { status: 'forbidden' };
    // Core names this arm `artifact_not_found`, not `not_found` — a THIRD naming divergence in the artifacts
    // area, after the two bare unions. It is normalized to the boundary's `not_found` here so the HTTP surface
    // stays uniform; the compiler caught the wrong guess rather than letting it through.
    case 'artifact_not_found':
      return { status: 'not_found' };
  }
}

/**
 * Record a strategy decision — select / edit / combine / reject (CDR-087; STRAT-005; `strategy:select` → OWNER
 * ONLY). The owner-only rule lives in `@acbp/core`; see §1 above for why it is not repeated here.
 *
 * FOUR arms, and `forbidden` and `not_found` stay DISTINCT (§5.1 G8). They speak at different granularities:
 * `forbidden` is the company-level refusal, where a foreign and an unknown company id are indistinguishable;
 * `not_found` is the sub-resource level, where a foreign and an unknown selection id are equally
 * indistinguishable because RLS makes another company's row invisible rather than denied.
 */
export async function recordStrategySelectionForRequest(
  companyId: string,
  body: Pick<RecordStrategyDecisionParams, 'generationId' | 'request'>,
  deps: CompaniesRequestDeps = {},
): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.recordStrategySelection({ userId: ctx.userId, accountId: ctx.accountId, companyId, generationId: body.generationId, request: body.request }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'strategy_selected', selection: r.selection };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'invalid':
      // The domain validated and refused; nothing was persisted. No field is echoed back.
      return { status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'The decision was rejected.', retryable: false } };
  }
}

/** Record the decision that follows a strategy selection (CDR-087; `decision:record` → OWNER ONLY). Same four-arm
 * shape and the same §1 rule: core decides, this layer maps. */
export async function recordDecisionForRequest(
  companyId: string,
  body: Pick<RecordDecisionParams, 'generationId' | 'selectionId' | 'rationale'>,
  deps: CompaniesRequestDeps = {},
): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  // `rationale` is spread conditionally: it is optional in the contract and a missing one must never block the
  // record (CDR-038 §6-G2), so an explicit `undefined` key is not the same thing as its absence.
  const r = await runtime.recordDecision(
    { userId: ctx.userId, accountId: ctx.accountId, companyId, generationId: body.generationId, selectionId: body.selectionId, ...(body.rationale !== undefined ? { rationale: body.rationale } : {}) },
    { logger: companiesLogger() },
  );
  switch (r.status) {
    case 'ok':
      return { status: 'decision_recorded', decision: r.decision };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'invalid':
      return { status: 'validation', error: { category: 'validation', code: 'VALIDATION_FAILED', message: 'The decision was rejected.', retryable: false } };
  }
}
