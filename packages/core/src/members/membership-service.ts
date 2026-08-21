// @acbp/core — membership use cases (ACBP-P1-004; CDR-011): invite, accept, revoke, list.
//
// Provider-neutral. Authorization derives ONLY from the caller's ACTIVE membership role (resolved from
// the SERVER-VERIFIED user id) — never a Clerk claim. Owner-gated: invite, revoke. Member-gated (owner
// or viewer): list. Accept is self-service, bound to a single-use token AND the accepting user's
// verified email. Interim structured audit events carry no PII (no email, no token). The company scope
// is not exercised here (companies are P1-010); every P1-004 membership is account-level.
import { MembershipRepository, acceptInviteBootstrap, writeAuditEvent, type DatabaseClient, type AccountScope, type AuditWriteContext } from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { authorize, isAllowed, validationError, membershipInvited, membershipRevoked, type PublicErrorEnvelope, type AuditEvent } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';
import { isMemberRole, type MemberRole } from './roles.js';
import { generateInviteToken, hashInviteToken } from './invite-token.js';

/**
 * The in-transaction audit-write seam (ACBP-P1-008). Production ALWAYS uses the real `writeAuditEvent`, which
 * appends the durable audit row on the caller's AccountScope inside the same transaction as the membership
 * mutation — an audit-write failure rolls the mutation back (fail-closed). This is NOT a "skip audit" flag:
 * it is only overridden in tests to force the write to FAIL, proving the roll-back. It is never set from a
 * request; the request layer constructs options as `{ logger }` only.
 */
export type AuditWriteFn = (scope: AccountScope, event: AuditEvent, ctx?: AuditWriteContext) => Promise<string>;

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

// Accept denials collapse to a single opaque `invalid_or_used` (no email/existence/state oracle): under RLS
// the `acbp_accept_invite` bootstrap function binds the email from platform-authoritative users data and
// performs one atomic conditional transition, returning a row on success or nothing on any failure.
export type AcceptResult =
  | { readonly status: 'ok'; readonly membershipId: string; readonly accountId: string; readonly role: MemberRole }
  | { readonly status: 'invalid_or_used' };

// `changed` distinguishes an ACTUAL state transition (which must emit a durable `membership.revoked` audit)
// from the idempotent already-revoked no-op (which must NOT). `membershipId`/`role` identify the revoked
// membership for the audit subject/metadata; they are present only when `changed` is true.
export type RevokeResult =
  | { readonly status: 'ok'; readonly changed: boolean; readonly membershipId?: string; readonly role?: MemberRole }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'last_owner' };

export type ListResult = { readonly status: 'ok'; readonly members: readonly MemberView[] } | { readonly status: 'forbidden' };

export interface MembershipOpOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  /** Injectable token generator (deterministic in tests); production uses a CSPRNG. */
  readonly generateToken?: () => { token: string; tokenHash: string };
  /** TEST SEAM ONLY (ACBP-P1-008): override the in-tx audit writer to force a failure. Never set in production. */
  readonly auditWriter?: AuditWriteFn;
}

/** Build the non-PII audit context from op options (correlation id only; account/actor come from the scope). */
function auditContext(options: MembershipOpOptions): AuditWriteContext {
  return options.correlationId !== undefined ? { correlationId: options.correlationId } : {};
}

/**
 * Narrow persistence seam so the use cases are unit-testable without a database. Invite acceptance is NOT
 * here — it is a pre-context bootstrap operation handled atomically by the `acbp_accept_invite` SECURITY
 * DEFINER function (ACBP-P1-006; CDR-013), not by these store methods.
 */
export interface MembershipStore {
  resolveActiveRole(accountId: string, userId: string): Promise<MemberRole | null>;
  findPendingByAccountAndEmail(accountId: string, invitedEmail: string): Promise<{ readonly id: string } | undefined>;
  insertInvite(v: { readonly accountId: string; readonly invitedEmail: string; readonly role: MemberRole; readonly tokenHash: string; readonly invitedByUserId: string }): Promise<{ readonly id: string }>;
  findInAccount(accountId: string, membershipId: string): Promise<{ readonly id: string; readonly role: MemberRole; readonly status: MembershipStatus } | undefined>;
  /**
   * Atomically revoke a membership (an active member OR a pending invite), refusing to remove the account's
   * LAST active owner (CDR-011). The owner-count decision and the revoke are one operation so concurrent
   * revocations of different owners cannot both slip past a stale count and drain the account to zero owners.
   * Outcomes: `'revoked'` (this call flipped the row to revoked), `'last_owner'` (refused — target is the sole
   * active owner), `'noop'` (nothing to flip — already revoked, e.g. a concurrent revoke won → idempotent).
   *
   * IT REPLACES A PAIR. `countActiveOwners` + `revokeMembership` used to sit here and were removed together:
   * separately they are a read-then-act sequence, and the seam between them WAS the defect. Re-adding either
   * one re-opens it, which is why neither survives anywhere in this package.
   */
  revokeActiveMembership(accountId: string, id: string): Promise<'revoked' | 'noop' | 'last_owner'>;
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

  // Central authz.check (ACBP-P1-007). The acting role comes from the caller's ACTIVE membership row,
  // never from the request; a denial is audited by checkAuthorization and mapped to a coarse `forbidden`.
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (checkAuthorization(actingRole, 'member:invite', { accountId: params.accountId, actorId: params.actingUserId }, options).kind === 'deny') {
    return { status: 'forbidden' };
  }

  if ((await store.findPendingByAccountAndEmail(params.accountId, invitedEmail)) !== undefined) return { status: 'conflict' };

  const { token, tokenHash } = (options.generateToken ?? generateInviteToken)();
  const { id } = await store.insertInvite({ accountId: params.accountId, invitedEmail, role, tokenHash, invitedByUserId: params.actingUserId });
  options.logger?.info('membership.invited', { metadata: { accountId: params.accountId, membershipId: id, role } });
  return { status: 'ok', membershipId: id, token, role };
}


export async function revokeMemberWithStore(
  store: MembershipStore,
  params: { accountId: string; actingUserId: string; membershipId: string },
  options: MembershipOpOptions = {},
): Promise<RevokeResult> {
  // Central authz.check (ACBP-P1-007). Owner-gated; role from the active membership, denial audited.
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (checkAuthorization(actingRole, 'member:revoke', { accountId: params.accountId, actorId: params.actingUserId }, options).kind === 'deny') {
    return { status: 'forbidden' };
  }

  const target = await store.findInAccount(params.accountId, params.membershipId);
  if (target === undefined) return { status: 'not_found' };
  if (target.status === 'revoked') return { status: 'ok', changed: false }; // idempotent no-op → no new audit

  // Revoke ATOMICALLY, upholding the last-owner invariant (CDR-011) in one locked operation. Doing the
  // owner-count check and the flip as separate steps is a read-then-act race: two concurrent revocations
  // of DIFFERENT active owners could each read "2 owners", both pass, and both flip — draining the account
  // to zero owners. The store performs the check + flip as a single serialized unit.
  const outcome = await store.revokeActiveMembership(params.accountId, target.id);
  if (outcome === 'last_owner') return { status: 'last_owner' };

  /*
   * ⚠️ THIS ARM IS A REBASE MERGE OF TWO GUARANTEES, AND DROPPING EITHER ONE IS A SILENT REGRESSION.
   *
   * ACBP-P1-004 (this fix) replaced a read-then-act `countActiveOwners` + `revokeMembership` pair with the
   * single locked `revokeActiveMembership` above — that is the race fix.
   *
   * ACBP-P1-008 landed on main AFTER this fix was written and gave the same function an audit contract: the
   * caller returns `changed: true` with the membership's id and role, and the live wrapper writes the durable
   * audit in the same transaction. Taking this fix's original `return { status: 'ok' }` wholesale would have
   * deleted that contract, so a revocation would stop being audited and nothing would have failed.
   *
   * Both are kept: the atomic outcome DRIVES the audit decision it used to only log.
   *   'revoked' → this call flipped the row → audit it.
   *   'noop'    → a concurrent revoke already flipped it → the revocation is idempotently in effect, and the
   *               call that DID flip it is the one that audits. A second audit here would record two
   *               revocations of one membership.
   */
  if (outcome === 'noop') return { status: 'ok', changed: false };
  options.logger?.info('membership.revoked', { metadata: { accountId: params.accountId, membershipId: target.id, role: target.role } });
  return { status: 'ok', changed: true, membershipId: target.id, role: target.role };
}

export async function listMembersWithStore(store: MembershipStore, params: { accountId: string; actingUserId: string }, options: MembershipOpOptions = {}): Promise<ListResult> {
  // Central authz.check (ACBP-P1-007). Any active member may list; a non-member denial is audited.
  const actingRole = await store.resolveActiveRole(params.accountId, params.actingUserId);
  if (checkAuthorization(actingRole, 'member:list', { accountId: params.accountId, actorId: params.actingUserId }, options).kind === 'deny') {
    return { status: 'forbidden' };
  }
  const members = await store.listMembers(params.accountId);
  // Only owners see pending-invite email addresses; viewers get them redacted (least data exposure). This
  // is a projection capability, not a request gate, so it consults the matrix WITHOUT auditing a denial.
  const canSeeInvitedEmails = isAllowed(authorize(actingRole, 'member:read_invited_email'));
  const projected = canSeeInvitedEmails ? members : members.map((m) => (m.invitedEmail === null ? m : { ...m, invitedEmail: null }));
  return { status: 'ok', members: projected };
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
    async findInAccount(accountId, membershipId) {
      const row = await repo.findById(membershipId);
      return row === undefined || row.account_id !== accountId ? undefined : { id: row.id, role: row.role as MemberRole, status: row.status as MembershipStatus };
    },
    revokeActiveMembership(accountId, id) {
      return repo.revokeActiveMembershipPreservingLastOwner(accountId, id);
    },
    async listMembers(accountId) {
      return (await repo.listByAccount(accountId)).map(toMemberView);
    },
  };
}

// Live wrappers run under the caller's validated AccountScope on the restricted role (ACBP-P1-006): the
// acting user's ACTIVE membership is resolved first (a non-member is denied → forbidden), then the store
// op runs under `withAccountTransaction` so every memberships query/mutation is RLS-confined to the
// caller's account. The store's own role check (owner vs viewer) still runs under the scope.
export async function inviteMember(client: DatabaseClient, params: { accountId: string; actingUserId: string; invitedEmail: unknown; role: unknown }, options: MembershipOpOptions = {}): Promise<InviteResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInAccountScope(
    client,
    { userId: params.actingUserId, requestedAccountId: params.accountId },
    async (scope) => {
      const result = await inviteMemberWithStore(liveStore(new MembershipRepository(scope.db)), params, options);
      if (result.status === 'ok') {
        // Durable audit (ACBP-P1-008) — SAME transaction + AccountScope as the invite insert. account/actor/
        // event id are bound server-side by the writer; the payload carries only the invited role (never the
        // token or email). A write failure throws → the whole tx rolls back → the invite is undone.
        await audit(scope, membershipInvited({ membershipId: result.membershipId, role: result.role }), auditContext(options));
      }
      return result;
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

/**
 * Accept a pending invite via the `acbp_accept_invite` SECURITY DEFINER bootstrap function (ACBP-P1-006;
 * CDR-013). The caller supplies only the raw token + the SERVER-VERIFIED accepting user id; the function
 * derives the authoritative email from `users.primary_email` (never a caller parameter), requires the user
 * to be active + verified, and performs one atomic invited→active transition. Any failure returns
 * `invalid_or_used` (no email/existence/state oracle). The raw token is hashed here; the hash never leaves
 * the server and is never logged.
 */
export async function acceptInvite(client: DatabaseClient, params: { token: string; acceptingUserId: string }, options: MembershipOpOptions = {}): Promise<AcceptResult> {
  const row = await acceptInviteBootstrap(client.kysely, hashInviteToken(params.token), params.acceptingUserId);
  if (row === null) return { status: 'invalid_or_used' };
  options.logger?.info('membership.accepted', { metadata: { accountId: row.accountId, membershipId: row.membershipId, role: row.role } });
  return { status: 'ok', membershipId: row.membershipId, accountId: row.accountId, role: row.role as MemberRole };
}

export async function revokeMember(client: DatabaseClient, params: { accountId: string; actingUserId: string; membershipId: string }, options: MembershipOpOptions = {}): Promise<RevokeResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const run = await runInAccountScope(
    client,
    { userId: params.actingUserId, requestedAccountId: params.accountId },
    async (scope) => {
      const result = await revokeMemberWithStore(liveStore(new MembershipRepository(scope.db)), params, options);
      // Durable audit ONLY for an ACTUAL revocation (not the idempotent no-op, last-owner denial, or missing/
      // cross-account target). SAME transaction + scope; a write failure rolls the revocation back.
      if (result.status === 'ok' && result.changed && result.membershipId !== undefined && result.role !== undefined) {
        await audit(scope, membershipRevoked({ membershipId: result.membershipId, role: result.role }), auditContext(options));
      }
      return result;
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}

export async function listMembers(client: DatabaseClient, params: { accountId: string; actingUserId: string }, options: MembershipOpOptions = {}): Promise<ListResult> {
  const run = await runInAccountScope(
    client,
    { userId: params.actingUserId, requestedAccountId: params.accountId },
    (scope) => listMembersWithStore(liveStore(new MembershipRepository(scope.db)), params, options),
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
