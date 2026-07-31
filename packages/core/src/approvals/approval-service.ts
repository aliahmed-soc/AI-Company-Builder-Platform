// @acbp/core — the approval engine (ACBP-P6-003c; CDR-068; APPR-002/003/007; ADR-009; invariant 5).
//
// FOUR OPERATIONS, FOUR AUTHORITIES. Requesting rides the execution path (`approval:request`); deciding is the
// authority chain's hinge and is owner-only (`approval:decide`); REVOKING is owner-only too (`approval:revoke`),
// because whoever can grant an authorization must be able to take it back or an approval is a one-way door; and
// reading the inbox is open to viewers (`approval:read`), because seeing that a human is needed is not authority
// to be one.
//
// EVALUATION POINT 2 LIVES HERE (CDR-068 §0.2). `APPROVAL-AND-POLICY-ARCHITECTURE §5` point 2 is *"approval
// requested → decision context correctness (policy version recorded into the approval)"*. Its purpose is precise and
// worth stating so it is not mistaken for a duplicate of point 3: the request must carry the policy version the human
// decided under, so the decision stays explicable when the policy later changes. Point 3 re-checks at execution;
// point 2 is what makes the decision itself readable afterwards.
//
// BINDING AND EXPIRY ARE SET HERE (ACBP-P6-004; APPR-004/005). A request is written with the hash of the exact
// action it describes and the instant it dies, both computed from the values the human will actually be shown.
// Neither column is in the product role's UPDATE grant, so what is bound at insert stays bound.
//
// WHAT THIS MODULE STILL DOES NOT DO: verify or consume. The gate is one atomic conditional UPDATE at the
// dispatcher (CDR-069 §1-G5) — checking usability here and executing there would be exactly the read-then-write
// window that lets two dispatches both proceed.
import {
  buildApprovalRequest,
  parseApprovalDecision,
  approvalRequested,
  approvalApproved,
  approvalRejected,
  approvalRevoked,
  approvalRevokeFailed,
  authorizesExecution,
  type ApprovalRequestInput,
  type ApprovalDecisionInput,
  type ApprovalScope,
} from '@acbp/contracts';
import { ApprovalRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type ApprovalRequestRow, type ApprovalDecisionRow } from '@acbp/database';
import { computePayloadBinding } from './binding.js';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { evaluatePolicyInScope } from '../policy/policy-service.js';
import type { Logger } from '@acbp/observability';

export interface ApprovalServiceOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

function opts(options: ApprovalServiceOptions): { correlationId?: string; logger?: Logger; auditWriter?: typeof writeAuditEvent } {
  const o: { correlationId?: string; logger?: Logger; auditWriter?: typeof writeAuditEvent } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  if (options.auditWriter !== undefined) o.auditWriter = options.auditWriter;
  return o;
}
function auditCtx(options: ApprovalServiceOptions): AuditWriteContext {
  return options.correlationId === undefined ? {} : { correlationId: options.correlationId };
}

export interface RequestApprovalParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly runId: string;
  readonly toolId: string;
  /**
   * NO `toolVersion` AND NO `riskClass` (review pass 1 H3 / pass 2 H5). Both used to be caller-supplied while the
   * comment below the policy evaluation claimed they came from `tool_definitions`. They did not — so a model
   * proposing a `sensitive_irreversible` action could declare `informational`, `reversibilityOf` would faithfully
   * derive "reversible" from the lie, the CHECK would certify the pair as consistent, and the human would be shown
   * an irreversible action labelled undoable. That is precisely the combination this contract exists to prevent.
   *
   * Worse for the engine: `risk_class` is trust-critical, and `registry` provenance skips the most restrictive path
   * a model-sourced fact takes. Both now come from the registry read below, so the claim is true by construction.
   */
  readonly scope: ApprovalScope;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly estimatedCostCredits: number;
  readonly preview: string;
  /**
   * WHEN THIS APPROVAL DIES (APPR-005). REQUIRED, and there is no default anywhere in the stack.
   *
   * ADR-009 §15 leaves *"expiry defaults per risk class"* an OPEN OWNER QUESTION (AOQ-14-adjacent), so this ticket
   * ships the mechanism and none of the values. Every caller states an expiry explicitly; when the owner sets
   * per-risk-class defaults they land in one place and change no enforcement code.
   *
   * Optional-with-a-fallback was rejected in CDR-069 §1-G3: a default here would be the platform quietly answering
   * a question that is the owner's, and the absence of their decision would read as permission to never expire.
   */
  readonly expiresAt: Date;
  /** The instant handed to the policy engine. An INPUT, never ambient (CDR-066 §3-G3). */
  readonly evaluatedAt?: Date;
}

export type RequestApprovalResult =
  | { readonly status: 'ok'; readonly request: ApprovalRequestRow }
  | { readonly status: 'forbidden' }
  | { readonly status: 'incomplete'; readonly missing: readonly string[] }
  | { readonly status: 'scope_not_available'; readonly scope: unknown }
  | { readonly status: 'no_usable_policy'; readonly reason: string }
  /** No ACTIVE `tool_definitions` row. There is no risk class to show a human, so there is nothing to ask them. */
  | { readonly status: 'tool_not_registered' };

/**
 * Raise an approval request, recording the policy version the decision will be made under.
 *
 * THE POLICY IS EVALUATED HERE, AT POINT 2, and its version is stored on the request. A company with no usable policy
 * cannot raise one: there would be no version to record, so the request would be undecidable in exactly the way
 * `no_usable_policy` describes — and fabricating a version to get past it would put an unverifiable claim in the
 * record. Fail-closed, and for the same reason CDR-066 §6-G15 gives.
 */
export async function requestApproval(client: DatabaseClient, params: RequestApprovalParams, options: ApprovalServiceOptions = {}): Promise<RequestApprovalResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RequestApprovalResult> => {
      if (checkAuthorization(role, 'approval:request', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // THE REGISTRY, READ FIRST, exactly as the dispatcher reads it: the ACTIVE definition at the highest version.
      // This is what makes the `registry` provenance below a true statement rather than a caller's assertion.
      const definition = await scope.db
        .selectFrom('tool_definitions')
        .select(['risk_class', 'version'])
        .where('tool_id', '=', params.toolId)
        .where('status', '=', 'active')
        .orderBy('version', 'desc')
        .executeTakeFirst();
      if (definition === undefined) return { status: 'tool_not_registered' };

      // `expiresAt` IS VALIDATED HERE because nothing else validates it (review pass 2, F9). `decidedAt` and
      // `effectiveFrom` are guarded by `parseApprovalDecision`, and the read side is guarded by `isExpired` — this
      // was the one date in the approval stack with no gate, so an `Invalid Date` reached the driver and came back
      // as a raw 22007 instead of the typed refusal every sibling path returns.
      if (!(params.expiresAt instanceof Date) || !Number.isFinite(params.expiresAt.getTime())) {
        return { status: 'incomplete', missing: ['expiresAt'] };
      }

      const input: ApprovalRequestInput = {
        toolId: params.toolId,
        toolVersion: Number(definition.version),
        // A NULL `risk_class` is legal in the registry and resolves to the MOST RESTRICTIVE class (TOOL-001) —
        // an unclassified tool is treated as the most dangerous, not the least.
        riskClass: definition.risk_class,
        scope: params.scope,
        action: params.action,
        reason: params.reason,
        expectedResult: params.expectedResult,
        data: params.data,
        estimatedCostCredits: params.estimatedCostCredits,
        preview: params.preview,
        // Replaced below with the version the engine actually reports; the builder needs a number to validate shape.
        policyVersion: 1,
      };
      // CONTENT BEFORE EVALUATION, so an incomplete request is refused before anything is written or evaluated.
      // APPR-002's failure clause is *"Full-content requirement blocks incomplete requests"*, and refusing here
      // means the evaluation and the audit trail never mention a request that was never viable.
      const built = buildApprovalRequest(input);
      if (built.status === 'incomplete') return { status: 'incomplete', missing: built.missing };
      if (built.status === 'scope_not_available') return { status: 'scope_not_available', scope: built.scope };

      // ── EVALUATION POINT 2 (CDR-068 §0.2) ────────────────────────────────────────────────────────────────
      // In the SCOPE ALREADY OPEN, so the evaluation, the request row and the audit event commit or roll back
      // together. The risk class is `registry`-provenanced because it came from the `tool_definitions` read ABOVE,
      // not from model text — the two lines are adjacent on purpose, because that claim was once false.
      const evaluation = await evaluatePolicyInScope(
        scope,
        {
          accountId: params.accountId,
          companyId: params.companyId,
          evaluationPoint: 'approval_requested',
          observations: { risk_class: { value: built.request.risk, provenance: 'registry' } },
          evaluatedAt: params.evaluatedAt ?? new Date(),
        },
        opts(options),
      );
      if (evaluation.status !== 'decided') {
        // No version to record. `forbidden` is the other non-decided status and it cannot occur here — this caller
        // already holds `approval:request` — but treating both as a refusal is the fail-closed reading either way.
        return { status: 'no_usable_policy', reason: evaluation.status === 'no_usable_policy' ? evaluation.reason : 'forbidden' };
      }

      // THE BINDING (ACBP-P6-004; APPR-004), computed from the SAME values that are stored on the row and shown to
      // the human — `built.request`, not `params`. Hashing the caller's input instead would let the request display
      // one thing and bind another, which is the drift this hash exists to make impossible.
      const binding = computePayloadBinding({
        toolId: built.request.toolId,
        toolVersion: built.request.toolVersion,
        payload: built.request.data,
        costBoundCredits: built.request.estimatedCostCredits,
      });

      const approvals = new ApprovalRepository(scope.db);
      const request = await approvals.insertRequest({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        runId: params.runId,
        payloadHash: binding.hash,
        bindingVersion: binding.version,
        expiresAt: params.expiresAt,
        toolId: built.request.toolId,
        toolVersion: built.request.toolVersion,
        action: built.request.action,
        reason: built.request.reason,
        expectedResult: built.request.expectedResult,
        data: built.request.data,
        estimatedCostCredits: built.request.estimatedCostCredits,
        riskClass: built.request.risk,
        reversibility: built.request.reversibility,
        preview: built.request.preview,
        scope: built.request.scope,
        policyId: evaluation.policyId,
        policyVersion: evaluation.policyVersion,
        policyEvalId: evaluation.evaluationId,
      });

      await audit(
        scope,
        approvalRequested({
          requestId: request.id,
          toolId: request.tool_id,
          riskClass: request.risk_class,
          scope: request.scope,
          policyVersion: evaluation.policyVersion,
          estimatedCostCredits: request.estimated_cost_credits,
        }),
        auditCtx(options),
      );
      return { status: 'ok', request };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface DecideApprovalParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly requestId: string;
  /**
   * `decidedBy` IS NOT PART OF THE INPUT. Both halves are derived server-side — the user id from the authenticated
   * caller, the type from the fact that a caller reached this path at all — so there is nothing here for a caller
   * to fill in. Expressing that in the type is the cheapest layer of invariant 5: the forgery a reviewer had to
   * reason about is now one a caller cannot spell. A caller bypassing the types is still refused at runtime.
   */
  readonly decision: Omit<ApprovalDecisionInput, 'decidedBy'>;
  /** For `edit_then_approve`: the NEW request this one is superseded by, raised separately by the caller. */
  readonly supersededByRequestId?: string;
}

export type DecideApprovalResult =
  | { readonly status: 'ok'; readonly decision: ApprovalDecisionRow; readonly authorizes: boolean }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'already_decided'; readonly currentStatus: string }
  | { readonly status: 'invalid'; readonly reason: string };

/**
 * Record a human's decision on a request — one of the five paths (APPR-007).
 *
 * ONE DECISION PER REQUEST, and the guarantee is the database's `UNIQUE(request_id)` rather than a read-then-write
 * here: two concurrent submissions cannot both succeed, so a double-click cannot produce two contradictory
 * authorizations for one action. The pre-read below is for a useful message, not for correctness.
 */
export async function decideApproval(client: DatabaseClient, params: DecideApprovalParams, options: ApprovalServiceOptions = {}): Promise<DecideApprovalResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<DecideApprovalResult> => {
      // OWNER-ONLY, checked before anything else and before the request is even looked up: a caller who may not
      // decide learns only that, rather than learning whether the request exists.
      if (checkAuthorization(role, 'approval:decide', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // THE DECIDER IS THE AUTHENTICATED CALLER, never a field they supplied. Accepting `decidedBy.userId` from the
      // request body would let an owner record someone else as having approved — the audit trail's whole value is
      // that the name on a decision is the name of whoever made it.
      // …AND SO IS THE DECIDER *TYPE* (review pass 1 H4 / pass 2). Invariant 5's three layers — the TypeScript type,
      // `parseApprovalDecision`, and the `decider_is_human` CHECK — all tested the same caller-supplied string, so
      // what they actually enforced was "a caller who honestly declares itself a worker is refused". Any owner-
      // credentialed caller, including an agent running under an owner session, wrote `human` and passed all three.
      //
      // This path is reached only after `runInCompanyScope` resolved a real authenticated membership, so the decider
      // IS a human by construction, and `human` is derived rather than accepted. `delegated` is refused outright:
      // there is no delegation store to check a delegation against (P6-005 does not exist), so honouring the claim
      // would put an unbacked assertion in the audit trail where a reader would believe it.
      // Read through a cast BECAUSE THE TYPE FORBIDS IT: a caller reaching this function from JavaScript, an HTTP
      // body, or a widened `any` can still put a `decidedBy` on the wire, and "the type prevents it" is exactly the
      // reasoning that made invariant 5's three layers agree with each other and with nothing else.
      const claimed = (params.decision as { decidedBy?: { type?: unknown } }).decidedBy;
      if (claimed?.type !== undefined && claimed.type !== 'human') {
        return { status: 'invalid', reason: 'decider_type_not_caller_supplied' };
      }
      const parsed = parseApprovalDecision({ ...params.decision, decidedBy: { type: 'human', userId: params.userId } });
      if (parsed.status !== 'ok') return { status: 'invalid', reason: parsed.status };

      const approvals = new ApprovalRepository(scope.db);
      const request = await approvals.findRequest(params.requestId);
      // RLS-confined, so another company's request reads as absent rather than as someone else's approval.
      if (request === undefined) return { status: 'not_found' };
      if (request.status !== 'pending') return { status: 'already_decided', currentStatus: request.status };

      // THE REQUEST'S LIFECYCLE MOVES FIRST, BEFORE THE DECISION IS WRITTEN. `edit_then_approve` SUPERSEDES rather
      // than decides, because canon §2 says the old approval is *"superseded, never mutated"* (invariant 7) — the
      // human approved a different payload, and calling that a decision on THIS request would misreport what they
      // agreed to.
      //
      // A SUPERSEDING DECISION WITHOUT A SUCCESSOR IS REFUSED, not quietly downgraded to `markDecided`. That silent
      // fallback is how `edit_then_approve` came to authorize the payload it edited away: the request the human
      // refused was recorded as plainly decided, and the gate read it as permission. If there is no successor
      // request to carry the edited payload, the edit has nowhere to go and the decision is incoherent.
      if (parsed.decision.supersedes && params.supersededByRequestId === undefined) {
        return { status: 'invalid', reason: 'superseded_by_request_id_required' };
      }

      // THE UPDATE COUNT IS CHECKED, AND THE ORDER IS WHY IT CAN BE. Both transitions are `where status = 'pending'`,
      // so a zero-row result means another writer moved this request between the read above and here. Doing this
      // BEFORE the insert means the loser of that race writes NOTHING: were the decision inserted first, returning a
      // refusal would leave it committed beside a request whose status never changed, which is the one shape the
      // gate's `r.status = 'decided'` filter would then silently swallow.
      const moved =
        parsed.decision.supersedes && params.supersededByRequestId !== undefined
          ? await approvals.markSuperseded(request.id, params.supersededByRequestId, parsed.decision.decidedAt)
          : await approvals.markDecided(request.id, parsed.decision.decidedAt);
      //
      // HONEST NOTE ON EVIDENCE: this line is NOT mutation-killed. Replacing it with `void moved` leaves the suite
      // green, because the race window cannot be forced deterministically through the service's own API — under
      // READ COMMITTED the second caller's pre-read usually lands after the first commits and it is refused there
      // instead. The concurrency test below asserts exactly-one-wins, which is the property that matters, and the
      // primitive this depends on (`markDecided` returns 0 for a non-pending request) is pinned directly in the
      // repository suite. Kept because without it the loser of a real race falls through to `insertDecision` and
      // trips the uniqueness constraint — fail-closed, but a raw conflict where an honest answer exists.
      if (moved === 0) return { status: 'already_decided', currentStatus: 'decided' };

      const decision = await approvals.insertDecision({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        requestId: request.id,
        path: parsed.decision.path,
        deciderType: parsed.decision.decidedBy.type,
        decidedByUserId: parsed.decision.decidedBy.userId,
        decidedAt: parsed.decision.decidedAt,
        reason: parsed.decision.reason ?? null,
        editedData: parsed.decision.editedData ?? null,
        effectiveFrom: parsed.decision.effectiveFrom ?? null,
        memberRequestIds: parsed.decision.memberRequestIds ?? null,
      });

      const version = Number(request.policy_version);
      await audit(
        scope,
        parsed.decision.path === 'reject'
          ? approvalRejected({ requestId: request.id, deciderType: parsed.decision.decidedBy.type, policyVersion: version })
          : approvalApproved({ requestId: request.id, path: parsed.decision.path, deciderType: parsed.decision.decidedBy.type, policyVersion: version }),
        auditCtx(options),
      );

      // `authorizes` is computed from the DECISION, at the decision's own instant, by the same pure function the
      // dispatcher uses — so "did this authorize?" has one answer, not one per caller.
      //
      // A SUPERSEDING DECISION AUTHORIZES NOTHING HERE, and that is not a second opinion about `authorizesExecution`:
      // that function answers about the SUCCESSOR request, which carries the edited payload. This field answers
      // about the request just decided, and the human refused that one. Reporting `true` would be the same
      // conflation that let the gate run the payload the human edited away.
      return { status: 'ok', decision, authorizes: !parsed.decision.supersedes && authorizesExecution(parsed.decision, parsed.decision.decidedAt) };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface RevokeApprovalParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly requestId: string;
  /** The instant of the revocation. An INPUT, never ambient — the same discipline every clock in this stack follows. */
  readonly revokedAt?: Date;
}

export type RevokeApprovalResult =
  | { readonly status: 'ok' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  /**
   * THE RACE THIS TICKET IS ABOUT (CDR-069 §1-G6). The approval was already spent on a tool call, so the action is
   * authorized and may already have run. Nothing can un-authorize it, and reporting a successful revocation would
   * be a lie about the world — canon permits either "resolve in favour of revocation" or "produce a compensating
   * alert", and once consumption has committed only the second is truthful.
   */
  | { readonly status: 'already_consumed' }
  /** Nothing to withdraw: a request nobody decided has no authorization, and one already revoked has none left. */
  | { readonly status: 'not_revocable'; readonly currentStatus: string };

/**
 * Take an authorization back before it is spent (APPR-006; ACBP-P6-004).
 *
 * A LIFECYCLE TRANSITION, NOT A SIXTH DECISION PATH, and CDR-069 §1-G4 records why: `approval_decisions` has
 * UNIQUE(request_id), so a revocation — necessarily a second statement about an already-decided request — cannot be
 * a decision row without destroying the constraint that makes "one decision per approval" true. It is also the
 * honest model. A decision is what a human said about a proposal; a revocation withdraws an answer already given.
 *
 * THE RACE IS RESOLVED BY THE ROW LOCK, not by this function. `revoke` is `where status = 'decided'`, so if a
 * dispatch consumed the approval first, this updates zero rows and returns `already_consumed`. If this commits
 * first, the dispatch's own conditional UPDATE finds nothing and the call is refused. Exactly one wins, and the row
 * records which.
 */
export async function revokeApproval(client: DatabaseClient, params: RevokeApprovalParams, options: ApprovalServiceOptions = {}): Promise<RevokeApprovalResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<RevokeApprovalResult> => {
      // Owner-only, checked before the lookup: a caller who may not revoke learns only that, not whether the
      // request exists — the same ordering `decideApproval` uses, and for the same reason.
      if (checkAuthorization(role, 'approval:revoke', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const approvals = new ApprovalRepository(scope.db);
      const request = await approvals.findRequest(params.requestId);
      // RLS-confined, so another company's request reads as absent rather than as someone else's approval.
      if (request === undefined) return { status: 'not_found' };

      const at = params.revokedAt ?? new Date();
      if ((await approvals.revoke(request.id, params.userId, at)) === 0) {
        // Re-read rather than trusting the pre-read: the row moved between them, and WHICH way it moved is the
        // answer the caller needs. `consumed` is the compensating-alert case; anything else is simply not revocable.
        const now = await approvals.findRequest(params.requestId);
        if (now?.status !== 'consumed') return { status: 'not_revocable', currentStatus: now?.status ?? 'unknown' };

        // THE COMPENSATING ALERT (CDR-069 §1-G6), which this branch promised and did not emit until review pass 2
        // measured its absence. The approval was spent before the human reached it: the action is authorized and
        // may already have run, so there is nothing to undo and no honest way to report success. What CAN be done
        // is leave a durable, alarmable trace — an API response nobody stored is not one.
        await audit(scope, approvalRevokeFailed({ requestId: request.id, attemptedByUserId: params.userId }), auditCtx(options));
        return { status: 'already_consumed' };
      }

      // In the SAME transaction as the transition — audit-or-nothing (ADR-015). `revoked_by` is canon's own payload
      // field; the human's reason, if they gave one, is not carried here for the same discipline `approval.rejected`
      // follows.
      await audit(scope, approvalRevoked({ requestId: request.id, revokedByUserId: params.userId }), auditCtx(options));
      return { status: 'ok' };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface ListApprovalInboxParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly limit?: number;
}

export type ListApprovalInboxResult = { readonly status: 'ok'; readonly requests: readonly ApprovalRequestRow[] } | { readonly status: 'forbidden' };

/** The inbox page size, clamped. Exported and pure so the CLAMP ITSELF can be tested without 201 fixture rows. */
export const INBOX_MAX_PAGE = 200;

/**
 * An unbounded read of a company's approval history is a denial-of-service on the reader, so the page is clamped
 * rather than trusted. Pulled out of the use case because inlined it was UNTESTABLE at any sane cost: raising the
 * ceiling to a million survived the whole integration suite, since no test creates enough rows to tell the
 * difference. A pure function can be asked directly.
 */
export function clampInboxLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number.isFinite(limit) ? (limit as number) : 50, 1), INBOX_MAX_PAGE);
}

/** The inbox (APPR-003): pending requests only, viewer-readable, RLS-confined. */
export async function listApprovalInbox(client: DatabaseClient, params: ListApprovalInboxParams, options: ApprovalServiceOptions = {}): Promise<ListApprovalInboxResult> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ListApprovalInboxResult> => {
      if (checkAuthorization(role, 'approval:read', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      const approvals = new ApprovalRepository(scope.db);
      return { status: 'ok', requests: await approvals.listPending(scope.tenant.companyId, clampInboxLimit(params.limit)) };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
