// @acbp/contracts — activity feed contract tests (ACBP-P1-009; CDR-016).
import { describe, test, expect } from 'vitest';
import { companyCreated, companyPaused } from '../audit/index.js';
import {
  ACTIVITY_TYPES,
  isActivityType,
  isProjectableActivity,
  executionStateFor,
  activityDisplayPayload,
  clampActivityPageSize,
  encodeActivityCursor,
  decodeActivityCursor,
  ACTIVITY_PAGE_SIZE_DEFAULT,
  ACTIVITY_PAGE_SIZE_MAX,
} from './index.js';

describe('activity taxonomy (company events only)', () => {
  test('the visible types are exactly the four company events', () => {
    expect([...ACTIVITY_TYPES].sort()).toEqual(['company.created', 'company.paused', 'company.resumed', 'company.updated']);
    for (const t of ACTIVITY_TYPES) expect(isActivityType(t)).toBe(true);
  });
  test('account-level / Logger-only / unknown names are NOT projectable', () => {
    for (const bad of ['membership.invited', 'membership.revoked', 'authz.denied', 'account.created', 'webhook.x', 'reconcile.done', 'company.deleted', '', 1, null, {}]) {
      expect(isActivityType(bad as unknown)).toBe(false);
      expect(isProjectableActivity(bad as unknown)).toBe(false);
    }
  });
  test('every company event is an executed fact (ACT-003 marking)', () => {
    for (const t of ACTIVITY_TYPES) expect(executionStateFor(t)).toBe('executed');
  });
});

describe('activityDisplayPayload (redaction)', () => {
  test('projects the bounded safe audit metadata (creation_mode) and nothing more', () => {
    const ev = companyCreated({ companyId: 'co_1', creationMode: 'own_idea' });
    expect(activityDisplayPayload(ev)).toEqual({ creation_mode: 'own_idea' });
  });
  test('an event with no display fields projects an empty payload', () => {
    expect(activityDisplayPayload(companyPaused({ companyId: 'co_2' }))).toEqual({});
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

describe('activity cursor (opaque, versioned, company-bound keyset)', () => {
  const co = 'co_abc';
  const pos = { occurredAt: '2026-07-22T10:00:00.000Z', eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' };

  test('round-trips for the same company', () => {
    const token = encodeActivityCursor(co, pos);
    expect(decodeActivityCursor(co, token)).toEqual(pos);
  });
  test("rejects another company's cursor (binding)", () => {
    const token = encodeActivityCursor(co, pos);
    expect(decodeActivityCursor('co_other', token)).toBeNull();
  });
  test('rejects malformed / non-string / oversized / wrong-version tokens (fail-closed, never throws)', () => {
    const enc = (obj: unknown) => encodeURIComponent(JSON.stringify(obj));
    expect(decodeActivityCursor(co, '%')).toBeNull(); // malformed percent-encoding
    expect(decodeActivityCursor(co, '')).toBeNull();
    expect(decodeActivityCursor(co, 42)).toBeNull();
    expect(decodeActivityCursor(co, 'x'.repeat(600))).toBeNull();
    expect(decodeActivityCursor(co, enc({ v: 2, c: co, o: pos.occurredAt, e: pos.eventId }))).toBeNull(); // wrong version
    expect(decodeActivityCursor(co, enc({ v: 1, c: co, o: 123, e: pos.eventId }))).toBeNull(); // non-string occurredAt
    expect(decodeActivityCursor(co, encodeURIComponent('{bad'))).toBeNull(); // non-JSON
  });
});
