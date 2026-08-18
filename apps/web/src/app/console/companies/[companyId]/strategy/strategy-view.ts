/*
 * ACBP-FE-013 — turning the strategy read into something a founder can decide from.
 *
 * THIS SCREEN'S JOB IS TO NOT OVERSTATE A GENERATION. `StrategyGenerationDTO` carries FOUR independent signals
 * that the pipeline produced less than it was asked for, and they are independent — a generation can be
 * `complete` with three options and still be flagged partial by the model, or carry three options whose
 * distinctness was never checked. Folding them into one "here are your options" heading throws away every one:
 *
 *   status                 → `fewer_than_three` means the generator could not reach MIN_DISTINCT_OPTIONS.
 *   fewerReason            → WHY it could not. Nullable, so the shortfall can be real and unexplained.
 *   similarityCheckResult  → `pending` | `distinct` | `insufficient_distinct`. THREE states, not a boolean.
 *   modelFlaggedPartial    → the model reporting on its own output, independent of the count.
 *
 * AN ABSENT GENERATION IS A SUCCESS. The route says so in its own header — "mapping it to a 404 is how a UI ends
 * up showing an error page on a normal first visit" — so `null` is the ordinary empty state and its copy carries
 * no failure vocabulary. A test pins that: the headline may not contain "error", "failed", "refused", "denied",
 * "not found" or "unavailable".
 *
 * WHAT THIS SCREEN CANNOT DO, AND SAYS SO RATHER THAN IMPLYING IT: there is no HTTP route for
 * `generateStrategyOptions` or `recommendStrategy`. Both are model-driven use cases that exist in `@acbp/core`
 * and are reachable from no route file — verified by enumerating all 36 `route.ts` files, not by a glob (a
 * bracketed path segment like `[companyId]` is read as a character class and silently matches nothing). So this
 * console ships NO "generate options" and NO "ask for a recommendation" button. A control that cannot act is the
 * exact thing this console refuses to ship, and a disabled one that never enables is the same lie with a tooltip.
 */
import { STRATEGY_OPTION_FIELDS, UNKNOWN_FIELD } from '@acbp/contracts';
import type {
  DecisionDTO,
  StrategyGenerationDTO,
  StrategyOptionField,
  StrategyOptionFields,
  StrategyRecommendationDTO,
  StrategySelectionDTO,
} from '@acbp/contracts';

export type StrategyState = 'nothing_generated' | 'complete' | 'fewer_than_three';
export type DistinctnessTone = 'pending' | 'distinct' | 'insufficient';
export type DecisionState = 'none' | 'selected_not_recorded' | 'recorded';

export interface FieldCell {
  readonly field: StrategyOptionField;
  readonly label: string;
  /** False when the server sent the ADR-019 sentinel: the model could not determine this field. */
  readonly determined: boolean;
  /** What a founder reads. Never the raw sentinel. */
  readonly text: string;
}

export interface OptionView {
  readonly optionId: string;
  /** The SERVER's numbering. Never the array index — see the note on `recommended`. */
  readonly ordinal: number;
  readonly cells: readonly FieldCell[];
  /** True for the one option the advisory recommendation points at, matched BY ID. */
  readonly recommended: boolean;
}

export interface StrategyView {
  readonly state: StrategyState;
  readonly headline: string;
  readonly generationId: string | null;
  readonly understandingVersion: number | null;
  readonly options: readonly OptionView[];
  /** The server's total. `options.length` is what it sent; they are not the same claim. */
  readonly optionCount: number;
  readonly countMismatch: boolean;
  readonly shortfallReason: string | null;
  readonly shortfallNote: string | null;
  readonly distinctness: { readonly tone: DistinctnessTone; readonly note: string };
  readonly modelFlaggedPartial: boolean;
  readonly recommendation: StrategyRecommendationDTO | null;
  readonly recommendationNote: string;
  readonly selection: StrategySelectionDTO | null;
  readonly decision: DecisionDTO | null;
  readonly decisionState: DecisionState;
  /** False when the recorded decision hardened a selection OTHER than the latest one. */
  readonly decisionCoversLatestSelection: boolean;
  readonly planningUnlocked: boolean;
  readonly createdAt: string | null;
}

/** `cost_range` → `Cost range`. The contract's field names are machine words, not founder-facing labels. */
function labelForField(field: string): string {
  return field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * One cell per contract field, in CONTRACT ORDER — never `Object.keys` order, which is an accident of however the
 * object was built and would let two options render their fields in different orders in the same table.
 *
 * THE SENTINEL IS NOT CONTENT. ADR-019 requires the model to write the literal `UNKNOWN_FIELD` when it cannot
 * determine a field, precisely so an undetermined field is LABELED rather than fabricated. Printing that token
 * into the cell would show a founder the word "unknown" as though it were the answer.
 *
 * ITS ONE AMBIGUITY, STATED: a field whose genuine content is the bare word "unknown" is indistinguishable from
 * the sentinel here, because the wire carries no separate flag. Equality with the sentinel is the contract's own
 * detection method, so this follows it — but the limit is real and belongs in writing rather than in a reader's
 * assumption that the check is exact.
 */
export function fieldCellsFor(fields: StrategyOptionFields): readonly FieldCell[] {
  return STRATEGY_OPTION_FIELDS.map((field) => {
    const raw = fields[field];
    const determined = raw !== UNKNOWN_FIELD;
    return { field, label: labelForField(field), determined, text: determined ? raw : 'Not determined' };
  });
}

/**
 * Whether a recorded decision unlocks planning.
 *
 * A REJECTION NEVER DOES (CDR-038 §6-G1, stated in `DecisionDTO`'s own doc comment: "The P4-001 planning gate
 * keys off a NON-reject decision — a rejection never unlocks planning"). Getting this backwards would tell a
 * founder planning is available when the server will refuse it, which is worse than saying nothing.
 *
 * It reads the mode off the DECISION, never off the latest selection: the two can differ, and the decision's mode
 * is snapshot at record time for exactly this reason.
 */
export function planningUnlocked(decision: DecisionDTO | null): boolean {
  if (decision === null) return false;
  return decision.mode !== 'reject';
}

function distinctnessFor(result: StrategyGenerationDTO['similarityCheckResult']): { tone: DistinctnessTone; note: string } {
  switch (result) {
    case 'distinct':
      return { tone: 'distinct', note: 'The server checked these options against each other and found them different on customer, offer and business model.' };
    case 'insufficient_distinct':
      return { tone: 'insufficient', note: 'The server checked these options and found them too similar to each other on customer, offer and business model. Treat them as variations rather than as genuinely different directions.' };
    case 'pending':
    default:
      // NOT "distinct". A check that has not run has produced no finding, and rendering that as a pass would be
      // an answer the server never gave.
      return { tone: 'pending', note: 'The distinctness check has not run on these options yet, so nothing is known about whether they genuinely differ from one another.' };
  }
}

const NO_RECOMMENDATION_NOTE =
  'No recommendation is recorded against this generation. The server does not say whether one was never requested or whether it was requested and produced nothing, so this page does not guess which.';

export function toStrategyView(generation: StrategyGenerationDTO | null): StrategyView {
  if (generation === null) {
    return {
      state: 'nothing_generated',
      // NO FAILURE VOCABULARY — a first visit is not a fault. Pinned by a test.
      headline: 'No strategy options have been generated for this company yet.',
      generationId: null,
      understandingVersion: null,
      options: [],
      optionCount: 0,
      countMismatch: false,
      shortfallReason: null,
      shortfallNote: null,
      distinctness: { tone: 'pending', note: 'There are no options to compare yet.' },
      modelFlaggedPartial: false,
      recommendation: null,
      recommendationNote: NO_RECOMMENDATION_NOTE,
      selection: null,
      decision: null,
      decisionState: 'none',
      decisionCoversLatestSelection: true,
      planningUnlocked: false,
      createdAt: null,
    };
  }

  // MATCHED BY ID, NOT BY ARRAY POSITION. `ordinal` is the server's numbering and array order is an accident of
  // transport; keying the highlight on position would mark the wrong option the moment they disagree. That is the
  // same defect class as ACBP-FE-007's resume card, which derived "where to resume" from array order.
  const recommendedId = generation.recommendation?.recommendedOptionId ?? null;
  const options: readonly OptionView[] = generation.options.map((o) => ({
    optionId: o.optionId,
    ordinal: o.ordinal,
    cells: fieldCellsFor(o.fields),
    recommended: recommendedId !== null && o.optionId === recommendedId,
  }));

  const shortfall = generation.status === 'fewer_than_three';
  const decision = generation.decision;
  const selection = generation.selection;

  return {
    state: shortfall ? 'fewer_than_three' : 'complete',
    headline: shortfall
      ? `This generation produced ${String(generation.optionCount)} options rather than the ${String(3)} it aims for.`
      : `${String(generation.optionCount)} strategy options, generated from version ${String(generation.understandingVersion)} of the confirmed understanding.`,
    generationId: generation.generationId,
    understandingVersion: generation.understandingVersion,
    options,
    optionCount: generation.optionCount,
    // The server's total and the list it sent are two claims. If they disagree, showing the list as the whole
    // would under-report — the same shape as ACBP-FE-012's `truncated` sections.
    countMismatch: generation.optionCount !== generation.options.length,
    shortfallReason: shortfall ? generation.fewerReason : null,
    shortfallNote: shortfall
      ? (generation.fewerReason === null
          ? 'The server did not say why it could not produce three distinct options.'
          : 'The server gave this reason for producing fewer than three:')
      : null,
    distinctness: distinctnessFor(generation.similarityCheckResult),
    modelFlaggedPartial: generation.modelFlaggedPartial,
    recommendation: generation.recommendation,
    // TWO CAUSES, ONE NULL. The DTO's own comment says null means "none has been made / it abstained" — the wire
    // collapses them, so any copy asserting either one states something the server did not.
    recommendationNote: generation.recommendation === null ? NO_RECOMMENDATION_NOTE : 'This is an advisory recommendation. It selects nothing — the decision below is the owner’s.',
    selection,
    decision,
    decisionState: decision !== null ? 'recorded' : selection !== null ? 'selected_not_recorded' : 'none',
    // A decision hardens ONE selection. The latest selection may already be a different one, in which case the
    // recorded decision does not describe what the founder last chose. `true` when there is nothing to compare.
    decisionCoversLatestSelection: decision === null || selection === null || decision.selectionId === selection.selectionId,
    planningUnlocked: planningUnlocked(decision),
    createdAt: generation.createdAt,
  };
}
