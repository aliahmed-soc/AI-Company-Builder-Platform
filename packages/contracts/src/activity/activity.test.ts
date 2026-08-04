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
  ACTIVITY_TYPES_IN_DATABASE_CHECK,
  activityTypesMatchDatabase,
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

describe('activity taxonomy (company-scoped events)', () => {
  test('the visible types are the four company events PLUS the execution events P6-008 added', () => {
    // The set is CLOSED, and it is written out in full here rather than derived: a test that recomputed the
    // expectation from the constant would accept any widening, which is the opposite of what this guards.
    expect([...ACTIVITY_TYPES].sort()).toEqual([
      'approval.approved',
      'approval.rejected',
      'approval.requested',
      'company.created',
      'company.paused',
      'company.resumed',
      'company.updated',
      'task.completed',
      'task.created',
      'task.failed',
      'task.started',
    ]);
    for (const t of ACTIVITY_TYPES) expect(isActivityType(t)).toBe(true);
  });
  test('EVERY type has a summary entry — a projectable type with no allowlist is unrepresentable, not empty', () => {
    // P5-013's failure mode in miniature: widening the type list is only one of the changes required. A type with
    // no allowlist entry would project `undefined` keys rather than a redacted summary.
    for (const t of ACTIVITY_TYPES) expect(activitySummaryFor(t, { anything: 'x' })).toBeDefined();
  });
  test('account-level / Logger-only / unknown names are NOT projectable', () => {
    for (const bad of ['membership.invited', 'membership.revoked', 'authz.denied', 'account.created', 'webhook.x', 'reconcile.done', 'company.deleted', '', 1, null, {}]) {
      expect(isActivityType(bad)).toBe(false);
      expect(isProjectableActivity(bad)).toBe(false);
    }
  });
  test('ACT-003 marking is real: the PROPOSAL is proposed and every completed transition is executed', () => {
    // Named one by one, not derived. Until P6-008 this function returned a constant, so the marking was true by
    // accident of the taxonomy; the point of naming each type is that adding a proposal-shaped event and
    // forgetting `executionStateFor` fails here instead of silently telling a founder something was done.
    expect(executionStateFor('approval.requested')).toBe('proposed');
    for (const t of ACTIVITY_TYPES) {
      if (t === 'approval.requested') continue;
      expect(executionStateFor(t), `${t} reports an action that already happened`).toBe('executed');
    }
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

describe('ACT-005 is SERVED, and the taxonomy matches the database (ACBP-P5-013 → ACBP-P6-008)', () => {
  test('task.failed IS projectable now — the widening P5-013 reverted was completed, all four parts', () => {
    // P5-013 added the type alone and found it was half a feature: no migration widened the
    // activity_events_type_valid CHECK, nothing projected on the failure path, and the projector is FAIL-CLOSED,
    // so the first correct wiring would have made every run failure roll back its own audit write. P6-008 ships
    // the four parts together — type, CHECK (migration 0053), summary allowlist, and the two call sites in the
    // coordinator (reported failure and reaped failure).
    expect(isProjectableActivity('task.failed')).toBe(true);
    expect(ACTIVITY_TYPES).toContain('task.failed');
    // The summary is the CLOSED-SET half of "no blank failures": a category and a retry state, never a message.
    expect(activitySummaryFor('task.failed', { attempt: 2, failure_category: 'worker_lost', retry_state: 'retry_eligible', provider_message: 'connection reset by peer', run_id: 'r1' })).toEqual({
      attempt: 2,
      failure_category: 'worker_lost',
      retry_state: 'retry_eligible',
    });
  });

  test('the execution summaries carry counts and closed-set values ONLY — no title, reason or free text', () => {
    // The redaction that matters most, stated against the exact keys the audit factories produce. A founder's own
    // words and a provider's error text are the two things most likely to be waved through by a summary that
    // simply copied the payload.
    expect(activitySummaryFor('task.created', { has_milestone: true, title: 'Email three suppliers' })).toEqual({ has_milestone: true });
    expect(activitySummaryFor('task.started', { attempt: 1, run_id: 'r1' })).toEqual({ attempt: 1 });
    expect(activitySummaryFor('task.completed', { artifact_count: 2, no_artifact_rationale: false, rationale: 'we found nothing' })).toEqual({ artifact_count: 2, no_artifact_rationale: false });
    expect(activitySummaryFor('approval.requested', { tool_id: 'send_email', risk_class: 'external_reversible', scope: 'one_action', estimated_cost_credits: 1, preview: 'To: 3 suppliers', action: 'Email three suppliers' })).toEqual({
      tool_id: 'send_email',
      risk_class: 'external_reversible',
      scope: 'one_action',
      estimated_cost_credits: 1,
    });
    expect(activitySummaryFor('approval.approved', { decision_path: 'approve', decider_type: 'human', policy_version: 3, note: 'go ahead' })).toEqual({ decision_path: 'approve', decider_type: 'human' });
    expect(activitySummaryFor('approval.rejected', { decider_type: 'human', reason: 'too expensive for us right now' })).toEqual({ decider_type: 'human' });
  });

  test('THE CONTRACTS TAXONOMY AND THE DATABASE CHECK PERMIT THE SAME SET', () => {
    // The guard that makes the divergence impossible to reintroduce silently. If someone widens ACTIVITY_TYPES
    // without a migration, this fails immediately instead of at the moment a failure tries to project.
    expect(activityTypesMatchDatabase()).toBe(true);
    expect([...ACTIVITY_TYPES].sort()).toEqual([...ACTIVITY_TYPES_IN_DATABASE_CHECK].sort());
  });
});
