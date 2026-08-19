/*
 * ACBP-FE-009 — the understanding view model.
 *
 * The cases that matter here are the ones where a plausible simplification would produce a screen that lies:
 * collapsing the two lifecycle flags, trusting the transport's class strings, trusting its ordering, and
 * treating an empty first visit as a fault.
 */
import { describe, expect, test } from 'vitest';
import { UNDERSTANDING_CLASSES, SECTION_CONFIDENCE_THRESHOLD } from '@acbp/contracts';
import { toUnderstandingView, understandingStateOf, type UnderstandingDocumentWire } from './understanding-view.js';

function doc(overrides: Partial<UnderstandingDocumentWire> = {}): UnderstandingDocumentWire {
  return {
    documentId: 'doc_1',
    version: 2,
    status: 'complete',
    overallConfidence: 0.62,
    sections: [
      { class: 'fact', count: 2, confidence: 0.8, status: 'present' },
      { class: 'assumption', count: 1, confidence: 0.3, status: 'assumed' },
    ],
    items: [
      { class: 'fact', content: 'Sells single-origin coffee wholesale.', confidence: 0.9 },
      { class: 'fact', content: 'Operates from one roastery.', confidence: 0.7 },
      { class: 'assumption', content: 'Buyers are independent cafes.', confidence: 0.3 },
    ],
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('a company with no understanding yet', () => {
  test('is an empty state, not a failure — no failure vocabulary anywhere in its copy', () => {
    const v = toUnderstandingView(null, false, false);
    expect(v.state).toBe('none');
    const copy = `${v.headline} ${v.statusNote} ${v.overallConfidenceLabel}`.toLowerCase();
    for (const word of ['error', 'failed', 'failure', 'unavailable', 'problem', 'sorry', 'unable']) {
      expect(copy).not.toContain(word);
    }
  });

  test('offers no confirm control and reports nothing to confirm', () => {
    const v = toUnderstandingView(null, false, false);
    expect(v.canConfirm).toBe(false);
    expect(v.itemCount).toBe(0);
    expect(v.sections).toEqual([]);
  });
});

describe('the two lifecycle flags are never collapsed (DISC-008)', () => {
  test('never confirmed → awaiting_confirmation, and the confirm control is offered', () => {
    const v = toUnderstandingView(doc(), false, false);
    expect(v.state).toBe('awaiting_confirmation');
    expect(v.canConfirm).toBe(true);
  });

  test('confirmed → confirmed, and re-confirming is not offered', () => {
    const v = toUnderstandingView(doc(), true, false);
    expect(v.state).toBe('confirmed');
    expect(v.canConfirm).toBe(false);
  });

  test('corrected after confirming → superseded, and confirm is NOT offered — the server would refuse it', () => {
    // `confirmUnderstanding` answers `stale_version` for a corrected version. A control whose only possible
    // outcome is an error is worse than no control.
    const v = toUnderstandingView(doc(), false, true);
    expect(v.state).toBe('superseded');
    expect(v.canConfirm).toBe(false);
  });

  test('THE ROW THIS FILE EXISTS FOR: the two `confirmed: false` states never share copy', () => {
    // Both are `confirmed: false` on the wire. Telling a founder who has just corrected the document to "review
    // and confirm it" reads as though their correction never registered — the exact failure ACBP-FE-009's
    // "shows a stale document as stale" is asking to avoid.
    const awaiting = toUnderstandingView(doc(), false, false);
    const superseded = toUnderstandingView(doc(), false, true);
    expect(awaiting.statusNote).not.toBe(superseded.statusNote);
    expect(awaiting.headline).not.toBe(superseded.headline);
    // And the stale one actually says so, rather than merely differing.
    expect(superseded.statusNote.toLowerCase()).toContain('corrected');
  });

  test('the state helper cannot report both at once', () => {
    expect(understandingStateOf(true, false)).toBe('confirmed');
    expect(understandingStateOf(false, true)).toBe('superseded');
    expect(understandingStateOf(false, false)).toBe('awaiting_confirmation');
    // A confirmed-and-superseded pair is impossible upstream (the predicates exclude it); if it ever arrived,
    // the ACTIVE reading wins rather than the screen inventing a fourth state.
    expect(understandingStateOf(true, true)).toBe('confirmed');
  });
});

describe('items are grouped by the imported vocabulary, not by what the transport sends', () => {
  test('all six classes appear in the canonical order, gaps included', () => {
    const v = toUnderstandingView(doc(), false, false);
    expect(v.sections.map((s) => s.class)).toEqual([...UNDERSTANDING_CLASSES]);
    // A class the interview established nothing in is SHOWN as a gap, not omitted — "what we do not know yet"
    // is part of what a founder is checking.
    const gaps = v.sections.filter((s) => s.isGap).map((s) => s.class);
    expect(gaps).toContain('open_question');
    expect(gaps).not.toContain('fact');
  });

  test('an item whose class is outside the closed set is COUNTED, never rendered and never silently dropped', () => {
    // The DTO types `class` as `string`. The server filters, but this view must not assume that: a section
    // invented for an unknown class would misreport the interview, and a silent drop would hide data loss.
    const v = toUnderstandingView(doc({ items: [...doc().items, { class: 'vibes', content: 'Feels promising.', confidence: 0.9 }] }), false, false);
    expect(v.unclassifiedItemCount).toBe(1);
    expect(v.sections.map((s) => s.class)).toEqual([...UNDERSTANDING_CLASSES]);
    expect(JSON.stringify(v.sections)).not.toContain('Feels promising.');
    // The count still reflects everything that arrived, so the discrepancy is visible rather than papered over.
    expect(v.itemCount).toBe(4);
  });

  test('every classified item appears exactly once across the sections', () => {
    const v = toUnderstandingView(doc(), false, false);
    const rendered = v.sections.flatMap((s) => s.items.map((i) => i.content));
    expect(rendered).toHaveLength(3);
    expect(new Set(rendered).size).toBe(3);
  });

  test('a section STATUS outside the closed set falls back to unknown, never to a confident reading', () => {
    /*
     * `UnderstandingSectionDTO` widens `status` to `string`, exactly as it does `class`. Printing an
     * unrecognised value verbatim would show a system token to a founder; defaulting it to `present` would
     * claim the section is well supported on a value nothing validated. Deny-by-default is the only safe read.
     */
    const v = toUnderstandingView(doc({ sections: [{ class: 'fact', count: 1, confidence: 0.9, status: 'super_present' }] }), false, false);
    expect(v.sections.find((s) => s.class === 'fact')?.status).toBe('unknown');
  });

  test("the SERVER's section rollup wins over a locally recounted one", () => {
    // The server's `count` is the authority. Recounting from `items` here would be a second definition of a
    // section, and the two would disagree the first time the server filtered something this view did not.
    const v = toUnderstandingView(doc({ sections: [{ class: 'fact', count: 99, confidence: 0.8, status: 'present' }] }), false, false);
    expect(v.sections.find((s) => s.class === 'fact')?.count).toBe(99);
  });
});

describe('confidence is always a labelled value, never a bare number or colour', () => {
  test('every confidence carries a sentence naming what the number means', () => {
    const v = toUnderstandingView(doc(), false, false);
    expect(v.overallConfidenceLabel).toContain('62%');
    for (const section of v.sections) {
      expect(section.confidenceLabel.length).toBeGreaterThan(0);
      for (const item of section.items) expect(item.confidenceLabel).toContain('%');
    }
  });

  test('the present/assumed wording follows the IMPORTED threshold, not a restated one', () => {
    // If this file restated the threshold, the two would eventually describe different lines. Driving the
    // fixture from the constant means a change to it moves this assertion too.
    const above = toUnderstandingView(doc({ overallConfidence: SECTION_CONFIDENCE_THRESHOLD }), false, false);
    const below = toUnderstandingView(doc({ overallConfidence: SECTION_CONFIDENCE_THRESHOLD - 0.01 }), false, false);
    expect(above.overallConfidenceLabel).toContain('well supported');
    expect(below.overallConfidenceLabel).toContain('weakly supported');
  });

  test('an empty section says so rather than reporting 0% as though it were a measurement', () => {
    const v = toUnderstandingView(doc(), false, false);
    const gap = v.sections.find((s) => s.isGap);
    expect(gap?.confidenceLabel).toBe('Nothing established here yet.');
  });
});

describe('a partial document says so separately from its confidence', () => {
  test('partial is surfaced in the status note and as its own flag', () => {
    // A document can be complete and low-confidence, or partial and high-confidence. Folding the two loses
    // whichever one you drop.
    const v = toUnderstandingView(doc({ status: 'partial', overallConfidence: 0.95 }), false, false);
    expect(v.partial).toBe(true);
    expect(v.statusNote).toContain('partial');
    expect(v.overallConfidenceLabel).toContain('well supported');
  });

  test('a complete document does not mention partiality at all', () => {
    expect(toUnderstandingView(doc(), false, false).statusNote).not.toContain('partial');
  });
});
