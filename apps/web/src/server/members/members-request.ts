// ACBP-P1-004 — authenticated member-management request use cases (apps/web).
//
// Orchestrates the ADR-022 flow for the members surface: resolve the SERVER-VERIFIED identity (provider
// user id + VERIFIED primary email) → internal user → the caller's OWN account, then invite/list/revoke.
// Accept is scoped to the invite's account (from the token), bound to the accepting user's verified
// email. The acting user is always the session user; role authorization is enforced in @acbp/core from
// the membership row — never from a request field. All domain access goes through @acbp/core.
import { resolveVerifiedIdentity, type VerifiedIdentityDeps } from '../auth/verified-identity.js';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import type { PublicErrorEnvelope } from '@acbp/contracts';
import type { AcceptResult, InviteResult, ListResult, MemberRole, MemberView, ProvisionResult, RevokeResult, InternalUserReconciliation } from '@acbp/core';

export type MembersRequestResult =
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope }
  | { readonly status: 'conflict' }
  | { readonly status: 'last_owner' }
  | { readonly status: 'invited'; readonly membershipId: string; readonly role: MemberRole; readonly inviteToken: string }
  | { readonly status: 'accepted'; readonly membershipId: string; readonly accountId: string; readonly role: MemberRole }
  | { readonly status: 'invalid_token' }
  | { readonly status: 'revoked' }
  | { readonly status: 'members'; readonly members: readonly MemberView[] };

/** The member operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface MemberRuntime {
  resolveInternalUser(providerUserId: string): Promise<InternalUserReconciliation>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  inviteMember(params: { accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown }, options?: { logger?: Logger }): Promise<InviteResult>;
  acceptInvite(params: { token: string; acceptingUserId: string }, options?: { logger?: Logger }): Promise<AcceptResult>;
  revokeMember(params: { accountId: string; actingUserId: string; membershipId: string }, options?: { logger?: Logger }): Promise<RevokeResult>;
  listMembers(params: { accountId: string; actingUserId: string }, options?: { logger?: Logger }): Promise<ListResult>;
}

export interface MembersRequestDeps {
  readonly identity?: VerifiedIdentityDeps;
  readonly runtime?: MemberRuntime;
}

type Actor = { readonly kind: 'actor'; readonly userId: string; readonly email: string | undefined };
type Early = { readonly kind: 'result'; readonly result: MembersRequestResult };

function membersLogger(): Logger {
  return createLogger({ component: 'members', context: createRootContext() });
}

async function runtimeOf(deps: MembersRequestDeps): Promise<MemberRuntime> {
  if (deps.runtime !== undefined) return deps.runtime;
  const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
  return getClerkIdentityRuntime();
}

/** Resolve the server-verified actor (internal user id + verified email), or an early mapped result. */
async function resolveActor(deps: MembersRequestDeps, runtime: MemberRuntime): Promise<Actor | Early> {
  const identity = await resolveVerifiedIdentity(deps.identity);
  if (identity.status === 'unauthenticated') return { kind: 'result', result: { status: 'unauthenticated' } };
  if (identity.status === 'email_unverified') return { kind: 'result', result: { status: 'email_unverified' } };
  if (identity.status === 'unavailable') return { kind: 'result', result: { status: 'unavailable' } };

  const resolution = await runtime.resolveInternalUser(identity.identity.providerUserId);
  switch (resolution.status) {
    case 'active':
      return { kind: 'actor', userId: resolution.userId, email: identity.identity.email };
    case 'deleted':
      return { kind: 'result', result: { status: 'forbidden' } };
    case 'not_found':
      return { kind: 'result', result: { status: 'not_found' } };
    case 'unavailable':
      return { kind: 'result', result: { status: 'unavailable' } };
  }
}

/** Resolve the actor AND ensure their personal account exists; returns the account id or an early result. */
async function resolveActorWithAccount(deps: MembersRequestDeps, runtime: MemberRuntime): Promise<{ userId: string; email: string | undefined; accountId: string } | Early> {
  const actor = await resolveActor(deps, runtime);
  if (actor.kind === 'result') return actor;
  const logger = membersLogger();
  const provision = await runtime.ensurePersonalAccount(actor.userId, { logger });
  return { userId: actor.userId, email: actor.email, accountId: provision.accountId };
}

export async function listMembersForRequest(deps: MembersRequestDeps = {}): Promise<MembersRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.listMembers({ accountId: ctx.accountId, actingUserId: ctx.userId }, { logger: membersLogger() });
  return r.status === 'ok' ? { status: 'members', members: r.members } : { status: 'forbidden' };
}

export async function inviteMemberForRequest(input: { invitedEmail: unknown; role: unknown }, deps: MembersRequestDeps = {}): Promise<MembersRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.inviteMember({ accountId: ctx.accountId, actingUserId: ctx.userId, invitedEmail: input.invitedEmail, role: input.role }, { logger: membersLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'invited', membershipId: r.membershipId, role: r.role, inviteToken: r.token };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'conflict':
      return { status: 'conflict' };
    case 'validation':
      return { status: 'validation', error: r.error };
  }
}

export async function acceptInviteForRequest(input: { token: unknown }, deps: MembersRequestDeps = {}): Promise<MembersRequestResult> {
  const runtime = await runtimeOf(deps);
  const actor = await resolveActor(deps, runtime);
  if (actor.kind === 'result') return actor.result;
  if (typeof input.token !== 'string' || input.token.length === 0) return { status: 'invalid_token' };
  // The accepting email is bound server-side from platform-authoritative users data inside the bootstrap
  // function (CDR-013) — never a caller-supplied value. Any failure collapses to a safe invalid_token.
  const r = await runtime.acceptInvite({ token: input.token, acceptingUserId: actor.userId }, { logger: membersLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'accepted', membershipId: r.membershipId, accountId: r.accountId, role: r.role };
    case 'invalid_or_used':
      return { status: 'invalid_token' };
  }
}

export async function revokeMemberForRequest(membershipId: string, deps: MembersRequestDeps = {}): Promise<MembersRequestResult> {
  const runtime = await runtimeOf(deps);
  const ctx = await resolveActorWithAccount(deps, runtime);
  if ('kind' in ctx) return ctx.result;
  const r = await runtime.revokeMember({ accountId: ctx.accountId, actingUserId: ctx.userId, membershipId }, { logger: membersLogger() });
  switch (r.status) {
    case 'ok':
      return { status: 'revoked' };
    case 'forbidden':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'last_owner':
      return { status: 'last_owner' };
  }
}
