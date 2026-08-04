// @acbp/contracts — Decision Room contract tests (ACBP-P6-008; CDR-076; DEC-001).
//
// The assertions that matter here are the two CDR-076 §0 properties expressed at the type/constructor level:
// a non-answering section can never carry a count, and the change digest cannot collapse two different rooms.
import { describe, test, expect } from 'vitest';
import {
  DECISION_ROOM_QUEUES,
  DECISION_ROOM_ITEM_CAP,
  DECISION_ROOM_ITEM_KINDS,
  DECISION_ROOM_STREAM_INTERVAL_MS_DEFAULT,
  DECISION_ROOM_STREAM_INTERVAL_MS_MIN,
  DECISION_ROOM_STREAM_INTERVAL_MS_MAX,
  clampStreamIntervalMs,
  decisionRoomDigest,
  decisionRoomQueuesComplete,
  isDecisionRoomQueue,
  nonAnsweringSection,
  okSection,
  sectionCountIsConsistent,
  streamCountsOf,
  type DecisionRoomItem,
  type DecisionRoomIntegrity,
  type DecisionRoomSection,
  type DecisionRoomUsage,
} from './index.js';

function item(id: string, occurredAt = '2026-08-01T10:00:00.000000Z'): DecisionRoomItem {
  return { id, kind: 'task', title: 'Draft positioning brief', state: 'proposed', occurredAt, detail: {} };
}

const NO_INTEGRITY: DecisionRoomIntegrity = { unverifiedCompletions: 0 };
const NO_USAGE: DecisionRoomUsage = { status: 'restricted', figures: null };

describe('the ten queues are closed and ordered', () => {
  test('DEC-001 names ten queues and this is exactly those ten', () => {
    expect(DECISION_ROOM_QUEUES).toHaveLength(10);
    expect([...DECISION_ROOM_QUEUES]).toEqual([
      'needs_your_decision',
      'recommended_next_actions',
      'questions_from_ai',
      'options_under_consideration',
      'approved_and_queued',
      'executing',
      'results',
      'blocked_work',
      'failed_work',
      'recent_decisions',
    ]);
    expect(new Set(DECISION_ROOM_QUEUES).size).toBe(10);
  });

  test('isDecisionRoomQueue rejects anything outside the closed set', () => {
    expect(isDecisionRoomQueue('results')).toBe(true);
    for (const bad of ['Results', 'jobs', '', null, 42, undefined]) expect(isDecisionRoomQueue(bad)).toBe(false);
  });

  test('decisionRoomQueuesComplete requires all ten, once each, in canonical order', () => {
    const full = DECISION_ROOM_QUEUES.map((q) => nonAnsweringSection(q, 'unavailable'));
    expect(decisionRoomQueuesComplete(full)).toBe(true);

    // A dropped queue, a duplicated queue and a reordered pair must all fail — "one of the ten quietly stopped
    // being produced" is the omission this guard exists to turn into a test failure.
    expect(decisionRoomQueuesComplete(full.slice(0, 9))).toBe(false);
    const duplicated = [...full.slice(0, 9), nonAnsweringSection('results', 'unavailable')];
    expect(decisionRoomQueuesComplete(duplicated)).toBe(false);
    const swapped = [full[1] as DecisionRoomSection, full[0] as DecisionRoomSection, ...full.slice(2)];
    expect(decisionRoomQueuesComplete(swapped)).toBe(false);
  });

  test('item kinds are closed', () => {
    expect(new Set(DECISION_ROOM_ITEM_KINDS).size).toBe(DECISION_ROOM_ITEM_KINDS.length);
  });
});

describe('CDR-076 §0 lie 2: an empty section and a broken section are different types', () => {
  test('a non-answering section CANNOT carry a count — there is no constructor for it', () => {
    for (const status of ['restricted', 'unavailable'] as const) {
      const s = nonAnsweringSection('needs_your_decision', status);
      expect(s.status).toBe(status);
      expect(s.count).toBeNull();
      expect(s.items).toHaveLength(0);
      expect(s.truncated).toBe(false);
      expect(sectionCountIsConsistent(s)).toBe(true);
    }
  });

  test('an EMPTY ok section is a positive claim: count 0, not null', () => {
    const s = okSection('needs_your_decision', [], 0);
    expect(s.status).toBe('ok');
    expect(s.count).toBe(0);
    expect(sectionCountIsConsistent(s)).toBe(true);
  });

  test('sectionCountIsConsistent rejects the two illegal pairings', () => {
    // A degraded section pretending to be empty — the exact render that reads as "all clear" (CDR-076 §0).
    expect(sectionCountIsConsistent({ queue: 'results', status: 'unavailable', count: 0, items: [], truncated: false })).toBe(false);
    // An answering section with no count.
    expect(sectionCountIsConsistent({ queue: 'results', status: 'ok', count: null, items: [], truncated: false })).toBe(false);
    // A restricted section that leaked items.
    expect(sectionCountIsConsistent({ queue: 'results', status: 'restricted', count: null, items: [item('t1')], truncated: false })).toBe(false);
  });
});

describe('item cap: a short sample is never mistaken for the whole queue', () => {
  test('items are capped while the count stays the TRUE total and truncated is set', () => {
    const many = Array.from({ length: DECISION_ROOM_ITEM_CAP + 5 }, (_, i) => item(`t${i}`));
    const s = okSection('executing', many, many.length);
    expect(s.items).toHaveLength(DECISION_ROOM_ITEM_CAP);
    expect(s.count).toBe(DECISION_ROOM_ITEM_CAP + 5);
    expect(s.truncated).toBe(true);
  });

  test('a total larger than the sample marks truncated even when the sample is short', () => {
    expect(okSection('executing', [item('t1')], 9).truncated).toBe(true);
    expect(okSection('executing', [item('t1')], 1).truncated).toBe(false);
  });
});

describe('the change digest is exact, because a collision is a change nobody is told about', () => {
  const base = DECISION_ROOM_QUEUES.map((q) => okSection(q, [], 0));

  test('identical rooms digest identically', () => {
    expect(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE)).toBe(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE));
  });

  test('a changed count changes the digest', () => {
    const changed = base.map((s, i) => (i === 0 ? okSection(s.queue, [item('a1')], 1) : s));
    expect(decisionRoomDigest(changed, NO_INTEGRITY, NO_USAGE)).not.toBe(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE));
  });

  test('a SAME-SIZE queue whose newest item changed still changes the digest', () => {
    // The subtle one: one item in, one item out. Counting alone would call this "no change" and the founder
    // would never learn that the thing waiting for them is now a different thing.
    const before = base.map((s, i) => (i === 0 ? okSection(s.queue, [item('a1')], 1) : s));
    const after = base.map((s, i) => (i === 0 ? okSection(s.queue, [item('a2')], 1) : s));
    expect(decisionRoomDigest(after, NO_INTEGRITY, NO_USAGE)).not.toBe(decisionRoomDigest(before, NO_INTEGRITY, NO_USAGE));
  });

  test('an ok-empty section and an unavailable section do NOT digest alike', () => {
    const degraded = base.map((s, i) => (i === 0 ? nonAnsweringSection(s.queue, 'unavailable') : s));
    expect(decisionRoomDigest(degraded, NO_INTEGRITY, NO_USAGE)).not.toBe(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE));
  });

  test('integrity and usage participate in the digest', () => {
    expect(decisionRoomDigest(base, { unverifiedCompletions: 1 }, NO_USAGE)).not.toBe(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE));
    const withUsage: DecisionRoomUsage = { status: 'ok', figures: { eventCount: 1, inputTokens: 2, outputTokens: 3, estimatedCostMicros: 4 } };
    expect(decisionRoomDigest(base, NO_INTEGRITY, withUsage)).not.toBe(decisionRoomDigest(base, NO_INTEGRITY, NO_USAGE));
  });
});

describe('stream bounds', () => {
  test('interval clamps into [MIN, MAX] and defaults on garbage', () => {
    expect(clampStreamIntervalMs(undefined)).toBe(DECISION_ROOM_STREAM_INTERVAL_MS_DEFAULT);
    expect(clampStreamIntervalMs('not-a-number')).toBe(DECISION_ROOM_STREAM_INTERVAL_MS_DEFAULT);
    expect(clampStreamIntervalMs(0)).toBe(DECISION_ROOM_STREAM_INTERVAL_MS_MIN);
    expect(clampStreamIntervalMs(-1_000_000)).toBe(DECISION_ROOM_STREAM_INTERVAL_MS_MIN);
    expect(clampStreamIntervalMs(10_000)).toBe(10_000);
    expect(clampStreamIntervalMs(10 ** 9)).toBe(DECISION_ROOM_STREAM_INTERVAL_MS_MAX);
    expect(clampStreamIntervalMs('3000')).toBe(3_000);
  });

  test('stream counts preserve null for non-answering sections', () => {
    const sections = [okSection('results', [], 4), nonAnsweringSection('failed_work', 'unavailable')];
    const counts = streamCountsOf(sections);
    expect(counts['results']).toBe(4);
    expect(counts['failed_work']).toBeNull();
  });
});
