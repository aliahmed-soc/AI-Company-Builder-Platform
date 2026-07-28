// ACBP-P5-005 — the worker runtime's decisions, made executable (CDR-057; NFR-015; WORK-006).
//
// NFR-015 is unusually precise: *"a runaway task cannot exceed its budget by more than ONE BILLING INCREMENT"*. That
// sentence is a statement about WHEN the check happens, not about how it is written, and these tests pin it.
import { describe, test, expect } from 'vitest';
import {
  WORKER_RUN_OUTCOMES,
  isWorkerRunOutcome,
  isTerminalWorkerRunOutcome,
  decideStepAdmission,
  DEFAULT_MAX_SPEND_MICROS,
  DEFAULT_MAX_DURATION_MS,
} from './runtime.js';

const budget = { maxSpendMicros: 1_000, maxDurationMs: 10_000 };
const admit = (over: Partial<Parameters<typeof decideStepAdmission>[0]> = {}) =>
  decideStepAdmission({ ...budget, spentMicros: 0, elapsedMs: 0, stopRequested: false, ...over });

describe('worker-run outcomes', () => {
  test('are exactly running · succeeded · failed · stopped', () => {
    expect([...WORKER_RUN_OUTCOMES]).toEqual(['running', 'succeeded', 'failed', 'stopped']);
  });

  test('the guards are deny-by-default, and `running` is not terminal', () => {
    for (const o of WORKER_RUN_OUTCOMES) expect(isWorkerRunOutcome(o)).toBe(true);
    for (const bad of ['RUNNING', 'done', '', null, undefined, 42]) expect(isWorkerRunOutcome(bad)).toBe(false);
    expect(isTerminalWorkerRunOutcome('running')).toBe(false);
    for (const o of ['succeeded', 'failed', 'stopped']) expect(isTerminalWorkerRunOutcome(o)).toBe(true);
  });
});

describe('decideStepAdmission — the budget is checked BEFORE the step (NFR-015)', () => {
  test('a run well inside its budget proceeds', () => {
    expect(admit({ spentMicros: 100 })).toEqual({ kind: 'proceed' });
  });

  test('spend AT the cap halts — the cap is a ceiling, not a target', () => {
    // `>=`, not `>`. At exactly the cap there is no headroom left, and admitting one more call would spend past it.
    expect(admit({ spentMicros: budget.maxSpendMicros })).toEqual({ kind: 'halt', reason: 'budget_exhausted', failureCategory: 'policy_blocked' });
  });

  test('OVERSHOOT IS BOUNDED BY ONE STEP — the whole point of checking first', () => {
    // A step is admitted while there is any headroom, so the most a run can exceed its cap by is the cost of the one
    // call that crossed the line. Checking AFTERWARDS would bound nothing at all: a single expensive call could land
    // arbitrarily far past the cap and only then be noticed.
    expect(admit({ spentMicros: budget.maxSpendMicros - 1 })).toEqual({ kind: 'proceed' });
    // ...and having crossed it, the NEXT step is refused, which is what makes the overshoot exactly one increment.
    expect(admit({ spentMicros: budget.maxSpendMicros + 999_999 })).toMatchObject({ kind: 'halt', reason: 'budget_exhausted' });
  });

  test('a budget breach halts with `policy_blocked`, not with a success or a timeout', () => {
    const d = admit({ spentMicros: 5_000 });
    expect(d).toMatchObject({ kind: 'halt', failureCategory: 'policy_blocked' });
  });
});

describe('decideStepAdmission — duration (WORK-006 / backlog: "Overrun = safe-stop failed(timeout)")', () => {
  test('elapsed AT the bound halts, with the `timeout` category canon names', () => {
    expect(admit({ elapsedMs: budget.maxDurationMs })).toEqual({ kind: 'halt', reason: 'duration_exceeded', failureCategory: 'timeout' });
  });

  test('inside the bound proceeds', () => {
    expect(admit({ elapsedMs: budget.maxDurationMs - 1 })).toEqual({ kind: 'proceed' });
  });
});

describe('decideStepAdmission — precedence and the safe stop', () => {
  test('a STOP REQUEST wins over everything — an owner asking to stop is not a failure', () => {
    // Reported as `stopped`, never `failed`: the run did what it was told. Conflating the two would make an owner's
    // deliberate intervention look like a malfunction in every report that counts failures.
    const d = decideStepAdmission({ ...budget, spentMicros: 99_999, elapsedMs: 99_999, stopRequested: true });
    expect(d).toEqual({ kind: 'stop' });
  });

  test('budget is reported before duration when BOTH are breached — the cheaper thing to fix is named first', () => {
    const d = decideStepAdmission({ ...budget, spentMicros: 99_999, elapsedMs: 99_999, stopRequested: false });
    expect(d).toMatchObject({ reason: 'budget_exhausted' });
  });
});

describe('decideStepAdmission — total and fail-closed', () => {
  test('a MISSING or nonsense budget halts rather than admitting an unbounded run', () => {
    // An absent cap must never read as "no limit". A run whose bounds we cannot determine is exactly the runaway
    // NFR-015 exists to stop.
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '1000']) {
      expect(decideStepAdmission({ ...budget, maxSpendMicros: bad as number, spentMicros: 0, elapsedMs: 0, stopRequested: false })).toMatchObject({ kind: 'halt' });
      expect(decideStepAdmission({ ...budget, maxDurationMs: bad as number, spentMicros: 0, elapsedMs: 0, stopRequested: false })).toMatchObject({ kind: 'halt' });
    }
  });

  test('nonsense COUNTERS halt too — an unreadable spend is not a zero spend', () => {
    for (const bad of [undefined, null, -1, Number.NaN, '5']) {
      expect(decideStepAdmission({ ...budget, spentMicros: bad as number, elapsedMs: 0, stopRequested: false })).toMatchObject({ kind: 'halt' });
      expect(decideStepAdmission({ ...budget, spentMicros: 0, elapsedMs: bad as number, stopRequested: false })).toMatchObject({ kind: 'halt' });
    }
  });

  test('the defaults it is normally used with do admit a first step', () => {
    // A sanity floor: if the shipped interim budgets refused their own first call, every run would halt immediately.
    expect(decideStepAdmission({ maxSpendMicros: DEFAULT_MAX_SPEND_MICROS, maxDurationMs: DEFAULT_MAX_DURATION_MS, spentMicros: 0, elapsedMs: 0, stopRequested: false })).toEqual({ kind: 'proceed' });
  });
});
