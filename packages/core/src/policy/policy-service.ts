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
import { PolicyRepository, writeAuditEvent, type DatabaseClient, type AuditWriteContext, type TenantScope } from '@acbp/database';
import {
  DEFAULT_NEW_COMPANY_POLICY,
  DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL,
  autonomyLevelRules,
  resolveAutonomyLevel,
  isAutonomyLevel,
  isMvpAutonomyLevel,
  AUTONOMY_LEVELS,
  AUTONOMY_LEVEL_CONSEQUENCES,
  type AutonomyLevel,
  type MvpAutonomyLevel,
  evaluatePolicy,
  resolvePolicyDecision,
  policyEvaluated,
  policyBlocked,
  policyUnavailable,
  policyChanged,
  type PolicyDecision,
  type PolicyObservations,
  type PolicyGateAnswer,
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
      /**
       * The policy that decided, reported ALONGSIDE the version because they travel together (ACBP-P6-003c).
       *
       * An approval request stores the decision context behind a tenant- AND version-pinned composite FK, so a
       * consumer holding only the version cannot satisfy it — and re-reading the active policy to recover the id
       * would reintroduce exactly the drift that composite FK exists to prevent.
       */
      readonly policyId: string;
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
 * `require_approval` maps to **`require_approval`** — it is a `kind` on the gate answer, not a fourth thing this
 * function has to flatten (ACBP-P6-002; CDR-067 §2-G7/G8). Both flattenings were wrong and for opposite reasons:
 * onto `allow` is exactly the CDR-066 §0 bypass, and onto `deny` would refuse actions a human is entitled to
 * approve. Carrying the requirement ON the answer is also what makes it unforgeable — there is no separate
 * `approvalRequired` fact for a caller to supply.
 */
export function toPolicyGateAnswer(result: EvaluateCompanyPolicyResult): PolicyGateAnswer {
  // NOT "decided" means the engine found no usable rules, or the caller was not entitled to ask. Both DENY
  // (CDR-066 s6-G15), and neither is "unavailable" - that value is WAIVABLE at the dispatcher, which is precisely
  // the mistake that section exists to prevent.
  if (result.status !== 'decided') return { kind: 'deny' };
  // The engine's three outputs pass through UNFLATTENED. Collapsing "require_approval" onto "allow" is exactly what
  // created the CDR-066 s0 bypass; collapsing it onto "deny" would refuse actions a human is entitled to approve.
  //
  // RESOLVED, NOT FORWARDED (CDR-067 s2-G10). This was the only link between stored policy and the dispatcher gate
  // that was not total over `unknown`, and the value an unreadable decision landed on was `unavailable` - the one
  // gate value the waiver spares. So the failure mode was not a wrong denial, it was an informational call
  // proceeding on a decision nobody could read. Raised by the loosening's independent review; nothing reached it
  // today because the evaluator routes every decision through this same resolver, which is exactly why the guard is
  // cheap: it costs one call and removes a class of future defect entirely.
  return { kind: resolvePolicyDecision(result.decision) };
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
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<EvaluateCompanyPolicyResult> => {
      if (checkAuthorization(role, 'run:execute', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };
      return evaluatePolicyInScope(scope, params, options);
    },
    opts(options),
  );
  // A scope that could not be established is a REFUSAL, never a pass-through.
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}


/**
 * Evaluate inside an ALREADY-ESTABLISHED scope (ACBP-P6-002; CDR-067 §2-G2).
 *
 * Extracted so the dispatcher — which is already inside `runInCompanyScope` and has already checked the same
 * `run:execute` action — can consult the engine without opening a transaction inside a transaction. Beyond the
 * mechanics, sharing one scope is what makes the evaluation, the tool-call record and every audit event commit or
 * roll back TOGETHER: a call recorded as authorized whose evaluation was rolled back would assert an authorization
 * that never happened.
 *
 * IT DOES NO AUTHORIZATION OF ITS OWN. Every caller must already have checked `run:execute` — `evaluateCompanyPolicy`
 * does it above, and the dispatcher does it before anything else.
 *
 * WHAT ACTUALLY PROTECTS IT is that it takes an already-authorized `TenantScope` — a caller cannot reach this
 * function without having opened one, and opening one is what runs the check. An earlier version of this comment
 * claimed the protection was that the function is not exported from the module index; review pass 2 correctly
 * rejected that, because deep cross-module imports are the norm in this codebase (~40 sites) and the very first
 * consumer, the dispatcher, imports it directly. The index omission is tidiness, not a barrier.
 */
export async function evaluatePolicyInScope(
  scope: TenantScope,
  params: Pick<EvaluateCompanyPolicyParams, 'accountId' | 'companyId' | 'evaluationPoint' | 'observations' | 'evaluatedAt' | 'toolCallId'>,
  options: PolicyServiceOptions = {},
): Promise<EvaluateCompanyPolicyResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
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

  // THE AUTONOMY LEVEL IS COMPOSED IN, NOT SUBSTITUTED (ACBP-P6-006; CDR-071 §2-G2). The level's rules are
  // evaluated ALONGSIDE the company's stored rules, and `evaluatePolicy` combines verdicts most-restrictive-wins —
  // so a level can only ever tighten. Prepended rather than appended only for readability of `firedRuleIds`; the
  // combination is order-independent by construction.
  //
  // `resolveAutonomyLevel` collapses an absent, corrupt or out-of-range column to the most restrictive level rather
  // than trusting it (§2-G4). The column is NOT NULL with a CHECK, so this should be unreachable — which is exactly
  // why it is here: the one path where being wrong means an action running without a human saying yes.
  //
  // THE `Array.isArray` GUARD IS LOAD-BEARING AND NOT DEFENSIVE CLUTTER. If the stored `rules` are not an array the
  // policy is UNREADABLE, and the branch below turns that into a refusal. Spreading level rules onto a non-array
  // would either throw or — far worse — produce a readable rule set containing ONLY the level's rules, quietly
  // converting a policy that refuses everything into one that permits informational work at level 2. An unreadable
  // policy must stay unreadable.
  const levelRules = autonomyLevelRules(resolveAutonomyLevel(active.autonomy_level));
  // `active.rules` is `unknown` (jsonb), and `Array.isArray` narrows it to `any[]` — spreading that would launder
  // an `any` into the rule set. Narrowed to `unknown[]` instead: the evaluator validates every rule anyway, and
  // anything it cannot read contributes DENY rather than being skipped.
  const storedRules: unknown = active.rules;
  const composedRules: unknown = Array.isArray(storedRules) ? [...levelRules, ...(storedRules as readonly unknown[])] : storedRules;
  const ruleSet = { version: active.version, baseline: active.baseline, rules: composedRules };
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
    policyId: active.id,
    firedRuleIds: evaluation.firedRuleIds,
    unevaluableRuleIds: evaluation.unevaluableRuleIds,
    untrustedRuleIds: evaluation.untrustedRuleIds,
  };
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
        // The owner's ruled posture, named (CDR-071 §2-G3). `DEFAULT_NEW_COMPANY_POLICY` already implemented this
        // level before it had a name; recording it makes the company's autonomy legible instead of implied, which is
        // what PRD principle 2's "granted knowingly" needs to be answerable at all.
        autonomyLevel: DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL,
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

// ── ACBP-P6-006: setting and reading the autonomy level (CDR-071; APPR-008) ─────────────────────────────────────

export interface SetCompanyAutonomyLevelParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Unvalidated on purpose — this is the boundary where an unavailable or nonsense level is REFUSED, not coerced. */
  readonly level: unknown;
  /** The instant, passed in. Nothing here reads a clock (CDR-066 §3-G3). */
  readonly at: Date;
}

/** Why a level change was refused. CLOSED — a reason, never an exception message. */
export const AUTONOMY_REFUSAL_REASONS = ['not_a_level', 'not_available_in_mvp', 'no_active_policy', 'superseded_concurrently'] as const;
export type AutonomyRefusalReason = (typeof AUTONOMY_REFUSAL_REASONS)[number];

export type SetCompanyAutonomyLevelResult =
  | { readonly status: 'ok'; readonly policyId: string; readonly version: number; readonly level: MvpAutonomyLevel }
  /** Already at that level. Idempotent by intent: no new version, because nothing changed. */
  | { readonly status: 'unchanged'; readonly policyId: string; readonly version: number; readonly level: MvpAutonomyLevel }
  | { readonly status: 'refused'; readonly reason: AutonomyRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * Change a company's autonomy level (CDR-071 §2-G5/G6).
 *
 * OWNER-ONLY (`policy:manage`), for the same reason `initializeCompanyPolicy` is: deciding what a company may do
 * unsupervised is a different authority from doing it. A worker holding `run:execute` raising its own autonomy is
 * the whole failure this phase exists to prevent.
 *
 * A CHANGE IS A NEW POLICY VERSION, NEVER AN IN-PLACE UPDATE. The rules and baseline are carried forward unchanged
 * and only the level differs, so the old version stays exactly as any past evaluation cited it. There is no UPDATE
 * grant on the column and this is the only path that can move it.
 *
 * LEVELS 3-5 ARE REFUSED BY NAME AND NEVER CLAMPED. A silent clamp to the nearest available level is the worst
 * outcome available here: a founder who asked for level 4 would be told nothing and would believe they had it.
 */
export async function setCompanyAutonomyLevel(
  client: DatabaseClient,
  params: SetCompanyAutonomyLevelParams,
  options: PolicyServiceOptions = {},
): Promise<SetCompanyAutonomyLevelResult> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<SetCompanyAutonomyLevelResult> => {
      if (checkAuthorization(role, 'policy:manage', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      // TWO DISTINCT REFUSALS, and collapsing them would lose the only information the caller can act on: "that is
      // not a level at all" and "that is a real level this release does not implement" need different answers.
      if (!isAutonomyLevel(params.level)) return { status: 'refused', reason: 'not_a_level' };
      if (!isMvpAutonomyLevel(params.level)) return { status: 'refused', reason: 'not_available_in_mvp' };

      const policies = new PolicyRepository(scope.db);
      const active = await policies.findActive(scope.tenant.companyId);
      if (active === undefined) return { status: 'refused', reason: 'no_active_policy' };

      // Compared through `resolveAutonomyLevel` rather than against the raw column: if the stored value were
      // unusable, treating it as "different" and writing a new version is right, and treating it as equal would
      // strand the company on an unreadable level forever.
      const current = resolveAutonomyLevel(active.autonomy_level);
      if (current === params.level) return { status: 'unchanged', policyId: active.id, version: active.version, level: params.level };

      // SUPERSEDE FIRST. The insert below would otherwise collide with the partial unique index that permits only
      // one active version per company, and a collision is a worse diagnostic than an ordered refusal.
      const superseded = await policies.supersede(active.id, params.at);
      // `undefined` means a concurrent writer superseded it between the read and here. Refused rather than retried:
      // the other writer's intent is unknown, and re-applying this level on top of a version we never saw could
      // silently undo a change made a millisecond earlier — including one that TIGHTENED autonomy.
      if (superseded === undefined) return { status: 'refused', reason: 'superseded_concurrently' };

      const created = await policies.insert({
        accountId: scope.tenant.accountId,
        companyId: scope.tenant.companyId,
        version: active.version + 1,
        // Carried forward VERBATIM. This use case changes the level and nothing else; rewriting rules here would
        // make one control silently edit another.
        baseline: active.baseline,
        rules: active.rules,
        autonomyLevel: params.level,
        createdByUserId: params.userId,
      });
      if (created === undefined) return { status: 'refused', reason: 'superseded_concurrently' };

      await audit(
        scope,
        policyChanged({ policyId: created.id, version: created.version, baseline: created.baseline, ruleCount: Array.isArray(active.rules) ? active.rules.length : 0 }),
        auditCtx(options),
      );
      options.logger?.info('policy.autonomy_level_changed', {
        metadata: { accountId: params.accountId, companyId: params.companyId, version: created.version, from: current, to: params.level },
      });
      return { status: 'ok', policyId: created.id, version: created.version, level: params.level };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}

export interface AutonomyLevelOption {
  readonly level: AutonomyLevel;
  /** Whether this release implements it. Levels 3–5 are visible and `false` (CDR-071 §2-G5). */
  readonly available: boolean;
  /** Plain language, because PRD principle 2 requires the consequence and not just the number. */
  readonly consequence: string;
  readonly current: boolean;
}

export type ReadCompanyAutonomyResult =
  | { readonly status: 'ok'; readonly current: AutonomyLevel; readonly options: readonly AutonomyLevelOption[] }
  | { readonly status: 'refused'; readonly reason: AutonomyRefusalReason }
  | { readonly status: 'forbidden' };

/**
 * The company's level plus every level that exists, with availability and consequence (CDR-071 §2-G5).
 *
 * THIS IS THE READ MODEL FOR "LEVELS 3-5 VISIBLE DISABLED" AND IT SHIPS NO INTERFACE. It returns the data a surface
 * would need; building that surface is an owner gate.
 *
 * `policy:manage` rather than a read permission: the consequence strings describe what the company will do without
 * asking, and the set of levels is a control surface, not general company data.
 */
export async function readCompanyAutonomy(
  client: DatabaseClient,
  params: Pick<SetCompanyAutonomyLevelParams, 'userId' | 'accountId' | 'companyId'>,
  options: PolicyServiceOptions = {},
): Promise<ReadCompanyAutonomyResult> {
  const ran = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<ReadCompanyAutonomyResult> => {
      if (checkAuthorization(role, 'policy:manage', { accountId: params.accountId, actorId: params.userId }, opts(options)).kind === 'deny') return { status: 'forbidden' };

      const active = await new PolicyRepository(scope.db).findActive(scope.tenant.companyId);
      if (active === undefined) return { status: 'refused', reason: 'no_active_policy' };

      // Reported through `resolveAutonomyLevel`, so what a reader is shown is what the ENGINE would actually apply.
      // Showing the raw column while the engine collapsed it would be a screen that lies about the company's safety.
      const current = resolveAutonomyLevel(active.autonomy_level);
      return {
        status: 'ok',
        current,
        options: AUTONOMY_LEVELS.map((level) => ({
          level,
          available: isMvpAutonomyLevel(level),
          consequence: AUTONOMY_LEVEL_CONSEQUENCES[level],
          current: level === current,
        })),
      };
    },
    opts(options),
  );
  return ran.kind === 'ran' ? ran.value : { status: 'forbidden' };
}
