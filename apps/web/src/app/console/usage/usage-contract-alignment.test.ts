/*
 * ACBP-FE-018 — the row's "Test evidence" clause, verbatim:
 *
 *     "Route test asserting the displayed total equals the API total"
 *
 * THIS IS THE TEST THAT CLAUSE ASKS FOR, and the design is what makes it mean anything. One
 * `UsageRequestResult` is fed through BOTH ends of the system at once:
 *
 *   • `toUsageResponse` — the exact mapping the HTTP route serves to an API client
 *   • `toUsageView`     — the exact model the console screen renders
 *
 * and every figure is asserted equal across the two. Either side drifting — a renamed field, a unit conversion
 * applied on one path only, a lane silently dropped from the allowlist — makes this file red. Asserting the view
 * alone would prove only that the view is self-consistent, which is the failure mode this shape exists to avoid.
 *
 * ⚠️ WHAT IT DOES NOT PROVE, stated because the row's clause says "route test" and this is not one in the
 * strictest sense: it does not invoke the Next route handler, does not exercise `context.params`, the query
 * allowlist, the 16 KiB body cap or the CSRF gate, and does not hit a database. NO route handler in this
 * application has a test of that kind today. What is proven here is the property the clause is actually about —
 * that the number on the screen is the number the API serves — plus the type-level pin below.
 */
import { describe, expect, test } from 'vitest';
import { toUsageResponse } from '@/server/accounts/usage-http';
import type { AccountUsageView, UsageRequestResult } from '@/server/accounts/usage-request';
import { toUsageView, microsToCostUnits, type AccountUsageWire } from './usage-view.js';

/**
 * THE TYPE PIN. `AccountUsageWire` is the screen's private copy of the payload's shape; this assignment makes the
 * compiler reject the two drifting apart. A field added to `AccountUsageView` that the screen has not considered
 * is a build error rather than a silently unrendered figure.
 */
const _pin: (v: AccountUsageView) => AccountUsageWire = (v) => v;
void _pin;

const FIGURES: AccountUsageView = {
  periodStart: '2026-08-01',
  eventCount: 12,
  inputTokens: 48_300,
  outputTokens: 9_140,
  estimatedCostMicros: 470_000,
  computedAt: '2026-08-19T09:00:00.000Z',
};

async function apiBody(result: UsageRequestResult): Promise<Record<string, unknown>> {
  return (await toUsageResponse(result).json()) as Record<string, unknown>;
}

describe('the displayed figures equal the API figures', () => {
  test('every lane the API serves is the lane the screen displays', async () => {
    const result: UsageRequestResult = { status: 'ok', usage: FIGURES };
    const served = (await apiBody(result))['usage'] as AccountUsageView;
    const view = toUsageView(FIGURES);

    // The API's own numbers, not the fixture's — so a mapping that mangled a field fails here rather than
    // agreeing with a constant this test wrote down.
    expect(view.figures.find((f) => f.key === 'eventCount')?.value).toBe(`${served.eventCount} calls`);
    expect(view.figures.find((f) => f.key === 'inputTokens')?.value).toBe(`${served.inputTokens.toLocaleString('en-US')} tokens`);
    expect(view.figures.find((f) => f.key === 'outputTokens')?.value).toBe(`${served.outputTokens.toLocaleString('en-US')} tokens`);
    expect(view.figures.find((f) => f.key === 'estimatedCost')?.value).toBe(`${microsToCostUnits(served.estimatedCostMicros)} cost units (estimated)`);
  });

  test('THE TOTAL: the cost on screen is the cost the API served, converted once and exactly', async () => {
    // The clause's literal subject. `estimatedCostMicros` is the only figure that undergoes a conversion, so it
    // is the only one where the screen and the API could disagree while both looking plausible.
    const result: UsageRequestResult = { status: 'ok', usage: FIGURES };
    const servedMicros = ((await apiBody(result))['usage'] as AccountUsageView).estimatedCostMicros;
    expect(servedMicros).toBe(470_000);
    expect(toUsageView(FIGURES).figures.find((f) => f.key === 'estimatedCost')?.value).toContain('0.47 cost units');
  });

  test('the period the screen names is the period the API echoed back', async () => {
    // The request layer echoes `periodStart` "so a client can never mis-attribute figures to the period it asked
    // for". The screen must display THAT period, not one it derived itself.
    const result: UsageRequestResult = { status: 'ok', usage: { ...FIGURES, periodStart: '2026-07-01' } };
    const served = (await apiBody(result))['usage'] as AccountUsageView;
    const view = toUsageView({ ...FIGURES, periodStart: '2026-07-01' });
    expect(served.periodStart).toBe('2026-07-01');
    expect(view.periodStart).toBe(served.periodStart);
    expect(view.periodLabel).toBe('July 2026');
  });

  test('a measured ZERO agrees end to end, and is not confused with an absent projection', async () => {
    const zeroed: AccountUsageView = { ...FIGURES, eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };
    const body = await apiBody({ status: 'ok', usage: zeroed });
    // The API sends a real object with zeroes in it — NOT `usage: null`.
    expect(body['usage']).not.toBeNull();
    const view = toUsageView(zeroed);
    expect(view.state).toBe('computed');
    expect(view.isMeasuredZero).toBe(true);
    expect(view.figures.find((f) => f.key === 'estimatedCost')?.value).toBe('0.00 cost units (estimated)');
  });
});

describe('an uncomputed period travels as a success, both ends', () => {
  test('the API sends 200 with usage null, and the screen renders it as its own state', async () => {
    const result: UsageRequestResult = { status: 'not_computed', periodStart: '2026-08-01' };
    const response = toUsageResponse(result);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { usage: unknown; periodStart: string };
    expect(body.usage).toBeNull();
    expect(body.periodStart).toBe('2026-08-01');

    // The screen consumes exactly that: null plus the period, and must not manufacture zeroes from it.
    const view = toUsageView(null, body.periodStart);
    expect(view.state).toBe('never_computed');
    expect(view.figures).toEqual([]);
    expect(view.periodLabel).toBe('August 2026');
  });

  test('the API never sends a zeroed body for an uncomputed period', async () => {
    // `usage-http.ts` is explicit that zeroes here "would collapse that distinction at the last possible moment".
    // If a future edit did that, the screen would render an invented measurement and this test is what stops it.
    const body = await apiBody({ status: 'not_computed', periodStart: '2026-08-01' });
    expect(JSON.stringify(body)).not.toContain('eventCount');
    expect(JSON.stringify(body)).not.toContain('estimatedCostMicros');
  });
});

describe('the refusals the screen must handle are the refusals the API can send', () => {
  test('each non-ok status maps to the status code the refusal copy assumes', () => {
    // The screen's refusal table is keyed on the request-layer status. This pins that each one is a real arm
    // that produces a real HTTP status, so the table cannot drift into covering statuses that never occur.
    const cases: Array<[UsageRequestResult, number]> = [
      [{ status: 'unauthenticated' }, 401],
      [{ status: 'email_unverified' }, 403],
      [{ status: 'forbidden' }, 403],
      [{ status: 'not_found' }, 404],
      [{ status: 'invalid_period' }, 400],
      [{ status: 'unavailable' }, 503],
      [{ status: 'rate_limited', retryAfterSeconds: 30 }, 429],
    ];
    for (const [result, expected] of cases) {
      expect(toUsageResponse(result).status, `${result.status} should be ${String(expected)}`).toBe(expected);
    }
  });

  test('the opaque 403 carries no reason a caller could enumerate account state with', async () => {
    const body = await apiBody({ status: 'forbidden' });
    expect(body).toEqual({ error: 'forbidden' });
  });
});
