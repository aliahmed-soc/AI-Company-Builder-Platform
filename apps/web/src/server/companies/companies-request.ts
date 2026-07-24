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
import type { PublicErrorEnvelope, ActivityPage, PortfolioPage, ProvisioningStatusDTO, InterviewSessionDTO, AnswerDTO, SessionQADTO, MemoryItemDTO } from '@acbp/contracts';
import type { CreateCompanyResult, GetCompanyResult, RenameResult, StatusTransitionResult, GetActivityResult, GetPortfolioResult, GetProvisioningResult, ResumeProvisioningResult, CompanyView, InternalUserReconciliation, ProvisionResult, StartInterviewResult, InterviewTransitionResult, GetInterviewResult, RecordAnswerResult, GetSessionQaResult, CreateMemoryItemResult, ListMemoryItemsResult } from '@acbp/core';

export type CompaniesRequestResult =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
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
  | { readonly status: 'portfolio'; readonly page: PortfolioPage }
  | { readonly status: 'provisioning'; readonly provisioning: ProvisioningStatusDTO }
  | { readonly status: 'interview'; readonly session: InterviewSessionDTO }
  | { readonly status: 'company_not_active' }
  | { readonly status: 'answer'; readonly answer: AnswerDTO; readonly created: boolean }
  | { readonly status: 'qa'; readonly qa: SessionQADTO }
  | { readonly status: 'memory_item'; readonly item: MemoryItemDTO }
  | { readonly status: 'memory_list'; readonly items: readonly MemoryItemDTO[] };

/** The company operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface CompanyRuntime {
  resolveInternalUser(providerUserId: string): Promise<InternalUserReconciliation>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  createCompany(params: { accountId: string; actingUserId: string; creationMode: unknown; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<CreateCompanyResult>;
  getCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<GetCompanyResult>;
  renameCompany(params: { userId: string; accountId: string; companyId: string; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<RenameResult>;
  pauseCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
  resumeCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
  getCompanyActivity(params: { userId: string; accountId: string; companyId: string; cursor?: unknown; limit?: unknown }, options?: { logger?: Logger }): Promise<GetActivityResult>;
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
  listMemoryItems(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<ListMemoryItemsResult>;
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

export async function listMemoryForRequest(companyId: string, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.listMemoryItems({ userId: ctx.userId, accountId: ctx.accountId, companyId }, { logger: companiesLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'memory_list', items: r.items };
    case 'forbidden':
      return { status: 'forbidden' };
  }
}
