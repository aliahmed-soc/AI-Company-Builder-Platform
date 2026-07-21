// @acbp/core — membership use cases (ACBP-P1-004; CDR-011): invite, accept, revoke, list.
//
// Provider-neutral. Authorization derives ONLY from the caller's ACTIVE membership role (resolved from
// the SERVER-VERIFIED user id) — never a Clerk claim. Owner-gated: invite, revoke. Member-gated (owner
// or viewer): list. Accept is self-service, bound to a single-use token AND the accepting user's
// verified email. Interim structured audit events carry no PII (no email, no token). The company scope
// is not exercised here (companies are P1-010); every P1-004 membership is account-level.
import { withTransaction, MembershipRepository, type DatabaseClient } from '@acbp/database';
import { validationError, type PublicErrorEnvelope } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';
import { isMemberRole, isOwner, isMember, type MemberRole } from './roles.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';

export type MembershipStatus = 'invited' | 'active' | 'revoked';

/** Account-internal view of a membership row (safe to return to members of the account). */
export interface MemberView {
  readonly membershipId: string;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
  readonly memberUserId: string | null;
  readonly invitedEmail: string | null;
  readonly createdAt: string;
}

export type InviteResult =
  | { readonly status: 'ok'; readonly membershipId: string; readonly token: string; readonly role: MemberRole }
  | { readonly status: 'forbidden' }
  | { readonly status: 'conflict' }
  | { readonly status: 'validation'; readonly error: PublicErrorEnvelope };

export type AcceptResult =
  | { readonly status: 'ok'; readonly membershipId: string; readonly accountId: string; readonly role: MemberRole }
  | { readonly status: 'invalid_or_used' }
  | { readonly status: 'email_mismatch' }
  | { readonly status: 'already_member' };

export type RevokeResult = { readonly status: 'ok' } | { readonly status: 'forbidden' } | { readonly status: 'not_found' } | { readonly status: 'last_owner' };

export type ListResult = { readonly status: 'ok'; readonly members: readonly MemberView[] } | { readonly status: 'forbidden' };

export interface MembershipOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** Injectable token generator (deterministic in tests); production uses a CSPRNG. */
  readonly generateToken?: () => { token: string; tokenHash: string };
}

/** Narrow persistence seam so the use cases are unit-testable without a database. */
export interface MembershipStore {
  resolveActiveRole(accountId: string, userId: string): Promise<MemberRole | null>;
  findPendingByAccountAndEmail(accountId: string, invitedEmail: string): Promise<{ readonly id: string } | undefined>;
  insertInvite(v: { readonly accountId: string; readonly invitedEmail: string; readonly role: MemberRole; readonly tokenHash: string; readonly invitedByUserId: string }): Promise<{ readonly id: string }>;
  findPendingByTokenHash(tokenHash: string): Promise<{ readonly id: string; readonly accountId: string; readonly invitedEmail: string; readonly role: MemberRole } | undefined>;
  activateInvite(id: string, memberUserId: string): Promise<void>;
  findInAccount(accountId: string, membershipId: string): Promise<{ readonly id: string; readonly role: MemberRole; readonly status: MembershipStatus } | undefined>;
  countActiveOwners(accountId: string): Promise<number>;
  revokeMembership(id: string): Promise<void>;
  listMembers(accountId: string): Promise<readonly MemberView[]>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Store-based use cases (unit-testable) ─────────────────────────────────────────────────────────

export async function inviteMemberWithStore(
  store: MembershipStore,
  params: { accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown },
  options: MembershipOpOptions = {},
): Promise<InviteResult> {
  if (!isMemberRole(params.role)) return { status: 'validation', error: validationError({ message: 'Unknown role.', fields: ['role'] }).toPublic() };
  if (typeof params.invitedEmail !== 'string' || !EMAIL_RE.test(params.invitedEmail.trim())) {
    return { status: 'validation', error: validationError({ message: 'A valid email is required.', fields: ['invitedEmail'] }).toPublic() };
  }
  const invitedEmail = normalizeEmail(params.invitedEmail);
  const role = params.role;

  // Owner-only. Role comes from the acting user's active membership, never from the request.
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (!isOwner(actingRole)) return { status: 'forbidden' };

  if ((await store.findPendingByAccountAndEmail(params.accountId, invitedEmail)) !== undefined) return { status: 'conflict' };

  const { token, tokenHash } = (options.generateToken ?? generateInviteToken)();
  const { id } = await store.insertInvite({ accountId: params.accountId, invitedEmail, role, tokenHash, invitedByUserId: params.actingUserId });
  options.logger?.info('membership.invited', { metadata: { accountId: params.accountId, membershipId: id, role } });
  return { status: 'ok', membershipId: id, token, role };
}

export async function acceptInviteWithStore(
  store: MembershipStore,
  params: { token: string; acceptingUserId: string; acceptingVerifiedEmail: string },
  options: MembershipOpOptions = {},
): Promise<AcceptResult> {
  const invite = await store.findPendingByTokenHash(hashInviteToken(params.token));
  if (invite === undefined) return { status: 'invalid_or_used' };
  // Bind to the invitee's verified email — a leaked/forwarded token cannot be used by someone else.
  if (normalizeEmail(params.acceptingVerifiedEmail) !== invite.invitedEmail) return { status: 'email_mismatch' };
  if ((await store.resolveActiveRole(invite.accountId, params.acceptingUserId)) !== null) return { status: 'already_member' };

  await store.activateInvite(invite.id, params.acceptingUserId);
  options.logger?.info('membership.accepted', { metadata: { accountId: invite.accountId, membershipId: invite.id, role: invite.role } });
  return { status: 'ok', membershipId: invite.id, accountId: invite.accountId, role: invite.role };
}

export async function revokeMemberWithStore(
  store: MembershipStore,
  params: { accountId: string; actingUserId: string; membershipId: string },
  options: MembershipOpOptions = {},
): Promise<RevokeResult> {
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (!isOwner(actingRole)) return { status: 'forbidden' };

  const target = await store.findInAccount(params.accountId, params.membershipId);
  if (target === undefined) return { status: 'not_found' };
  if (target.status === 'revoked') return { status: 'ok' }; // idempotent

  // Never leave an account without an owner.
  if (target.role === 'owner' && target.status === 'active' && (await store.countActiveOwners(params.accountId)) <= 1) {
    return { status: 'last_owner' };
  }
  await store.revokeMembership(target.id);
  options.logger?.info('membership.revoked', { metadata: { accountId: params.accountId, membershipId: target.id, role: target.role } });
  return { status: 'ok' };
}

export async function listMembersWithStore(store: MembershipStore, params: { accountId: string; actingUserId: string }): Promise<ListResult> {
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (!isMember(actingRole)) return { status: 'forbidden' };
  return { status: 'ok', members: await store.listMembers(params.accountId) };
}

// ── Live wrappers (repositories + transactions) ───────────────────────────────────────────────────

function toMemberView(row: { id: string; role: string; status: string; member_user_id: string | null; invited_email: string | null; created_at: Date }): MemberView {
  return {
    membershipId: row.id,
    role: row.role as MemberRole,
    status: row.status as MembershipStatus,
    memberUserId: row.member_user_id,
    invitedEmail: row.invited_email,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function liveStore(repo: MembershipRepository): MembershipStore {
  return {
    async resolveActiveRole(accountId, userId) {
      const row = await repo.findActiveByAccountAndUser(accountId, userId);
      return row === undefined ? null : (row.role as MemberRole);
    },
    async findPendingByAccountAndEmail(accountId, invitedEmail) {
      const row = await repo.findPendingByAccountAndEmail(accountId, invitedEmail);
      return row === undefined ? undefined : { id: row.id };
    },
    async insertInvite(v) {
      const row = await repo.insert({ account_id: v.accountId, role: v.role, status: 'invited', invited_email: v.invitedEmail, invite_token_hash: v.tokenHash, invited_by_user_id: v.invitedByUserId });
      return { id: row.id };
    },
    async findPendingByTokenHash(tokenHash) {
      const row = await repo.findPendingByTokenHash(tokenHash);
      return row === undefined || row.invited_email === null ? undefined : { id: row.id, accountId: row.account_id, invitedEmail: row.invited_email, role: row.role as MemberRole };
    },
    async activateInvite(id, memberUserId) {
      await repo.update(id, { status: 'active', member_user_id: memberUserId, invite_token_hash: null, accepted_at: new Date() });
    },
    async findInAccount(accountId, membershipId) {
      const row = await repo.findById(membershipId);
      return row === undefined || row.account_id !== accountId ? undefined : { id: row.id, role: row.role as MemberRole, status: row.status as MembershipStatus };
    },
    countActiveOwners(accountId) {
      return repo.countActiveOwners(accountId);
    },
    async revokeMembership(id) {
      await repo.update(id, { status: 'revoked', revoked_at: new Date(), invite_token_hash: null });
    },
    async listMembers(accountId) {
      return (await repo.listByAccount(accountId)).map(toMemberView);
    },
  };
}

export function inviteMember(client: DatabaseClient, params: { accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown }, options: MembershipOpOptions = {}): Promise<InviteResult> {
  return withTransaction(client, (tx) => inviteMemberWithStore(liveStore(new MembershipRepository(tx.kysely)), params, options), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
}

export function acceptInvite(client: DatabaseClient, params: { token: string; acceptingUserId: string; acceptingVerifiedEmail: string }, options: MembershipOpOptions = {}): Promise<AcceptResult> {
  return withTransaction(client, (tx) => acceptInviteWithStore(liveStore(new MembershipRepository(tx.kysely)), params, options), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
}

export function revokeMember(client: DatabaseClient, params: { accountId: string; actingUserId: string; membershipId: string }, options: MembershipOpOptions = {}): Promise<RevokeResult> {
  return withTransaction(client, (tx) => revokeMemberWithStore(liveStore(new MembershipRepository(tx.kysely)), params, options), options.correlationId !== undefined ? { correlationId: options.correlationId } : {});
}

export function listMembers(client: DatabaseClient, params: { accountId: string; actingUserId: string }): Promise<ListResult> {
  return listMembersWithStore(liveStore(new MembershipRepository(client.kysely)), params);
}
