// @vitest-environment jsdom
/*
 * ACBP-FE-009 — the rendered understanding document.
 *
 * THE REGRESSION THIS FILE GUARDS: the two `confirmed: false` states must not render the same screen. A
 * founder who has just CORRECTED their understanding and one who has never confirmed it are in different
 * places, and the row's acceptance ("the UI shows a stale document as stale") is the sentence that says so.
 * The view model keeps them apart; this file proves the screen actually renders the difference rather than
 * computing it and then printing one branch for both.
 *
 * THE SECOND CLAIM: confidence is never carried by colour alone (the row's accessibility line). The bar is
 * `aria-hidden`, so the assertion here is that the NUMBER AND ITS MEANING survive with the bar removed from the
 * accessibility tree — which is what a screen reader, or anyone who cannot distinguish the palette, actually
 * gets.
 *
 * ⚠️ WHAT THIS HARNESS CANNOT DO. jsdom implements no layout engine, so the row's "document width capped for
 * reading" is NOT proven here — `cs-doc` is asserted as present, which is a wiring check and not a width
 * measurement. Saying so is the difference between evidence and a green tick.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UnderstandingScreen } from './understanding-screen';
import { toUnderstandingView, type UnderstandingDocumentWire } from './understanding-view';

// Globals are OFF in this repository, so testing-library does not auto-register cleanup. Without this, a later
// test reads an earlier test's DOM and passes for the wrong reason.
afterEach(cleanup);

function doc(over: Partial<UnderstandingDocumentWire> = {}): UnderstandingDocumentWire {
  return {
    documentId: 'doc_1',
    version: 2,
    status: 'complete',
    overallConfidence: 0.62,
    sections: [
      { class: 'fact', count: 1, confidence: 0.9, status: 'present' },
      { class: 'assumption', count: 1, confidence: 0.3, status: 'assumed' },
    ],
    items: [
      { class: 'fact', content: 'Sells single-origin coffee wholesale.', confidence: 0.9 },
      { class: 'assumption', content: 'Buyers are independent cafes.', confidence: 0.3 },
    ],
    createdAt: '2026-08-19T00:00:00.000Z',
    ...over,
  };
}

const renderWith = (confirmed: boolean, superseded: boolean, over: Partial<UnderstandingDocumentWire> = {}) =>
  render(<UnderstandingScreen view={toUnderstandingView(doc(over), confirmed, superseded)} />);

describe('a corrected document does not render as an unconfirmed one', () => {
  it('SUPERSEDED says the correction landed and that planning is blocked again', () => {
    renderWith(false, true);
    expect(screen.getByText(/corrected this understanding after confirming/i)).toBeTruthy();
    // And it must NOT tell them to do the thing they already did.
    expect(screen.queryByText(/^Planning stays blocked until you confirm this understanding is right\./)).toBeNull();
  });

  it('AWAITING asks for a confirmation and never mentions a correction', () => {
    renderWith(false, false);
    expect(screen.getByText(/planning stays blocked until you confirm/i)).toBeTruthy();
    expect(screen.queryByText(/corrected this understanding/i)).toBeNull();
  });

  it('the badge text differs between the two, not merely the class', () => {
    // A badge that changed only `data-state` would satisfy a styling check and tell a colour-blind founder
    // nothing at all.
    const { unmount } = renderWith(false, false);
    const awaiting = screen.getByText(/awaiting your confirmation/i).textContent;
    unmount();
    renderWith(false, true);
    const stale = screen.getByText(/needs a new version/i).textContent;
    expect(awaiting).not.toBe(stale);
  });

  it('CONFIRMED reports that planning can proceed', () => {
    renderWith(true, false);
    // Two matches by design: the header states the lifecycle, the actions card explains what it means for what
    // you can do next. `getByText` would throw on the pair, so the count is asserted rather than assumed away.
    expect(screen.getAllByText(/confirmed, so planning can proceed/i)).toHaveLength(2);
    expect(screen.queryByText(/planning stays blocked/i)).toBeNull();
  });
});

describe('confidence survives without the colour', () => {
  it('every confidence appears as text, and the decorative bar is hidden from assistive technology', () => {
    const { container } = renderWith(false, false);
    // The number AND what it means, as words.
    expect(screen.getByText(/90% confidence — this item is well supported\./)).toBeTruthy();
    expect(screen.getByText(/30% confidence — this item is weakly supported\./)).toBeTruthy();
    for (const bar of container.querySelectorAll('.cs-confidence-bar')) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('a section with nothing in it says so rather than rendering 0% as a measurement', () => {
    renderWith(false, false);
    // Six classes always render; the four the interview established nothing in are gaps.
    expect(screen.getAllByText(/Nothing established here yet\./).length).toBeGreaterThan(0);
  });
});

describe('the screen never claims more than the server said', () => {
  it('an unrecognised item class is REPORTED, not silently dropped and not rendered as a section', () => {
    renderWith(false, false, { items: [...doc().items, { class: 'vibes', content: 'Feels promising.', confidence: 0.9 }] });
    expect(screen.getByText(/category this screen does not recognise/i)).toBeTruthy();
    // The content itself is not rendered under an invented heading.
    expect(screen.queryByText('Feels promising.')).toBeNull();
  });

  it('a PARTIAL document says so, separately from its confidence being high', () => {
    renderWith(false, false, { status: 'partial', overallConfidence: 0.95 });
    expect(screen.getByText(/marked this document partial/i)).toBeTruthy();
    expect(screen.getByText(/95% confidence — this understanding is well supported\./)).toBeTruthy();
  });

  it('an empty understanding renders the ordinary empty state, NOT a refusal', () => {
    // The most likely way this screen could have been got wrong: treating `document: null` as an error and
    // showing a founder an error page on their first visit.
    render(<UnderstandingScreen view={toUnderstandingView(null, false, false)} />);
    expect(screen.getByText(/has not produced an understanding of this company yet/i)).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('no confirm or review CONTROL is rendered, because no route reaches those writes yet', () => {
    // The row asks for review controls with accessible names. They are not routed, so the screen names the gap
    // instead of rendering buttons that would do nothing — and this asserts no button slipped in.
    const { container } = renderWith(false, false);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByText(/exist in the platform and have no HTTP route/i)).toBeTruthy();
  });
});

describe('the reading-width wrapper is wired', () => {
  it('the document is inside cs-doc', () => {
    // ⚠️ A WIRING CHECK, NOT A WIDTH MEASUREMENT. jsdom has no layout engine, so this cannot prove the cap works.
    const { container } = renderWith(false, false);
    expect(container.querySelector('.cs-doc')).not.toBeNull();
  });
});
