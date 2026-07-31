// @acbp/contracts — emergency-stop scopes and the covering relation (ACBP-P6-007a; CDR-072 §1-G2/G3/G5).
// Written BEFORE the implementation and watched to fail.
//
// THE FAILURE THIS SUITE IS WRITTEN AGAINST (CDR-072 §0): a stop that silently fails to reach one scope is worse
// than no stop at all, because the operator believes it worked and stops watching. So every scope is proven TWICE
// — it halts what it claims to halt, and it does NOT halt what it should not — and the matrix is driven off the
// closed scope list so adding a scope without its two cases fails rather than passes quietly.
import { describe, test, expect } from 'vitest';
import {
  STOP_SCOPES,
  isStopScope,
  evaluateStops,
  type StopScope,
  type StopRecord,
  type StoppableCall,
} from './scope.js';

/** A call with no distinguishing attachments. Each case adds only what it needs. */
const CALL: StoppableCall = {
  taskId: 'task-1',
  workerId: 'worker-1',
  capabilityId: 'cap-1',
  integrationId: 'integration-1',
  hasExternalEffect: false,
};

const stop = (scope: StopScope, targetId: string | null = null): StopRecord => ({ scope, targetId });

/**
 * For each scope: a record that MUST cover `CALL`, and one that MUST NOT.
 *
 * The "misses" are the half a positive-only suite would omit — and without them, "each scope covers exactly its own
 * calls" and "any stop blocks everything" are indistinguishable, because the second passes every positive case.
 */
const MATRIX: Record<StopScope, { covers: StopRecord; misses: StopRecord; missNote: string }> = {
  task: { covers: stop('task', 'task-1'), misses: stop('task', 'task-OTHER'), missNote: 'a different task' },
  worker: { covers: stop('worker', 'worker-1'), misses: stop('worker', 'worker-OTHER'), missNote: 'a different worker' },
  capability: { covers: stop('capability', 'cap-1'), misses: stop('capability', 'cap-OTHER'), missNote: 'a different capability' },
  integration: {
    covers: stop('integration', 'integration-1'),
    misses: stop('integration', 'integration-OTHER'),
    missNote: 'a different integration',
  },
  // Company scope covers every call in the company; the "miss" is therefore a DIFFERENT company's stop, which the
  // store scopes out — represented here by a target that does not match the call's company.
  company: { covers: stop('company', 'company-1'), misses: stop('company', 'company-OTHER'), missNote: "another company's stop" },
  // Not identity-based: it covers by the tool's EXTERNAL EFFECT, taken from the registry and never from model text.
  external_actions_only: {
    covers: stop('external_actions_only'),
    misses: stop('external_actions_only'),
    missNote: 'an internal-only call',
  },
  account_wide: { covers: stop('account_wide'), misses: stop('account_wide'), missNote: '(never misses — see its own case)' },
};

const inCompany = (call: StoppableCall = CALL): StoppableCall => ({ ...call, companyId: 'company-1' });

describe('the scope vocabulary is canon-s, closed, and complete', () => {
  test('diagram 13 names exactly seven scopes', () => {
    expect(STOP_SCOPES).toEqual([
      'task',
      'worker',
      'capability',
      'integration',
      'company',
      'external_actions_only',
      'account_wide',
    ]);
  });

  test('every scope has BOTH a covering and a non-covering case in this suite', () => {
    // The guard against a scope being added with only half its proof — or with none.
    expect(Object.keys(MATRIX).sort()).toEqual([...STOP_SCOPES].sort());
  });

  test.each(STOP_SCOPES)('%s is a scope', (s) => expect(isStopScope(s)).toBe(true));

  test.each(['', 'TASK', 'account', 'everything', null, undefined, 0, {}])('%p is not a scope', (v) => {
    expect(isStopScope(v)).toBe(false);
  });
});

describe('CDR-072 §1-G2 — each scope halts what it CLAIMS to halt', () => {
  test.each(STOP_SCOPES.filter((s) => s !== 'external_actions_only'))('a %s stop covers its own call', (scope) => {
    const r = evaluateStops([MATRIX[scope].covers], inCompany());
    expect(r).toMatchObject({ kind: 'stopped' });
  });

  test('an external_actions_only stop covers a call WITH an external effect', () => {
    const r = evaluateStops([stop('external_actions_only')], inCompany({ ...CALL, hasExternalEffect: true }));
    expect(r).toMatchObject({ kind: 'stopped' });
  });

  test('account_wide covers a call with NO attachments at all — nothing escapes by being unattached', () => {
    const bare: StoppableCall = { taskId: null, workerId: null, capabilityId: null, integrationId: null, hasExternalEffect: false };
    expect(evaluateStops([stop('account_wide')], inCompany(bare))).toMatchObject({ kind: 'stopped' });
  });
});

describe('CDR-072 §1-G2 — each scope does NOT halt what it should not', () => {
  // Over-halting is a different defect from under-halting and still a defect: a targeted control that silently
  // becomes a full outage leaves the operator's model of what is running wrong in the other direction.
  test.each(STOP_SCOPES.filter((s) => s !== 'account_wide' && s !== 'external_actions_only'))(
    'a %s stop does not cover a call it does not name',
    (scope) => {
      expect(evaluateStops([MATRIX[scope].misses], inCompany())).toEqual({ kind: 'clear' });
    },
  );

  test('an external_actions_only stop does NOT cover an internal-only call', () => {
    expect(evaluateStops([stop('external_actions_only')], inCompany({ ...CALL, hasExternalEffect: false }))).toEqual({ kind: 'clear' });
  });

  test('no stops at all is CLEAR — the control without which "always stopped" would pass everything above', () => {
    expect(evaluateStops([], inCompany())).toEqual({ kind: 'clear' });
  });
});

describe('CDR-072 §1-G5 — the evaluation says WHICH scopes halted', () => {
  test('a single covering stop names its scope', () => {
    const r = evaluateStops([stop('task', 'task-1')], inCompany());
    expect(r).toMatchObject({ kind: 'stopped', scopes: ['task'] });
  });

  test('several covering stops name ALL of them, so the record answers "what is halted"', () => {
    const r = evaluateStops([stop('task', 'task-1'), stop('account_wide'), stop('worker', 'worker-1')], inCompany());
    expect(r).toMatchObject({ kind: 'stopped' });
    expect([...(r as unknown as { scopes: StopScope[] }).scopes].sort()).toEqual(['account_wide', 'task', 'worker']);
  });

  test('non-covering stops are NOT named — the record must not overstate what halted', () => {
    const r = evaluateStops([stop('task', 'task-1'), stop('worker', 'worker-OTHER')], inCompany());
    expect((r as unknown as { scopes: StopScope[] }).scopes).toEqual(['task']);
  });
});

describe('CDR-072 §1-G3 — a record that cannot be interpreted is UNREADABLE, never silently skipped', () => {
  // The §0 failure in miniature. A scoped stop with no target could be read two ways: cover nothing (the stop
  // silently does nothing while the operator believes it worked) or cover everything (over-halt). BOTH are wrong,
  // so it is neither — it is unreadable, and the dispatcher already turns that into `stop_unavailable` -> denied.
  test.each(['task', 'worker', 'capability', 'integration', 'company'] as const)(
    'a %s stop with NO target is unreadable, not clear',
    (scope) => {
      expect(evaluateStops([stop(scope, null)], inCompany())).toMatchObject({ kind: 'unreadable' });
    },
  );

  test('an unrecognised scope is unreadable', () => {
    expect(evaluateStops([{ scope: 'whatever', targetId: null } as unknown as StopRecord], inCompany())).toMatchObject({
      kind: 'unreadable',
    });
  });

  test('a malformed record makes the WHOLE evaluation unreadable even when another stop already covers the call', () => {
    // Otherwise a broken record could hide behind a working one and nobody would learn the store is corrupt.
    const r = evaluateStops([stop('account_wide'), stop('task', null)], inCompany());
    expect(r).toMatchObject({ kind: 'unreadable' });
  });

  test('unreadable BEATS clear — a corrupt store must never read as "no stop is in force"', () => {
    expect(evaluateStops([stop('task', null)], inCompany())).not.toEqual({ kind: 'clear' });
  });
});
