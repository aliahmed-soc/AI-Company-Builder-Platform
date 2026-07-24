// @acbp/contracts — adaptive-orchestration output types (ACBP-P2-005; CDR-028; DISC-001..006).
// The three model-output shapes the gateway validates. `OutputParse` is structurally compatible with the core
// gateway's `OutputValidation` ({ok:true,value}|{ok:false}) so a parser can be used directly as validateOutput.

export type AnswerVerdict = 'clear' | 'vague' | 'contradictory';

/** A generated follow-up batch: 1..MAX_FOLLOWUP_BATCH bounded, non-blank question prompts (DISC-001 ≤3). */
export interface FollowUpBatch {
  readonly questions: readonly string[];
}

/** The adaptive answer-quality verdict (DISC-003 vague / DISC-004 contradiction). `detail` is the clarifying
 *  prompt (vague) or the conflict description (contradictory); it is null iff the verdict is `clear`. */
export interface AnswerQuality {
  readonly verdict: AnswerVerdict;
  readonly detail: string | null;
}

/** A labeled assumption suggested on an "I don't know" answer (DISC-005). */
export interface AssumptionSuggestion {
  readonly assumption: string;
}

/** Deny-by-default parse result — structurally the gateway's OutputValidation. */
export type OutputParse<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };
