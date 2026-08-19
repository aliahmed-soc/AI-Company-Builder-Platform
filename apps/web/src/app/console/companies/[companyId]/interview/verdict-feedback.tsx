/*
 * ACBP-FE-008 — what the server said about an answer, shown under the question it belongs to.
 *
 * ⚠️ EVERY DISTINCTION IS CARRIED BY WORDS. The row's accessibility line is "assumption chips are readable
 * text, not colour-only", and the same rule is applied to the re-ask and the contradiction: each outcome
 * renders a `label` sentence, and `data-kind` only tints what the words already say. Remove the stylesheet and
 * this component still tells a founder which of these happened.
 *
 * ⚠️ AN ASSUMPTION IS NEVER RENDERED AS THOUGH THE FOUNDER SAID IT. The platform stores it as `ai_assumption`
 * rather than `user_fact` precisely so the two stay separable, and a screen that presented it as an ordinary
 * recorded answer would undo that at the last step. The label says whose claim it is, and the copy says it
 * will be treated as true until corrected.
 *
 * NOTHING HERE SCORES ANYTHING. This component receives an outcome; it never inspects answer text. See
 * `verdict-outcome.ts`.
 *
 * `role="status"` rather than `role="alert"`: these are replies to something the founder just did, announced
 * politely. A re-ask is not an emergency, and `alert` would interrupt whatever a screen reader was saying.
 */
import type { VerdictOutcome, AssumptionOutcome } from './verdict-outcome';

function labelOf(outcome: VerdictOutcome | AssumptionOutcome): string {
  return 'label' in outcome ? outcome.label : 'The server refused this';
}

/**
 * The server's own words, when it sent any. Kept visually distinct from this screen's copy because they are
 * different voices — the founder should be able to tell what the platform asked from what this page says
 * about it.
 */
function ServerWords({ children }: { children: string }): React.JSX.Element {
  return <blockquote className="cs-server-words">{children}</blockquote>;
}

export function VerdictFeedback({ outcome }: { outcome: VerdictOutcome }): React.JSX.Element {
  return (
    <section className={`cs-verdict cs-verdict--${outcome.kind}`} data-kind={outcome.kind} role="status">
      <p className="cs-verdict-label">{labelOf(outcome)}</p>
      <p className="cs-verdict-detail">{outcome.detail}</p>
      {outcome.kind === 'reask' && <ServerWords>{outcome.clarification}</ServerWords>}
      {outcome.kind === 'contradiction' && <ServerWords>{outcome.conflict}</ServerWords>}
      {outcome.kind === 'invalid' && <ServerWords>{outcome.serverMessage}</ServerWords>}
    </section>
  );
}

export function AssumptionFeedback({ outcome }: { outcome: AssumptionOutcome }): React.JSX.Element {
  return (
    <section className={`cs-verdict cs-verdict--${outcome.kind}`} data-kind={outcome.kind} role="status">
      {/*
       * THE CHIP IS TEXT. `cs-chip` may tint it, but the sentence inside carries the whole meaning — an
       * assumption that reads as a plain recorded answer to anyone who cannot see the tint is the failure this
       * row's accessibility line names.
       */}
      <p className="cs-verdict-label">
        <span className="cs-chip" data-kind={outcome.kind}>
          {labelOf(outcome)}
        </span>
      </p>
      <p className="cs-verdict-detail">{outcome.detail}</p>
      {outcome.kind === 'assumed' && <ServerWords>{outcome.assumption}</ServerWords>}
      {outcome.kind === 'invalid' && <ServerWords>{outcome.serverMessage}</ServerWords>}
    </section>
  );
}
