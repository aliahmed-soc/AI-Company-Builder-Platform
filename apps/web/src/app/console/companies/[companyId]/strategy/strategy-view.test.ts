/*
 * ACBP-FE-013 — the strategy view mapper, tested against what the server can actually say.
 *
 * Every case here is a DISTINCTION the server draws that a careless screen would collapse. The generation DTO
 * carries four separate honesty signals — `status`, `similarityCheckResult`, `modelFlaggedPartial` and the
 * per-field `UNKNOWN_FIELD` sentinel — and each one exists because some part of the pipeline can produce less
 * than it was asked for. A screen that renders three options and says nothing else is lying by omission in at
 * least four different ways.
 */
import { describe, expect, it } from 'vitest';
import { STRATEGY_OPTION_FIELDS, UNKNOWN_FIELD } from '@acbp/contracts';
import type { StrategyGenerationDTO, StrategyOptionFields } from '@acbp/contracts';
import { toStrategyView, planningUnlocked, fieldCellsFor } from './strategy-view';

function fields(overrides: Partial<Record<string, string>> = {}): StrategyOptionFields {
  const out: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) out[f] = `${f} content`;
  return { ...out, ...overrides } as StrategyOptionFields;
}

function generation(overrides: Partial<StrategyGenerationDTO> = {}): StrategyGenerationDTO {
  return {
    generationId: 'gen-1',
    companyId: 'co-1',
    understandingVersion: 3,
    status: 'complete',
    optionCount: 3,
    fewerReason: null,
    similarityCheckResult: 'distinct',
    modelFlaggedPartial: false,
    options: [
      { optionId: 'opt-a', ordinal: 0, fields: fields() },
      { optionId: 'opt-b', ordinal: 1, fields: fields() },
      { optionId: 'opt-c', ordinal: 2, fields: fields() },
    ],
    recommendation: null,
    selection: null,
    decision: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    ...overrides,
  };
}

describe('an absent generation is a success, not an error', () => {
  it('reports nothing_generated for a null generation', () => {
    const view = toStrategyView(null);
    expect(view.state).toBe('nothing_generated');
    expect(view.options).toEqual([]);
  });

  it('does NOT describe an absent generation as a failure or a refusal', () => {
    // The route's own comment: "AN ABSENT GENERATION IS A SUCCESS, NOT A NOT-FOUND ... mapping it to a 404 is how
    // a UI ends up showing an error page on a normal first visit." The copy must match that.
    const text = toStrategyView(null).headline.toLowerCase();
    for (const word of ['error', 'failed', 'refused', 'denied', 'not found', 'unavailable']) {
      expect(text, `an empty first visit must not read as "${word}"`).not.toContain(word);
    }
  });
});

describe('fewer than three options is disclosed with the server-supplied reason', () => {
  it('surfaces the reason verbatim rather than inventing one', () => {
    const view = toStrategyView(generation({ status: 'fewer_than_three', optionCount: 2, fewerReason: 'The confirmed understanding constrains the customer axis to one segment.', options: [
      { optionId: 'opt-a', ordinal: 0, fields: fields() },
      { optionId: 'opt-b', ordinal: 1, fields: fields() },
    ] }));
    expect(view.state).toBe('fewer_than_three');
    expect(view.shortfallReason).toBe('The confirmed understanding constrains the customer axis to one segment.');
  });

  it('says the shortfall is unexplained when the server sent no reason, rather than going quiet', () => {
    // A `fewer_than_three` with a null reason is a real response shape. Rendering nothing there would present a
    // two-option generation as if two were what was asked for.
    const view = toStrategyView(generation({ status: 'fewer_than_three', optionCount: 2, fewerReason: null, options: [
      { optionId: 'opt-a', ordinal: 0, fields: fields() },
      { optionId: 'opt-b', ordinal: 1, fields: fields() },
    ] }));
    expect(view.state).toBe('fewer_than_three');
    expect(view.shortfallReason).toBeNull();
    expect(view.shortfallNote).toContain('did not say');
  });
});

describe('the three similarity states are three different things', () => {
  it('pending is NOT reported as distinct', () => {
    const view = toStrategyView(generation({ similarityCheckResult: 'pending' }));
    expect(view.distinctness.tone).toBe('pending');
    expect(view.distinctness.note.toLowerCase()).not.toContain('are distinct');
  });

  it('insufficient_distinct is reported as a real caveat', () => {
    const view = toStrategyView(generation({ similarityCheckResult: 'insufficient_distinct' }));
    expect(view.distinctness.tone).toBe('insufficient');
  });

  it('distinct is the only state that claims the options differ', () => {
    const view = toStrategyView(generation({ similarityCheckResult: 'distinct' }));
    expect(view.distinctness.tone).toBe('distinct');
  });
});

describe('modelFlaggedPartial is the model reporting on itself', () => {
  it('is surfaced separately from the option count', () => {
    // A generation can carry three options AND be flagged partial. Folding this into the count would lose it.
    const view = toStrategyView(generation({ modelFlaggedPartial: true }));
    expect(view.state).toBe('complete');
    expect(view.modelFlaggedPartial).toBe(true);
  });
});

describe('the UNKNOWN_FIELD sentinel is not content', () => {
  it('marks an undetermined field rather than printing the sentinel as an answer', () => {
    const cells = fieldCellsFor(fields({ cost_range: UNKNOWN_FIELD }));
    const cost = cells.find((c) => c.field === 'cost_range');
    expect(cost?.determined).toBe(false);
    // The literal sentinel must not be what a founder reads in the cell.
    expect(cost?.text).not.toBe(UNKNOWN_FIELD);
  });

  it('leaves a determined field exactly as the server sent it', () => {
    const cells = fieldCellsFor(fields({ cost_range: 'EGP 40k-90k' }));
    const cost = cells.find((c) => c.field === 'cost_range');
    expect(cost?.determined).toBe(true);
    expect(cost?.text).toBe('EGP 40k-90k');
  });

  it('returns one cell per contract field, in contract order', () => {
    const cells = fieldCellsFor(fields());
    expect(cells.map((c) => c.field)).toEqual([...STRATEGY_OPTION_FIELDS]);
  });
});

describe('a null recommendation has two causes and the screen must not pick one', () => {
  it('does not claim the AI abstained', () => {
    const view = toStrategyView(generation({ recommendation: null }));
    expect(view.recommendation).toBeNull();
    // The DTO comment says null means "none has been made / it abstained" — the wire collapses them, so any copy
    // asserting either one is stating something the server did not.
    const note = view.recommendationNote.toLowerCase();
    expect(note).not.toContain('abstain');
    expect(note).not.toContain('declined');
    expect(note).not.toContain('no opinion');
  });

  it('surfaces a real recommendation with its ordinal and both bodies of text', () => {
    const view = toStrategyView(generation({ recommendation: { recommendationId: 'rec-1', recommendedOptionId: 'opt-b', recommendedOrdinal: 1, rationale: 'Fastest to validate.', sensitivities: 'Assumes the pilot customer signs.', createdAt: '2026-08-18T10:05:00.000Z' } }));
    expect(view.recommendation?.recommendedOrdinal).toBe(1);
    expect(view.recommendation?.rationale).toBe('Fastest to validate.');
    expect(view.recommendation?.sensitivities).toBe('Assumes the pilot customer signs.');
  });

  it('marks which option the recommendation points at', () => {
    const view = toStrategyView(generation({ recommendation: { recommendationId: 'rec-1', recommendedOptionId: 'opt-b', recommendedOrdinal: 1, rationale: 'r', sensitivities: 's', createdAt: '2026-08-18T10:05:00.000Z' } }));
    expect(view.options.map((o) => o.recommended)).toEqual([false, true, false]);
  });

  it('matches the recommendation by option id, not by ordinal position in the array', () => {
    // Ordinal is the server's numbering; array position is an accident of transport. If they ever disagree,
    // keying on position would highlight the wrong option — the same class of defect as FE-007's resume card.
    const g = generation({
      options: [
        { optionId: 'opt-c', ordinal: 2, fields: fields() },
        { optionId: 'opt-b', ordinal: 1, fields: fields() },
        { optionId: 'opt-a', ordinal: 0, fields: fields() },
      ],
      recommendation: { recommendationId: 'rec-1', recommendedOptionId: 'opt-b', recommendedOrdinal: 1, rationale: 'r', sensitivities: 's', createdAt: '2026-08-18T10:05:00.000Z' },
    });
    const view = toStrategyView(g);
    expect(view.options.find((o) => o.recommended)?.optionId).toBe('opt-b');
  });
});

describe('selection and decision are different facts', () => {
  it('a selection with no decision is not yet hardened', () => {
    const view = toStrategyView(generation({ selection: { selectionId: 'sel-1', mode: 'select', selectedOptionId: 'opt-b', chosenFields: null, phaseScope: 'first_phase', reasons: null, createdAt: '2026-08-18T10:10:00.000Z' } }));
    expect(view.selection?.mode).toBe('select');
    expect(view.decision).toBeNull();
    expect(view.decisionState).toBe('selected_not_recorded');
  });

  it('a recorded non-reject decision unlocks planning', () => {
    expect(planningUnlocked({ decisionId: 'dec-1', generationId: 'gen-1', selectionId: 'sel-1', mode: 'select', understandingVersion: 3, optionsConsideredCount: 3, rationale: null, createdAt: '2026-08-18T10:11:00.000Z' })).toBe(true);
  });

  it('a recorded REJECT decision does NOT unlock planning', () => {
    // CDR-038 §6-G1, stated in the DecisionDTO's own doc comment. Getting this backwards would tell a founder
    // planning is available when the server will refuse it.
    expect(planningUnlocked({ decisionId: 'dec-1', generationId: 'gen-1', selectionId: 'sel-1', mode: 'reject', understandingVersion: 3, optionsConsideredCount: 3, rationale: 'None fit.', createdAt: '2026-08-18T10:11:00.000Z' })).toBe(false);
  });

  it('no decision at all does not unlock planning', () => {
    expect(planningUnlocked(null)).toBe(false);
  });

  it('reads the decision mode from the decision, never from the latest selection', () => {
    // The DecisionDTO comment is explicit: the latest selection may already be a DIFFERENT one than the decision
    // hardened. Reading the mode off `selection` would report a rejection as a selection, or the reverse.
    const view = toStrategyView(generation({
      selection: { selectionId: 'sel-2', mode: 'select', selectedOptionId: 'opt-a', chosenFields: null, phaseScope: null, reasons: null, createdAt: '2026-08-18T10:20:00.000Z' },
      decision: { decisionId: 'dec-1', generationId: 'gen-1', selectionId: 'sel-1', mode: 'reject', understandingVersion: 3, optionsConsideredCount: 3, rationale: 'None fit.', createdAt: '2026-08-18T10:11:00.000Z' },
    }));
    expect(view.decision?.mode).toBe('reject');
    expect(view.planningUnlocked).toBe(false);
    expect(view.decisionState).toBe('recorded');
  });

  it('flags a decision that hardened a selection other than the latest one', () => {
    const view = toStrategyView(generation({
      selection: { selectionId: 'sel-2', mode: 'select', selectedOptionId: 'opt-a', chosenFields: null, phaseScope: null, reasons: null, createdAt: '2026-08-18T10:20:00.000Z' },
      decision: { decisionId: 'dec-1', generationId: 'gen-1', selectionId: 'sel-1', mode: 'select', understandingVersion: 3, optionsConsideredCount: 3, rationale: null, createdAt: '2026-08-18T10:11:00.000Z' },
    }));
    expect(view.decisionCoversLatestSelection).toBe(false);
  });

  it('does not flag a mismatch when the decision hardened the latest selection', () => {
    const view = toStrategyView(generation({
      selection: { selectionId: 'sel-1', mode: 'select', selectedOptionId: 'opt-a', chosenFields: null, phaseScope: null, reasons: null, createdAt: '2026-08-18T10:10:00.000Z' },
      decision: { decisionId: 'dec-1', generationId: 'gen-1', selectionId: 'sel-1', mode: 'select', understandingVersion: 3, optionsConsideredCount: 3, rationale: null, createdAt: '2026-08-18T10:11:00.000Z' },
    }));
    expect(view.decisionCoversLatestSelection).toBe(true);
  });
});

describe('optionCount is the server total, options is what it sent', () => {
  it('reports a disagreement rather than silently showing the shorter list as the whole', () => {
    const view = toStrategyView(generation({ optionCount: 5 }));
    expect(view.optionCount).toBe(5);
    expect(view.options).toHaveLength(3);
    expect(view.countMismatch).toBe(true);
  });

  it('does not flag a mismatch when they agree', () => {
    expect(toStrategyView(generation()).countMismatch).toBe(false);
  });
});

describe('the understanding version is carried, because a generation is about one version of the truth', () => {
  it('surfaces the version the options were generated from', () => {
    expect(toStrategyView(generation({ understandingVersion: 7 })).understandingVersion).toBe(7);
  });
});
