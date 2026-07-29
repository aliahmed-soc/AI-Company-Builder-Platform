// @acbp/contracts — the deterministic policy evaluator (ACBP-P6-001a; CDR-066 §3-G3/G5/G6/G7/G8; ADR-010; POL-001/
// 005/006; PRD principle 17). Zero-dep and PURE.
//
// "DETERMINISTIC, VERSIONED, FAIL-CLOSED" is ADR-010's own three-word summary, and each word is a design constraint
// here:
//
//   DETERMINISTIC — this is a FUNCTION OF ITS ARGUMENTS. No clock, no counters read from anywhere, no randomness.
//                   The evaluating instant, the usage counters, the stop state and the integration status are all
//                   OBSERVATIONS passed in. That is the whole of the acceptance clause "same inputs same decision":
//                   it is trivially true of a function with no hidden state and unprovable of one with any. A
//                   working-hours rule is the temptation — an evaluator that read the clock itself would be
//                   untestable at 3am and would give two different answers to one recorded evaluation.
//
//   VERSIONED     — every result names the rule-set version that produced it, because an evaluation that cannot say
//                   which rules decided it cannot be audited after the rules change, which is exactly when someone
//                   asks.
//
//   FAIL-CLOSED   — a rule this module cannot evaluate contributes DENY and is NAMED in the result. It is never
//                   skipped. Skipping is the rule-gap failure ADR-010 §10 warns about: a restriction nobody could
//                   check silently becomes a restriction that did not apply.
//
// NO DEFAULT LIMIT VALUES LIVE HERE (CDR-066 §3-G8). ADR-010 §15's one open question is AOQ-14, "initial default
// limits", and it is the owner's. A plausible-looking default would answer it silently, and a default limit is a
// statement about when a founder's money is spent without asking them.
import { resolveRiskClass, isAtLeastAsRestrictiveAs } from '../tools/risk-class.js';
import { combinePolicyVerdicts, isPolicyDecision, type PolicyDecision, type PolicyVerdict } from './decision.js';

/**
 * The dimensions a rule may be about. CLOSED, and taken from canon rather than invented here — every member appears
 * in `APPROVAL-AND-POLICY-ARCHITECTURE §4` or ADR-010 §5, with its requirement id where canon gives one.
 */
export const POLICY_DIMENSIONS = [
  'spending_limit', // POL-001
  'message_limit', // POL-002
  'allowed_destinations', // POL-003
  'working_hours', // POL-004
  'forbidden_action', // POL-005
  'risk_class', // APPR-001
  'allowed_tools', // worker allowlist interplay
  'emergency_stop', // ADMIN-001
  'integration_status', // INTEG-003
  'usage_limit', // NFR-015
  'data_sensitivity',
  'required_roles', // POL-007 (future)
] as const;
export type PolicyDimension = (typeof POLICY_DIMENSIONS)[number];

/**
 * The dimensions a model's word is never good enough for.
 *
 * ADR-010 §5, verbatim: *"trust-critical determinations (risk class, spend, destination, forbidden match) come from
 * the tool registry and structured payload fields, not model text."* This constant is that sentence, and nothing
 * more — widening it would be inventing distrust canon did not ask for, and narrowing it would be the opposite.
 */
export const TRUST_CRITICAL_DIMENSIONS: readonly PolicyDimension[] = ['spending_limit', 'allowed_destinations', 'forbidden_action', 'risk_class'];

/** Where an observed value came from. `model` is the untrusted one (PRD principle 17). */
export const FACT_PROVENANCES = ['registry', 'structured', 'model'] as const;
export type FactProvenance = (typeof FACT_PROVENANCES)[number];

/**
 * The comparison shapes a rule may use. CLOSED and deliberately small.
 *
 * Four shapes cover every MVP dimension ADR-010 §5 marks in bold, and a small closed set is what keeps the evaluator
 * provably total. A richer rule language is a bigger surface to get wrong, and getting this one wrong means a
 * restriction that does not fire.
 */
export const POLICY_CONDITIONS = ['at_or_over_limit', 'risk_at_least', 'flag_is_set', 'not_in_allowlist'] as const;
export type PolicyCondition = (typeof POLICY_CONDITIONS)[number];

/** An observed value plus where it came from. The wrapper is REQUIRED — see {@link evaluatePolicy}. */
export interface ProvenancedFact {
  readonly value: unknown;
  readonly provenance: FactProvenance;
}

export type PolicyObservations = Readonly<Partial<Record<PolicyDimension, ProvenancedFact>>>;

/**
 * One rule. It yields `decision` when its condition HOLDS, and contributes nothing when it does not.
 *
 * Rules restrict; they do not grant. A rule that does not fire leaves the action exactly as unpermitted as it was,
 * which is why an all-quiet rule set still denies (`combinePolicyVerdicts` over an empty set).
 */
export interface PolicyRule {
  readonly id: string;
  readonly dimension: PolicyDimension;
  readonly condition: PolicyCondition;
  /** The threshold, allowlist or (for `flag_is_set`) nothing. Shape depends on `condition`. */
  readonly operand?: unknown;
  readonly decision: PolicyDecision;
  readonly escalate?: boolean;
}

/**
 * A versioned rule set. The version is what an evaluation record cites (POL-006).
 *
 * `baseline` is REQUIRED and is the decision when no rule restricts (CDR-066 §3-G9). It exists because rules only
 * ever restrict, so without it the engine could never return `allow` — and ADR-010 plainly expects `allow` to be a
 * possible output. It is a FIELD rather than a constant here for the reason G8 gives about limits: a baseline is a
 * statement about what a company may do unsupervised, so it belongs to whoever configures the policy, not to this
 * module. There is deliberately no default: an absent or unreadable baseline makes the whole rule set unreadable,
 * which denies.
 */
export interface PolicyRuleSet {
  readonly version: number;
  readonly baseline: PolicyDecision;
  readonly rules: readonly PolicyRule[];
}

export interface PolicyEvaluation {
  readonly decision: PolicyDecision;
  readonly escalate: boolean;
  /** `null` ONLY when the rule set itself could not be read — never for an empty-but-valid set. */
  readonly policyVersion: number | null;
  readonly firedRuleIds: readonly string[];
  /** Rules that could not be evaluated. Each contributed a DENY; none was skipped. */
  readonly unevaluableRuleIds: readonly string[];
  /** Rules that fired only because their input was model-sourced on a trust-critical dimension (G5). */
  readonly untrustedRuleIds: readonly string[];
}

/**
 * The policy a newly provisioned company starts with (CDR-066 §3-G10). **OWNER-RULED, 2026-07-29** — the value is
 * the owner's decision, not this module's default:
 *
 *   *"informational and internal-reversible actions are allowed by default; anything at a higher risk class requires
 *   approval; nothing is denied outright by the baseline alone (specific deny rules can still be added on top)."*
 *
 * The owner's reasoning, recorded so a later reader can weigh a change against it: a new company should be able to do
 * useful internal work — research, drafting, planning — on day one without configuration, but nothing that reaches
 * outside the platform or spends money should happen without a human saying yes.
 *
 * WHY A CONSTANT AND NOT A PARAGRAPH IN THE CDR. P6-001b/c would otherwise re-implement this from prose, and the
 * wrong threshold class would silently let external writes through unapproved. Here it is executable and tested.
 *
 * THIS IS NOT AOQ-14. The owner has ruled the baseline POSTURE; the specific limit values (spending, message, usage,
 * working hours) remain unruled and are deliberately absent — there is no numeric threshold on any limit dimension
 * below, and a test asserts it.
 *
 * The threshold names `external_reversible`, which is the one place CDR-051 §0.3's unruled class split appears. The
 * comparison is ORDINAL, so collapsing that split back to canon's plain `external` would be a rename here and would
 * not change which actions are gated.
 */
export const DEFAULT_NEW_COMPANY_POLICY: PolicyRuleSet = {
  version: 1,
  // Permissive, deliberately: the RULE below is what withholds the risky classes. Denial is left entirely to rules a
  // company adds on top, which is exactly what "nothing is denied outright by the baseline alone" means.
  baseline: 'allow',
  rules: [
    {
      id: 'baseline-risk-approval',
      dimension: 'risk_class',
      condition: 'risk_at_least',
      // Fires for external_reversible and sensitive_irreversible, and nothing below — "anything at a higher risk
      // class". An UNCLASSIFIED action resolves to the most restrictive class (TOOL-001) and so fires too, which is
      // the safe reading and needs no rule of its own.
      operand: 'external_reversible',
      decision: 'require_approval',
    },
  ],
};

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isRuleSet(value: unknown): value is PolicyRuleSet {
  const c = value as { version?: unknown; baseline?: unknown; rules?: unknown } | null | undefined;
  // An unreadable BASELINE is as fatal as an unreadable version. A rule set whose default posture we cannot
  // determine is not a rule set we may act on, and assuming the permissive reading is the one mistake here.
  return typeof c === 'object' && c !== null && isFiniteNumber(c.version) && isPolicyDecision(c.baseline) && Array.isArray(c.rules);
}

function isWellFormedRule(rule: unknown): rule is PolicyRule {
  const r = rule as Partial<PolicyRule> | null | undefined;
  if (typeof r !== 'object' || r === null) return false;
  if (typeof r.id !== 'string' || r.id.trim() === '') return false;
  if (!(POLICY_DIMENSIONS as readonly string[]).includes(r.dimension as string)) return false;
  if (!(POLICY_CONDITIONS as readonly string[]).includes(r.condition as string)) return false;
  return isPolicyDecision(r.decision);
}

/** `undefined` means "cannot tell" — which is NOT the same as `false`, and never resolves to it. */
function conditionHolds(rule: PolicyRule, observed: unknown): boolean | undefined {
  switch (rule.condition) {
    case 'at_or_over_limit':
      // AT the limit counts as reaching it. Both sides must be real finite numbers: a string "100" is a caller
      // mistake, and coercing it would decide a spending question on a type conversion.
      return isFiniteNumber(observed) && isFiniteNumber(rule.operand) ? observed >= rule.operand : undefined;
    case 'risk_at_least':
      // COMPARISON on the ordered set, never equality against a literal (CDR-066 §3-G7). `resolveRiskClass` maps an
      // unclassified value to the most restrictive class (TOOL-001), so unclassified needs no rule of its own.
      return isAtLeastAsRestrictiveAs(resolveRiskClass(observed), rule.operand);
    case 'flag_is_set':
      // Strictly boolean. A truthy string is unevaluable rather than quietly "set" — this shape carries the
      // emergency stop, and guessing there is not acceptable.
      return typeof observed === 'boolean' ? observed : undefined;
    case 'not_in_allowlist':
      // An operand that is not a list cannot express an allowlist. Reading that as "everything is allowed" is the
      // permission leak this branch exists to refuse.
      return Array.isArray(rule.operand) ? !rule.operand.includes(observed) : undefined;
    default:
      return undefined;
  }
}

/**
 * Evaluate a versioned rule set against observed facts. TOTAL over `unknown` and deny-by-default throughout.
 *
 * @param ruleSet     a {@link PolicyRuleSet}; anything unreadable denies with `policyVersion: null`.
 * @param observations per-dimension {@link ProvenancedFact}s. A bare value with no provenance wrapper is
 *                     UNEVALUABLE, not assumed trustworthy — provenance is not optional metadata here, it is the
 *                     thing that decides whether a model's word can move a gate.
 */
export function evaluatePolicy(ruleSet: unknown, observations: unknown): PolicyEvaluation {
  const fired: string[] = [];
  const unevaluable: string[] = [];
  const untrusted: string[] = [];

  // An unreadable rule set is NOT an empty one. Reporting version `null` and denying keeps "we could not read the
  // policy" distinguishable from "the policy permitted nothing", which are different operational problems.
  if (!isRuleSet(ruleSet)) {
    return { decision: 'deny', escalate: false, policyVersion: null, firedRuleIds: [], unevaluableRuleIds: [], untrustedRuleIds: [] };
  }

  const obs = (typeof observations === 'object' && observations !== null ? observations : {}) as Record<string, unknown>;
  // SEEDED WITH THE BASELINE, so an all-quiet rule set returns what the policy says it should rather than a value
  // chosen here. Every rule below can only push the result MORE restrictive (`combinePolicyVerdicts` takes the
  // maximum), so a permissive baseline is a starting point that any firing or unevaluable rule overrides.
  const verdicts: PolicyVerdict[] = [{ decision: ruleSet.baseline, escalate: false }];

  for (const [index, candidate] of ruleSet.rules.entries()) {
    // A malformed rule cannot be skipped, and it may not even have a usable id — so it still gets counted, under a
    // positional label. A rule vanishing for want of a name is a restriction silently not applying.
    if (!isWellFormedRule(candidate)) {
      const label = typeof (candidate as { id?: unknown } | undefined)?.id === 'string' ? String((candidate as { id: string }).id) : `rule[${index}]`;
      unevaluable.push(label);
      verdicts.push({ decision: 'deny', escalate: false });
      continue;
    }

    const fact = obs[candidate.dimension] as ProvenancedFact | undefined;
    // No observation, or one that is not a provenance wrapper: the rule's input is missing, so the rule is
    // unevaluable. This is the case most likely to be written as "skip it", and the one where skipping is worst.
    if (typeof fact !== 'object' || fact === null || !('value' in fact) || !('provenance' in fact)) {
      unevaluable.push(candidate.id);
      verdicts.push({ decision: 'deny', escalate: false });
      continue;
    }

    // MODEL-SOURCED ON A TRUST-CRITICAL DIMENSION (G5). ADR-010 §5: treat it as untrusted and take the most
    // restrictive applicable path — which, for a rule that restricts, means assuming the restricted case holds.
    // An UNRECOGNISED provenance lands here too: anything we cannot place is not trusted.
    const trustworthy = fact.provenance === 'registry' || fact.provenance === 'structured';
    if (!trustworthy && TRUST_CRITICAL_DIMENSIONS.includes(candidate.dimension)) {
      fired.push(candidate.id);
      untrusted.push(candidate.id);
      verdicts.push({ decision: candidate.decision, escalate: candidate.escalate === true });
      continue;
    }

    const holds = conditionHolds(candidate, fact.value);
    if (holds === undefined) {
      unevaluable.push(candidate.id);
      verdicts.push({ decision: 'deny', escalate: false });
      continue;
    }
    if (holds) {
      fired.push(candidate.id);
      verdicts.push({ decision: candidate.decision, escalate: candidate.escalate === true });
    }
    // A rule that does not hold contributes NOTHING — not an `allow`. Contributing `allow` would let one satisfied
    // restriction vote down another rule's refusal, which is the inversion POL-005 exists to prevent.
  }

  const combined = combinePolicyVerdicts(verdicts);
  return {
    decision: combined.decision,
    escalate: combined.escalate,
    policyVersion: ruleSet.version,
    firedRuleIds: fired,
    unevaluableRuleIds: unevaluable,
    untrustedRuleIds: untrusted,
  };
}
