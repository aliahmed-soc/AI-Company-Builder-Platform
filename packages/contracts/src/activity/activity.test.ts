// @acbp/contracts — activity feed contract tests (ACBP-P1-009; CDR-016).
import { describe, test, expect } from 'vitest';
import {
  ACTIVITY_TYPES,
  isActivityType,
  isProjectableActivity,
  executionStateFor,
  activitySummaryFor,
  clampActivityPageSize,
  encodeActivityCursor,
  decodeActivityCursor,
  isActivityTimestamp,
  microsecondEpochToIso,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
  type ActivityCursor,
} from './index.js';

describe('exact temporal serialization', () => {
  test('isActivityTimestamp: strict ISO-8601 UTC with 0-6 fraction digits', () => {
    expect(isActivityTimestamp('2026-07-22T10:00:00Z')).toBe(true);
    expect(isActivityTimestamp('2026-07-22T10:00:00.1Z')).toBe(true);
    expect(isActivityTimestamp('2026-07-22T10:00:00.123Z')).toBe(true);
    expect(isActivityTimestamp('2026-07-22T10:00:00.123456Z')).toBe(true);
    for (const bad of ['2026', 'Jan 1 2026', '2026-07-22 10:00:00Z', '2026-07-22T10:00:00.1234567Z', '2026-99-99T10:00:00Z', '', 42, null]) {
      expect(isActivityTimestamp(bad)).toBe(false);
    }
  });
  test('microsecondEpochToIso: exact integer conversion, no float in the path', () => {
    const seconds = Math.floor(Date.parse('2026-07-22T10:00:00Z') / 1000);
    expect(microsecondEpochToIso(String(seconds * 1_000_000 + 123456))).toBe('2026-07-22T10:00:00.123456Z');
    expect(microsecondEpochToIso(`${seconds * 1_000_000}`)).toBe('2026-07-22T10:00:00.000000Z');
    expect(microsecondEpochToIso(`${seconds * 1_000_000 + 999999}`)).toBe('2026-07-22T10:00:00.999999Z');
    for (const bad of ['', 'abc', '-5', '1.5', 12345, null, undefined, '9'.repeat(20)]) {
      expect(microsecondEpochToIso(bad)).toBeNull();
    }
  });
});

describe('activity taxonomy (company events only)', () => {
  test('the visible types are exactly the four company events', () => {
    // WIDENED ONCE, DELIBERATELY: `task.failed` joined the set for ACT-005 (ACBP-P5-013; CDR-059 G6). This assertion
    // firing on an addition is the guard working — the set is closed, and every member has to be argued for.
    expect([...ACTIVITY_TYPES].sort()).toEqual(['company.created', 'company.paused', 'company.resumed', 'company.updated', 'task.failed']);
    for (const t of ACTIVITY_TYPES) expect(isActivityType(t)).toBe(true);
  });
  test('account-level / Logger-only / unknown names are NOT projectable', () => {
    for (const bad of ['membership.invited', 'membership.revoked', 'authz.denied', 'account.created', 'webhook.x', 'reconcile.done', 'company.deleted', '', 1, null, {}]) {
      expect(isActivityType(bad)).toBe(false);
      expect(isProjectableActivity(bad)).toBe(false);
    }
  });
  test('every company event is an executed fact (ACT-003 marking)', () => {
    for (const t of ACTIVITY_TYPES) expect(executionStateFor(t)).toBe('executed');
  });
});

describe('activitySummaryFor (per-type allowlist redaction)', () => {
  test('company.created exposes creation_mode ONLY; unknown keys are dropped', () => {
    expect(activitySummaryFor('company.created', { creation_mode: 'own_idea', evil: 'x', correlation_id: 'c1' })).toEqual({ creation_mode: 'own_idea' });
  });
  test('company.updated exposes changed_fields ONLY', () => {
    expect(activitySummaryFor('company.updated', { changed_fields: 'name,description', reason: 'leak' })).toEqual({ changed_fields: 'name,description' });
  });
  test('company.paused / company.resumed have EMPTY summaries regardless of stored payload', () => {
    expect(activitySummaryFor('company.paused', { reason: 'should-not-appear' })).toEqual({});
    expect(activitySummaryFor('company.resumed', { held_work_count: 3 })).toEqual({});
  });
  test('non-scalar values are never emitted', () => {
    expect(activitySummaryFor('company.created', { creation_mode: { nested: true } })).toEqual({});
  });
});

describe('clampActivityPageSize', () => {
  test('defaults on absent/invalid, floors, and caps at MAX', () => {
    expect(clampActivityPageSize(undefined)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT);
    expect(clampActivityPageSize('nope')).toBe(ACTIVITY_PAGE_SIZE_DEFAULT);
    expect(clampActivityPageSize(0)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT);
    expect(clampActivityPageSize(-5)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT);
    expect(clampActivityPageSize(10)).toBe(10);
    expect(clampActivityPageSize('10')).toBe(10);
    expect(clampActivityPageSize(10.9)).toBe(10);
    expect(clampActivityPageSize(1000)).toBe(ACTIVITY_PAGE_SIZE_MAX);
    expect(clampActivityPageSize(Infinity)).toBe(ACTIVITY_PAGE_SIZE_DEFAULT);
  });
});

describe('activity cursor (opaque base64url; versioned; account+company bound; after + upper bound)', () => {
  const acct = '11111111-1111-1111-1111-111111111111';
  const co = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const CUR: ActivityCursor = {
    after: { occurredAt: '2026-07-22T10:00:00.000Z', eventId: '01ARZ3NDEKTSV4RRFFQ69G5FA1' },
    upper: { occurredAt: '2026-07-22T12:00:00.000Z', eventId: '01ARZ3NDEKTSV4RRFFQ69G5FA9' },
  };
  const encObj = (obj: unknown): string => {
    // Local base64url encoder for forged-token construction in tests (ASCII payloads).
    const s = JSON.stringify(obj);
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const b0 = s.charCodeAt(i);
      const b1 = i + 1 < s.length ? s.charCodeAt(i + 1) : NaN;
      const b2 = i + 2 < s.length ? s.charCodeAt(i + 2) : NaN;
      out += A[b0 >> 2];
      out += A[((b0 & 3) << 4) | (Number.isNaN(b1) ? 0 : b1 >> 4)];
      if (!Number.isNaN(b1)) out += A[((b1 & 15) << 2) | (Number.isNaN(b2) ? 0 : b2 >> 6)];
      if (!Number.isNaN(b2)) out += A[b2 & 63];
    }
    return out;
  };
  const base = { v: 2, a: acct, c: co, o: CUR.after.occurredAt, e: CUR.after.eventId, uo: CUR.upper.occurredAt, ue: CUR.upper.eventId };

  test('round-trips for the same account+company and is URL-safe (no +, /, =)', () => {
    const token = encodeActivityCursor(acct, co, CUR);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toMatch(/[+/=]/);
    expect(decodeActivityCursor(acct, co, token)).toEqual(CUR);
  });
  test('rejects a foreign account and a foreign company (binding)', () => {
    const token = encodeActivityCursor(acct, co, CUR);
    expect(decodeActivityCursor('22222222-2222-2222-2222-222222222222', co, token)).toBeNull();
    expect(decodeActivityCursor(acct, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', token)).toBeNull();
  });
  test('rejects malformed base64 (bad alphabet, impossible length), empty, non-string, oversized', () => {
    expect(decodeActivityCursor(acct, co, 'has+plus/and=pad')).toBeNull();
    expect(decodeActivityCursor(acct, co, 'ab!cd')).toBeNull();
    expect(decodeActivityCursor(acct, co, 'AAAAA')).toBeNull(); // length % 4 === 1 is impossible
    expect(decodeActivityCursor(acct, co, '')).toBeNull();
    expect(decodeActivityCursor(acct, co, 42)).toBeNull();
    expect(decodeActivityCursor(acct, co, 'A'.repeat(700))).toBeNull();
  });
  test('rejects non-JSON and non-ASCII (malformed UTF-8) payloads', () => {
    expect(decodeActivityCursor(acct, co, encObj('not-an-object'))).toBeNull(); // valid JSON but not an object
    expect(decodeActivityCursor(acct, co, 'e2JhZA')).toBeNull(); // decodes to '{bad' — not JSON
    expect(decodeActivityCursor(acct, co, 'w6k')).toBeNull(); // decodes to bytes 0xC3 0xA9 (UTF-8 'é') — non-ASCII rejected
  });
  test('rejects unknown version, missing fields, and excessive field lengths', () => {
    expect(decodeActivityCursor(acct, co, encObj({ ...base, v: 1 }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, v: 3 }))).toBeNull();
    for (const missing of ['a', 'c', 'o', 'e', 'uo', 'ue'] as const) {
      const { [missing]: _drop, ...rest } = base;
      expect(decodeActivityCursor(acct, co, encObj(rest))).toBeNull();
    }
    expect(decodeActivityCursor(acct, co, encObj({ ...base, o: 'x'.repeat(50) }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, e: 'x'.repeat(80) }))).toBeNull();
  });
  test('rejects an invalid timestamp and an invalid (non-ULID) event id', () => {
    expect(decodeActivityCursor(acct, co, encObj({ ...base, o: 'not-a-date' }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, uo: 'also-not-a-date' }))).toBeNull();
    // Date.parse-permissive forms are rejected by the strict activity-timestamp shape.
    expect(decodeActivityCursor(acct, co, encObj({ ...base, o: '2026' }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, o: 'Jan 1 2026' }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, e: 'not-a-ulid' }))).toBeNull();
    expect(decodeActivityCursor(acct, co, encObj({ ...base, ue: 'short' }))).toBeNull();
  });
  test('accepts exact microsecond-precision timestamps (the canonical stored form)', () => {
    const micro: ActivityCursor = {
      after: { occurredAt: '2026-07-22T10:00:00.123456Z', eventId: CUR.after.eventId },
      upper: { occurredAt: '2026-07-22T12:00:00.999999Z', eventId: CUR.upper.eventId },
    };
    expect(decodeActivityCursor(acct, co, encodeActivityCursor(acct, co, micro))).toEqual(micro);
  });
  test('a tampered-but-well-formed position still decodes (it can only move the traversal inside the same company)', () => {
    const tamperedAfter = encObj({ ...base, o: '2026-01-01T00:00:00.000Z' });
    expect(decodeActivityCursor(acct, co, tamperedAfter)).toEqual({ after: { occurredAt: '2026-01-01T00:00:00.000Z', eventId: CUR.after.eventId }, upper: CUR.upper });
    const tamperedUpper = encObj({ ...base, ue: '01ARZ3NDEKTSV4RRFFQ69G5FA2' });
    expect(decodeActivityCursor(acct, co, tamperedUpper)?.upper.eventId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FA2');
  });
});

describe('ACT-005 — a failure is visible in the feed (ACBP-P5-013; CDR-059 G6)', () => {
  test('task.failed IS projectable — the taxonomy is deliberately widened past the four company events', () => {
    // CDR-016 closed this set at the four company lifecycle events. ACT-005 requires failure visibility with a
    // "suppression-proof feed record", and a feed that showed everything the system did EXCEPT its failures would be
    // the specific dishonesty that requirement names. The widening is recorded in CDR-059 G6.
    expect(isProjectableActivity('task.failed')).toBe(true);
    expect(ACTIVITY_TYPES).toContain('task.failed');
  });

  test('its summary carries the CATEGORY, the ATTEMPT and the RETRY STATE - and nothing else', () => {
    // Exactly what TASK-006 and TASK-010 require a founder to be able to see, and no more. No run id, no actor, no
    // free text, and above all no provider message: the category IS the explanation.
    const summary = activitySummaryFor('task.failed', {
      failure_category: 'provider_error',
      attempt: 2,
      retry_state: 'scheduled',
      run_id: 'should-be-dropped',
      provider_message: 'connection reset by peer',
    });
    expect(summary).toEqual({ failure_category: 'provider_error', attempt: 2, retry_state: 'scheduled' });
    expect(Object.keys(summary)).not.toContain('run_id');
    expect(JSON.stringify(summary)).not.toContain('connection reset');
  });

  test('a failure is an EXECUTED fact, like every other feed item', () => {
    // It already happened. Marking it 'proposed' would suggest the founder could still prevent it (ACT-003).
    expect(executionStateFor('task.failed')).toBe('executed');
  });
});