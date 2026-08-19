// @vitest-environment jsdom
/*
 * ACBP-FE-018 — the rendered usage screen.
 *
 * Three claims this file exists to hold:
 *
 *   1. A MEASURED ZERO and an ABSENT PROJECTION render as different things. The row's requirement is "Zero usage
 *      is an explicit computed zero, not a blank", and the failure it names is a screen that shows the same
 *      emptiness for "we measured nothing happened" and "we have not measured".
 *   2. FIGURES CARRY UNITS IN TEXT. Asserted with every `class` attribute stripped, so nothing rests on styling.
 *   3. NOTHING INERT IS RENDERED. No payment control (no processor is integrated) and no rebuild control (no
 *      route reaches one). Asserted as a zero-button count, so the absence cannot quietly fill with decoration.
 *
 * ⚠️ WHAT THIS HARNESS CANNOT DO. jsdom has no layout engine, so the row's "Cards stack" is NOT proven here. The
 * grid container is asserted as present, which is a wiring check and not a layout measurement.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UsageScreen } from './usage-screen';
import { toUsageView, type AccountUsageWire } from './usage-view';

// Globals are OFF in this repository, so testing-library registers no automatic cleanup.
afterEach(cleanup);

function usage(over: Partial<AccountUsageWire> = {}): AccountUsageWire {
  return {
    periodStart: '2026-08-01',
    eventCount: 12,
    inputTokens: 48_300,
    outputTokens: 9_140,
    estimatedCostMicros: 470_000,
    computedAt: '2026-08-19T09:00:00.000Z',
    ...over,
  };
}

const renderComputed = (over: Partial<AccountUsageWire> = {}) => render(<UsageScreen view={toUsageView(usage(over))} />);
const ZEROED = { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };

describe('a measured zero is not an absent projection', () => {
  it('a MEASURED ZERO shows its zeroes and says the period was measured', () => {
    renderComputed(ZEROED);
    expect(screen.getByText(/This period was measured, and the total is zero/i)).toBeTruthy();
    expect(screen.getByText('0 calls')).toBeTruthy();
    expect(screen.getByText('0.00 cost units (estimated)')).toBeTruthy();
  });

  it('an ABSENT PROJECTION shows no figures at all and denies that it means zero', () => {
    render(<UsageScreen view={toUsageView(null, '2026-08-01')} />);
    expect(screen.getByText(/No usage projection has been computed/i)).toBeTruthy();
    expect(screen.getByText(/not the same as zero usage/i)).toBeTruthy();
    // Not a single figure card, because there is no measurement to show.
    expect(screen.queryByText(/calls$/)).toBeNull();
    expect(screen.queryByText(/cost units \(estimated\)/)).toBeNull();
  });

  it('the two states carry different badges — words, not just a data attribute', () => {
    const { unmount } = renderComputed(ZEROED);
    const measured = screen.getByText('Measured — zero').textContent;
    unmount();
    render(<UsageScreen view={toUsageView(null, '2026-08-01')} />);
    expect(measured).not.toBe(screen.getByText('Not computed').textContent);
  });

  it('the absent state says a rebuild cannot be triggered from here', () => {
    render(<UsageScreen view={toUsageView(null, '2026-08-01')} />);
    expect(screen.getByText(/not something this console can trigger/i)).toBeTruthy();
  });
});

describe('figures carry their units in text', () => {
  it('the meaning survives with every class attribute stripped', () => {
    const { container } = renderComputed();
    for (const el of container.querySelectorAll('[class]')) el.removeAttribute('class');
    const text = container.textContent ?? '';
    expect(text).toContain('12 model calls');
    expect(text).toContain('48,300 tokens');
    expect(text).toContain('9,140 tokens');
    expect(text).toContain('0.47 cost units (estimated)');
  });

  it('no rendered figure value is a bare numeral', () => {
    const { container } = renderComputed();
    for (const el of container.querySelectorAll('.cs-usage-value')) {
      expect((el.textContent ?? '').trim()).not.toMatch(/^[\d,.$]+$/);
    }
  });
});

describe('nothing inert is rendered', () => {
  it('there are NO buttons — no payment control and no rebuild control', () => {
    // Two separate absences with two separate reasons: no processor is integrated (the row's exclusion), and
    // `rebuildAccountUsageRollup` reaches no route (CDR-073 §3.2). A disabled button for either would imply a
    // system that exists and is switched off.
    const { container } = renderComputed();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelectorAll('input')).toHaveLength(0);
  });

  it('the billing section is a statement that no billing exists, not a placeholder widget', () => {
    renderComputed();
    expect(screen.getByText(/There is no billing on this platform yet/i)).toBeTruthy();
    expect(screen.getByText(/nothing to charge, nothing to pay and nothing to manage/i)).toBeTruthy();
  });
});

describe('the screen never presents the figures as a bill', () => {
  it('says the ledger is authoritative and that nothing decides a limit from these figures', () => {
    renderComputed();
    expect(screen.getByText(/the ledger is right and this\s*projection is the thing at fault/i)).toBeTruthy();
    expect(screen.getByText(/decides a limit or an entitlement/i)).toBeTruthy();
  });

  it('the cost is labelled an estimate, with no currency claimed', () => {
    renderComputed();
    expect(screen.getByText(/An ESTIMATE of what the model providers charged/i)).toBeTruthy();
  });

  it('surfaces WHEN the projection was computed, so a stale figure is recognisable', () => {
    renderComputed();
    expect(screen.getByText(/Projection computed 2026-08-19T09:00:00.000Z/)).toBeTruthy();
  });
});

describe('layout wiring', () => {
  it('the figures sit in the shared stat grid', () => {
    // ⚠️ A WIRING CHECK, NOT A LAYOUT ONE. jsdom applies no stylesheet and computes no geometry, so "Cards stack"
    // cannot be measured here.
    const { container } = renderComputed();
    expect(container.querySelector('.cs-stats')).not.toBeNull();
    expect(container.querySelectorAll('.cs-usage-stat')).toHaveLength(4);
  });
});
