// @acbp/contracts — the approval REQUEST (ACBP-P6-003a; CDR-068 §2; APPR-002, APPR-010; ADR-009).
//
// Zero-dep and PURE: this module builds and validates a request, it never stores one.
//
// WHAT A REQUEST IS FOR. `diagrams/08` names the content set verbatim — *"action, reason, expected result, data,
// cost, risk, reversibility, preview (APPR-002)"* — and the reason it is a SET rather than a suggestion is the
// requirement's own failure clause: *"Full-content requirement blocks incomplete requests."* A human is being asked
// to authorize something a machine proposed; the fields are the minimum needed to answer "should this happen?".
//
// WHAT A REQUEST IS NOT. It is not a bound, consumable token. Payload-hash binding, expiry, revocation and
// single-use consumption are ADR-009 §2 and ACBP-P6-004. A request records WHAT is proposed and under which policy
// version it was proposed; it does not yet bind the exact bytes that will execute.
import { resolveRiskClass, type RiskClass } from '../tools/risk-class.js';

/**
 * CLOSED. Canon §3's four scopes, in canon's order.
 *
 * All four are modelled and only two ship, which is canon's own instruction: *"Not all scopes ship in MVP … The
 * data model supports all four so later levels are additive."* Modelling two and widening the column later is a
 * migration and a backfill; modelling four and refusing two is a one-line change.
 */
export const APPROVAL_SCOPES = ['one_action', 'limited_batch', 'capability_category', 'bounded_operating_policy'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

/** The two canon marks MVP. The other two belong to autonomy levels 3–4, which MVP does not ship (PRD §11.5). */
export const MVP_APPROVAL_SCOPES: readonly ApprovalScope[] = ['one_action', 'limited_batch'];

export function isApprovalScope(value: unknown): value is ApprovalScope {
  return typeof value === 'string' && (APPROVAL_SCOPES as readonly string[]).includes(value);
}
export function isMvpApprovalScope(value: unknown): value is ApprovalScope {
  return isApprovalScope(value) && (MVP_APPROVAL_SCOPES as readonly string[]).includes(value);
}

/**
 * Whether the proposed action can be undone. CLOSED.
 *
 * DERIVED from the risk class, never supplied — see {@link reversibilityOf}.
 */
export const REVERSIBILITIES = ['reversible', 'irreversible'] as const;
export type Reversibility = (typeof REVERSIBILITIES)[number];

/**
 * Reversibility from the risk class, total over `unknown`.
 *
 * WHY DERIVED. Canon lists `risk` and `reversibility` as two separate content fields, and the naive
 * reading is two inputs. That reading lets a caller say `sensitive_irreversible` and `reversible` in the same breath
 * — the one combination a human must never be shown, because it invites approval of something presented as undoable
 * that is not. The risk-class vocabulary already encodes the answer in its own names, so there is nothing to decide
 * independently and therefore nothing to disagree about.
 *
 * UNREADABLE INPUT IS `irreversible`, matching `resolveRiskClass`'s most-restrictive rule: an action nobody can
 * classify is not assumed undoable.
 *
 * NOT §2-G4. This block used to cite CDR-068 §2-G4 for the derivation; §2-G4 is the preview-equals-execution gate,
 * which is NOT built (see `preview` below). The one gate number cited here was attached to the wrong decision while
 * the decision it names went unimplemented — the exact pairing that makes a citation worse than none.
 */
export function reversibilityOf(riskClass: unknown): Reversibility {
  return resolveRiskClass(riskClass) === 'sensitive_irreversible' ? 'irreversible' : 'reversible';
}

/**
 * The content fields APPR-002 requires, as data rather than as a list of `if` statements.
 *
 * Being a runtime array is what lets the test loop over it: "every required field, missing in turn, refuses" is one
 * test that cannot fall behind the type, whereas eight hand-written checks can each be forgotten.
 */
export const APPROVAL_REQUEST_CONTENT_FIELDS = ['action', 'reason', 'expectedResult', 'data', 'estimatedCostCredits', 'risk', 'reversibility', 'preview'] as const;
export type ApprovalRequestContentField = (typeof APPROVAL_REQUEST_CONTENT_FIELDS)[number];

/**
 * The subset a CALLER must supply — the content set minus the two the platform derives.
 *
 * TWO LISTS, NOT ONE, and the distinction was forced by a failing test rather than foreseen. The first version used
 * one list for both jobs, and the "every field, missing in turn, refuses" loop then demanded that omitting `risk`
 * refuse the request — which is incoherent: `risk` is not an input, `riskClass` is, and an unreadable one RESOLVES
 * to the most restrictive rather than refusing. Conflating "what canon requires the stored request to contain" with
 * "what a caller has to hand over" hid that the derived fields cannot be omitted at all.
 *
 * `DERIVED_APPROVAL_REQUEST_FIELDS` keeps the relationship checkable instead of leaving two hand-maintained lists to
 * drift: content = required inputs ∪ derived, asserted in the tests.
 */
export const DERIVED_APPROVAL_REQUEST_FIELDS: readonly ApprovalRequestContentField[] = ['risk', 'reversibility'];
export const APPROVAL_REQUEST_REQUIRED_INPUTS: readonly ApprovalRequestContentField[] = APPROVAL_REQUEST_CONTENT_FIELDS.filter(
  (f) => !(DERIVED_APPROVAL_REQUEST_FIELDS as readonly string[]).includes(f),
);

/** What a caller supplies. `risk` and `reversibility` are NOT here: both come from `riskClass`. */
export interface ApprovalRequestInput {
  readonly toolId: string;
  readonly toolVersion: number;
  /** The registry's class. `unknown`-tolerant on purpose: it resolves to the most restrictive rather than refusing. */
  /**
   * `unknown`, deliberately. `buildApprovalRequest` RESOLVES this through `resolveRiskClass`, which takes the most
   * restrictive reading of anything it cannot read — so the honest input type is "whatever the registry had",
   * including the null a `tool_definitions` row is allowed to carry. Typing it `RiskClass` implied a validated
   * value and invited callers to supply one of their own choosing.
   */
  readonly riskClass: unknown;
  readonly scope: ApprovalScope;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** Estimated cost in whole credits (the unit `@acbp/contracts/billing` uses). `0` is a real answer. */
  readonly estimatedCostCredits: number;
  readonly preview: string;
  /** The policy version this was proposed under — canon §2's binding table, and evaluation point 2's whole purpose. */
  readonly policyVersion: number;
}

/** A complete request, ready to be stored. Every APPR-002 field is present and non-blank by construction. */
export interface ApprovalRequestContent {
  readonly toolId: string;
  readonly toolVersion: number;
  readonly scope: ApprovalScope;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly estimatedCostCredits: number;
  readonly risk: RiskClass;
  readonly reversibility: Reversibility;
  readonly preview: string;
  readonly policyVersion: number;
}

export type BuildApprovalRequestResult =
  | { readonly status: 'ok'; readonly request: ApprovalRequestContent }
  | { readonly status: 'incomplete'; readonly missing: readonly ApprovalRequestContentField[] }
  | { readonly status: 'scope_not_available'; readonly scope: unknown };

/** Present means present: a blank string is missing content wearing the shape of content. */
function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Build a request, or refuse it.
 *
 * REFUSAL IS THE POINT (CDR-068 §2-G2). Storing a request with nulls and validating later would leave rows in the
 * inbox that a human cannot act on, and the blank would be indistinguishable from a deliberately empty field. Every
 * missing field is reported AT ONCE, because a caller fixing eight fields one round-trip at a time will give up and
 * pass placeholder text — which is worse than a refusal, since placeholder text looks like content.
 */
export function buildApprovalRequest(input: ApprovalRequestInput): BuildApprovalRequestResult {
  // SCOPE FIRST, and an unrecognised scope is refused rather than defaulted. Defaulting to `one_action` would be the
  // permissive reading of a value nobody could read — and it would silently narrow a batch to a single action.
  if (!isMvpApprovalScope(input.scope)) return { status: 'scope_not_available', scope: input.scope };

  // The risk class is RESOLVED, not validated: `resolveRiskClass` takes the most restrictive reading of anything
  // unreadable, so a junk class produces a stricter request rather than no request. Distinct from a missing reason,
  // which cannot be safely defaulted to anything.
  const risk = resolveRiskClass(input.riskClass);
  const reversibility = reversibilityOf(risk);

  const missing: ApprovalRequestContentField[] = [];
  if (isBlank(input.action)) missing.push('action');
  if (isBlank(input.reason)) missing.push('reason');
  if (isBlank(input.expectedResult)) missing.push('expectedResult');
  if (input.data === null || typeof input.data !== 'object' || Array.isArray(input.data)) missing.push('data');
  // WHOLE CREDITS, and `Number.isInteger` is the part review pass 1 found missing: the column is `integer`, so a
  // fractional estimate passed this check and then died in the driver with a raw 22P02 instead of the typed
  // refusal every other malformed field gets. The contract and the column now agree about what a credit is.
  if (typeof input.estimatedCostCredits !== 'number' || !Number.isInteger(input.estimatedCostCredits) || input.estimatedCostCredits < 0) missing.push('estimatedCostCredits');
  if (isBlank(input.preview)) missing.push('preview');
  if (missing.length > 0) return { status: 'incomplete', missing };

  return {
    status: 'ok',
    request: {
      toolId: input.toolId,
      toolVersion: input.toolVersion,
      scope: input.scope,
      action: input.action,
      reason: input.reason,
      expectedResult: input.expectedResult,
      data: input.data,
      estimatedCostCredits: input.estimatedCostCredits,
      risk,
      reversibility,
      preview: input.preview,
      policyVersion: input.policyVersion,
    },
  };
}
