// @acbp/core — the policy engine service (ACBP-P6-001c; CDR-066 §6; ADR-010; POL-005/006; TOOL-003).
//
// Resolve the company's ACTIVE policy, evaluate it against observed facts, record the evaluation, return the
// decision. The deciding itself is `evaluatePolicy` in @acbp/contracts and stays a pure function — this module is
// only the part that needs a database, which is exactly why "same inputs same decision" is provable.
//
// THE LOAD-BEARING DISTINCTION (CDR-066 §6-G15): "this company has no usable policy" is an ANSWER, and the answer
// is DENY. It is NOT an unavailability. The difference matters because of the Phase 5 dispatcher waiver: an
// `unavailable` policy answer on an informational-class tool over a trusted path is still WAIVED, so modelling a
// missing policy as unavailability would let a company with no policy run AI actions ungoverned. Unavailability is
// reserved for "no result was produced at all" — which, in this module, means a thrown error.
import { PolicyRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext } from '@acbp/database';
import {
  DEFAULT_NEW_COMPANY_POLICY,
  evaluatePolicy,
  policyEvaluated,
  policyBlocked,
  policyUnavailable,
  policyChanged,
  type PolicyDecision,
  type PolicyObservations,
} from '@acbp/contracts';
import { runInCompanyScope } from '../company/company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import type { Logger } from '@acbp/observability';

/** The three mandatory evaluation points (APPROVAL-AND-POLICY-ARCHITECTURE §5). CLOSED. */
export const EVALUATION_POINTS = ['proposed', 'approval_requested', 'pre_execution'] as const;
export type EvaluationPoint = (typeof EVALUATION_POINTS)[number];

/** Why no usable policy was found. CLOSED — a reason, never an exception message. */
export const NO_USABLE_POLICY_REASONS = ['no_active_policy', 'policy_unreadable'] as const;
export type NoUsablePolicyReason = (typeof NO_USABLE_POLICY_REASONS)[number];

export interface PolicyServiceOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

export interface EvaluateCompanyPolicyParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly evaluationPoint: EvaluationPoint;
  /** The observed facts, each carrying its provenance (CDR-066 §3-G5). */
  readonly observations: PolicyObservations;
  /** THE INSTANT, passed in (CDR-066 §3-G3). Nothing here reads a clock. */
  readonly evaluatedAt: Date;
  /** Only evaluation point 3 has one. */
  readonly toolCallId?: string | null;
}

export type EvaluateCompanyPolicyResult =
  | {
      readonly status: 'decided';
      readonly decision: PolicyDecision;
      readonly escalate: boolean;
      readonly policyVersion: number;
      readonly evaluationId: string;
      readonly firedRuleIds: readonly string[];
      readonly unevaluableRuleIds: readonly string[];
      readonly untrustedRuleIds: readonly string[];
    }
  /**
   * The engine ran and found no rules it could use. **THIS IS A DENIAL** (CDR-066 §6-G15) — it is a separate status
   * from `decided` only because there is no evaluation row to cite, not because it is any less refusing.
   */
  | { readonly status: 'no_usable_policy'; readonly reason: NoUsablePolicyReason }
  | { readonly status: 'forbidden' };

/**
 * Map a result onto the dispatcher's gate vocabulary.
 *
 * SUPPLIED HERE, TESTED HERE, so the mapping cannot be got wrong somewhere else. Every result this service returns
 * is either `allow` or `deny` — nothing maps to `unavailable`, because a result IS an answer. Unavailability means
 * no result at all, which in this module is a thrown error, and a caller's catch is what turns that into
 * `unavailable`. That is TOOL-003's *"engine unreachable ⇒ deny (fail closed)"*, kept honest.
 *
 * `require_approval` maps to **allow** on the POLICY gate, and that is deliberate: the policy gate is not the
 * approval gate. The approval requirement is carried by the approval gate, which after CDR-066 §0's fix is no
 * longer waived once policy has answered. Mapping `require_approval` to `deny` here would refuse actions a human is
 * perfectly entitled to approve.
 */
export function toPolicyGateKind(result: EvaluateCompanyPolicyResult): 'allow' | 'deny' {
  if (result.status !== 'decided') return 'deny';
  return result.decision === 'deny' ? 'deny' : 'allow';
}

function opts(o: PolicyServiceOptions): { correlationId?: string; logger?: Logger } {
  return { ...(o.correlationId !== undefined ? { correlationId: o.correlationId } : {}), ...(o.logger !== undefined ? { logger: o.logger } : {}) };
}
function auditCtx(o: PolicyServiceOptions): Partial<AuditWriteContext> {
  return { actorType: 'system', ...(o.correlationId !== undefined ? { correlationId: o.correlationId } : {}) };
}

/**
 * Evaluate the company's active policy.
 *
 * AUDIT-OR-NOTHING (ADR-015): the evaluation row and its audit event are ONE transaction. An evaluation recorded
 * without its event, or an event without its row, would be a trail that disagrees with itself — and POL-006 exists
 * precisely so that trail can be trusted.
 *
 * `run:execute`, matching `preflightRun` and the dispatcher: evaluation happens on the execution path on behalf of
 * a run. Setting the policy is a different authority (`policy:manage`) — see {@link initializeCompanyPolicy}.
 */
export async function evaluateCompanyPolicy(client: DatabaseClient, params: EvaluateCompanyPolicyParams, options: PolicyServiceOptions = {}): Promise<EvaluateCompanyPolicyResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<EvaluateCompanyPolicyResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const policies = new PolicyRepository(scope.db);
      const active = await policies.findActive(scope.tenant.companyId);

      // NO ACTIVE POLICY. A refusal, and one the operator must see — TOOL-003 attaches an owner notification to it.
      // No `policy_evaluations` row: there were no rules to cite, and the version-pinning FK has nothing to pin to
      // (CDR-066 §6-G16).
      if (active === undefined) {
        await audit(scope, policyUnavailable({ companyId: scope.tenant.companyId, reason: 'no_active_policy', evaluationPoint: params.evaluationPoint }), auditCtx(options));
        options.logger?.warn('policy.no_active_policy', { metadata: { accountId: params.accountId, companyId: params.companyId } });
        return { status: 'no_usable_policy', reason: 'no_active_policy' };
      }

      const ruleSet = { version: active.version, baseline: active.baseline, rules: active.rules };
      const evaluation = evaluatePolicy(ruleSet, params.observations);

      // `policyVersion === null` means the evaluator could not read the rule set at all — a stored policy that is
      // not a policy. Distinct from "it evaluated and denied", and it gets the unavailability event for the same
      // reason as the branch above: someone has to fix it, and nothing about it is a normal outcome.
      if (evaluation.policyVersion === null) {
        await audit(scope, policyUnavailable({ companyId: scope.tenant.companyId, reason: 'policy_unreadable', evaluationPoint: params.evaluationPoint }), auditCtx(options));
        options.logger?.error('policy.unreadable', { metadata: { accountId: params.accountId, companyId: params.companyId, policyVersion: active.version } });
        return { status: 'no_usable_policy', reason: 'policy_unreadable' };
      }

      const recorded = await policies.recordEvaluation({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        policyId: active.id,
        policyVersion: active.version,
        evaluationPoint: params.evaluationPoint,
        decision: evaluation.decision,
        escalate: evaluation.escalate,
        firedRuleIds: evaluation.firedRuleIds,
        unevaluableRuleIds: evaluation.unevaluableRuleIds,
        untrustedRuleIds: evaluation.untrustedRuleIds,
        evaluatedAt: params.evaluatedAt,
        toolCallId: params.toolCallId ?? null,
      });

      await audit(scope, policyEvaluated({ evaluationId: recorded.id, policyVersion: active.version, decision: evaluation.decision, evaluationPoint: params.evaluationPoint }), auditCtx(options));
      // A DENIAL gets its own event as well. Canon routes `policy.blocked` to the Decision Room and the activity
      // feed (P6-008) while `policy.evaluated` is the record, and a reader counting refusals must not have to parse
      // metadata to find them.
      if (evaluation.decision === 'deny') {
        await audit(scope, policyBlocked({ evaluationId: recorded.id, policyVersion: active.version, reason: 'policy_denied', evaluationPoint: params.evaluationPoint }), auditCtx(options));
      }

      return {
        status: 'decided',
        decision: evaluation.decision,
        escalate: evaluation.escalate,
        policyVersion: active.version,
        evaluationId: recorded.id,
        firedRuleIds: evaluation.firedRuleIds,
        unevaluableRuleIds: evaluation.unevaluableRuleIds,
        untrustedRuleIds: evaluation.untrustedRuleIds,
      };
    },
    opts(options),
  );
  // A scope that could not be established is a REFUSAL, never a pass-through.
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface InitializeCompanyPolicyParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
}

export type InitializeCompanyPolicyResult =
  | { readonly status: 'ok'; readonly policyId: string; readonly version: number }
  /** The company already has an active policy. Not an error — initialization is idempotent by intent. */
  | { readonly status: 'already_initialized'; readonly policyId: string; readonly version: number }
  | { readonly status: 'forbidden' };

/**
 * Give a company the owner-ruled starting policy (CDR-066 §3-G10).
 *
 * OWNER-ONLY (`policy:manage`). Deciding what a company may do unsupervised is a different authority from doing it;
 * a worker holding `run:execute` must not be able to rewrite the policy it is about to be judged by.
 *
 * SEEDS THE RULED DEFAULT AND NOTHING ELSE. Editing limits — spending, message, usage, working hours — belongs to
 * `ACBP-P6-010`, and AOQ-14's values remain the owner's (CDR-066 §3-G8/G19).
 */
export async function initializeCompanyPolicy(client: DatabaseClient, params: InitializeCompanyPolicyParams, options: PolicyServiceOptions = {}): Promise<InitializeCompanyPolicyResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<InitializeCompanyPolicyResult> => {
      if (checkAuthorization(role, 'policy:manage', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const policies = new PolicyRepository(scope.db);
      const existing = await policies.findActive(scope.tenant.companyId);
      if (existing !== undefined) return { status: 'already_initialized', policyId: existing.id, version: existing.version };

      const created = await policies.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        version: DEFAULT_NEW_COMPANY_POLICY.version,
        baseline: DEFAULT_NEW_COMPANY_POLICY.baseline,
        rules: DEFAULT_NEW_COMPANY_POLICY.rules,
        createdByUserId: params.userId,
      });
      if (created === undefined) {
        // The (company, version) uniqueness fired: a concurrent initializer committed between the read and this
        // insert. Their policy stands and the caller is told so — throwing would be wrong, because the caller's
        // intent (this company has a policy) is satisfied.
        const winner = await policies.findActive(scope.tenant.companyId);
        if (winner === undefined) throw new Error('policy initialization was refused but no active policy exists — invariant violated');
        return { status: 'already_initialized', policyId: winner.id, version: winner.version };
      }

      // Scalars only, and never the rules themselves — those are the policy's content, and audit metadata is not
      // where content lives.
      await audit(scope, policyChanged({ policyId: created.id, version: created.version, baseline: created.baseline, ruleCount: DEFAULT_NEW_COMPANY_POLICY.rules.length }), auditCtx(options));
      options.logger?.info('policy.initialized', { metadata: { accountId: params.accountId, companyId: params.companyId, version: created.version } });
      return { status: 'ok', policyId: created.id, version: created.version };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
