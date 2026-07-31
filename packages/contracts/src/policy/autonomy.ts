// @acbp/contracts — autonomy levels (ACBP-P6-006a; CDR-071; APPR-008; MASTER-PRD-v1.md §12 and §11.5). Zero-dep
// and PURE.
//
// AN AUTONOMY LEVEL IS A PROFILE, NOT A DIMENSION (CDR-071 §2-G1). `POLICY_DIMENSIONS` is closed and taken from
// ADR-010 §5; a dimension is something an observed fact is compared against, whereas the level is the configuration
// deciding which rules exist at all. Putting it in the dimension list would let a company's rule set contain a rule
// about its own autonomy level, which is a loop with no defined meaning.
//
// THE RULES BELOW RESTRICT AND NEVER GRANT, which is what makes composition safe (CDR-071 §2-G2). A level's rules
// are evaluated IN ADDITION to a company's stored rules, and the evaluator combines verdicts most-restrictive-wins.
// So adding a level can only ever tighten. That property is the whole reason this module returns rules rather than a
// whole `PolicyRuleSet`: a rule set carries a `baseline`, and a baseline REPLACES rather than restricts — composing
// baselines would let a level loosen a policy, which is the one thing it must never do.
import type { PolicyRule } from './evaluate.js';
import { RISK_CLASSES } from '../tools/risk-class.js';

/**
 * The five levels of PRD §12, ordered MOST → LEAST restrictive. The order is the contract: level 1 asks about
 * everything, and each step up asks about less.
 */
export const AUTONOMY_LEVELS = [1, 2, 3, 4, 5] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

/** The levels MVP actually ships (PRD §11.5: *"the MVP approval system implements autonomy levels 1–2 only"*). */
export const MVP_AUTONOMY_LEVELS = [1, 2] as const;
export type MvpAutonomyLevel = (typeof MVP_AUTONOMY_LEVELS)[number];

/**
 * The level an unusable value resolves to (CDR-071 §2-G4).
 *
 * DERIVED FROM THE LIST rather than written as `1`, for the same reason `MOST_RESTRICTIVE_RISK_CLASS` is derived:
 * a hand-written literal is the one place a re-ordering would silently miss, and missing it here means an action
 * executing without a human saying yes.
 */
export const MOST_RESTRICTIVE_AUTONOMY_LEVEL: AutonomyLevel = AUTONOMY_LEVELS[0];

/**
 * What each level MEANS, in a sentence a founder can act on.
 *
 * PRD principle 2 is *"autonomy is only legitimate when granted knowingly"*, and its named failure is *"user enables
 * 'full auto' without understanding it can email people"*. A number alone cannot be granted knowingly, so the
 * consequence travels with the level and is part of the contract rather than UI copy invented later.
 */
export const AUTONOMY_LEVEL_CONSEQUENCES: Readonly<Record<AutonomyLevel, string>> = {
  1: 'Propose only. Your AI team drafts and recommends, and nothing at all runs until you approve it.',
  2: 'Research and internal drafts run on their own; anything that leaves the platform or spends money still asks you first.',
  3: 'Not available yet. Would let you pre-authorize whole categories of external action in advance.',
  4: 'Not available yet. Would let external actions run inside limits you set, without asking each time.',
  5: 'Not available yet. Broadest autonomy — and even here, sensitive or irreversible actions always ask.',
};

/**
 * The level a NEWLY PROVISIONED company starts at (CDR-071 §2-G3).
 *
 * **This is not the same decision as {@link MOST_RESTRICTIVE_AUTONOMY_LEVEL}, and the difference is deliberate.**
 * The owner ruled the default posture on 2026-07-29 — `DEFAULT_NEW_COMPANY_POLICY` already implements exactly this
 * level — with the recorded reasoning that a new company should be able to do useful internal work on day one
 * without configuration, while nothing that reaches outside the platform or spends money happens without a human
 * saying yes.
 *
 * So a new company starts at 2 because that is RULED, whereas a corrupt or unreadable stored level collapses to 1
 * because that is UNKNOWN. Defaulting new companies to 1 would read as the safer choice and would in fact be an
 * unaccepted change to an owner decision.
 */
export const DEFAULT_NEW_COMPANY_AUTONOMY_LEVEL: MvpAutonomyLevel = 2;

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return typeof value === 'number' && Number.isInteger(value) && (AUTONOMY_LEVELS as readonly number[]).includes(value);
}

export function isMvpAutonomyLevel(value: unknown): value is MvpAutonomyLevel {
  return isAutonomyLevel(value) && (MVP_AUTONOMY_LEVELS as readonly number[]).includes(value);
}

/**
 * Resolve a stored value to a level, collapsing anything unusable to the most restrictive one (CDR-071 §2-G4).
 *
 * "Unusable" is absent, non-integer, out of range, or a string a driver failed to coerce — every way the column can
 * come back wrong. NONE of them may read as "no restriction applies", which is why this is a total function with no
 * throw: a caller that had to catch could forget to, and the forgetting would fail open.
 *
 * This is NOT the same decision as the DEFAULT for a new company, which is level 2 and is the owner's (CDR-071
 * §2-G3). Corrupt data is not a configuration anyone chose.
 */
export function resolveAutonomyLevel(value: unknown): AutonomyLevel {
  return isAutonomyLevel(value) ? value : MOST_RESTRICTIVE_AUTONOMY_LEVEL;
}

// The least restrictive class, derived so that "every class, including the lowest" cannot drift if RISK_CLASSES is
// re-ordered. `risk_at_least` against it holds for every class, which is how level 1 reaches everything.
const LEAST_RESTRICTIVE_RISK_CLASS = RISK_CLASSES[0];

const LEVEL_1_RULES: readonly PolicyRule[] = [
  {
    // PRD §12, level 1, every row: "propose only" / "propose". Nothing executes without a human decision.
    id: 'autonomy-l1-approval-for-every-class',
    dimension: 'risk_class',
    condition: 'risk_at_least',
    operand: LEAST_RESTRICTIVE_RISK_CLASS,
    decision: 'require_approval',
  },
];

const LEVEL_2_RULES: readonly PolicyRule[] = [
  {
    // PRD §12, level 2: informational and internal-reversible execute; external and sensitive still ask. This is the
    // same threshold the owner ruled for `DEFAULT_NEW_COMPANY_POLICY` on 2026-07-29 — deliberately the same
    // behaviour, because two definitions of "what executes without asking" is one too many (CDR-071 §1).
    //
    // An UNCLASSIFIED action resolves to the most restrictive class (TOOL-001) and so fires this too, which is the
    // safe reading and needs no rule of its own.
    id: 'autonomy-l2-approval-above-internal',
    dimension: 'risk_class',
    condition: 'risk_at_least',
    operand: 'external_reversible',
    decision: 'require_approval',
  },
];

/**
 * The rules a level contributes, to be evaluated ALONGSIDE a company's stored rules.
 *
 * Levels 3–5 yield the LEVEL 1 rules (CDR-071 §2-G5). They are storable so later levels are additive, but they are
 * not implemented, and the only safe reading of "a level whose semantics do not exist yet" is the most restrictive
 * one. A row that somehow holds a 4 therefore behaves as propose-only rather than as something more permissive than
 * anything MVP ships. The service refuses 3–5 outright; this is the second line of that defence, and it is here
 * because a database row can arrive without ever passing through the service.
 */
export function autonomyLevelRules(level: unknown): readonly PolicyRule[] {
  const resolved = resolveAutonomyLevel(level);
  if (resolved === 2) return LEVEL_2_RULES;
  return LEVEL_1_RULES;
}
