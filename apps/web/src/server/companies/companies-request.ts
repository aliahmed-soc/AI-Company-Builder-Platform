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
import type { PublicErrorEnvelope } from '@acbp/contracts';
import type { CreateCompanyResult, GetCompanyResult, RenameResult, StatusTransitionResult, CompanyView, InternalUserReconciliation, ProvisionResult } from '@acbp/core';

export type CompaniesRequestResult =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope }
  | { readonly status: 'invalid_transition'; readonly from: string }
  | { readonly status: 'created'; readonly companyId: string; readonly companyStatus: string; readonly creationMode: string }
  | { readonly status: 'company'; readonly company: CompanyView }
  | { readonly status: 'renamed'; readonly changed: boolean; readonly version?: number }
  | { readonly status: 'transitioned'; readonly companyStatus: string };

/** The company operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface CompanyRuntime {
  resolveInternalUser(providerUserId: string): Promise<InternalUserReconciliation>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  createCompany(params: { accountId: string; actingUserId: string; creationMode: unknown; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<CreateCompanyResult>;
  getCompany(params: { userId: string; accountId: string; companyId: string }, options?: { logger?: Logger }): Promise<GetCompanyResult>;
  renameCompany(params: { userId: string; accountId: string; companyId: string; name: unknown; description?: unknown }, options?: { logger?: Logger }): Promise<RenameResult>;
  pauseCompany(params: { userId: string; accountId: string; companyId: string; reason?: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
  resumeCompany(params: { userId: string; accountId: string; companyId: string; reason?: string }, options?: { logger?: Logger }): Promise<StatusTransitionResult>;
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
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

async function transitionForRequest(kind: 'pause' | 'resume', companyId: string, input: { reason?: string }, deps: CompaniesRequestDeps): Promise<CompaniesRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const params = input.reason !== undefined ? { userId: ctx.userId, accountId: ctx.accountId, companyId, reason: input.reason } : { userId: ctx.userId, accountId: ctx.accountId, companyId };
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

export function pauseCompanyForRequest(companyId: string, input: { reason?: string }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return transitionForRequest('pause', companyId, input, deps);
}
export function resumeCompanyForRequest(companyId: string, input: { reason?: string }, deps: CompaniesRequestDeps = {}): Promise<CompaniesRequestResult> {
  return transitionForRequest('resume', companyId, input, deps);
}
