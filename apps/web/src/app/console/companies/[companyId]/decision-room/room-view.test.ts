/*
 * ACBP-FE-012 — the tri-state section, which is where a queue UI normally lies.
 *
 * A section that refused and a section that is empty must never render the same. The contract makes a
 * zero-count refusal unconstructable on the server side; these tests make sure the client does not
 * reintroduce one on the way to the screen.
 */
import { describe, expect, it } from 'vitest';
import { nonAnsweringSection, okSection, type DecisionRoomItem, type DecisionRoomQueue, type DecisionRoomView } from '@acbp/contracts';
import { describeRoom, toRoomView } from './room-view';

function item(id: string): DecisionRoomItem {
  return { itemId: id, kind: 'approval_request', title: `Item ${id}`, executionState: 'proposed', createdAt: '2026-08-18T00:00:00.000Z', detail: {} } as unknown as DecisionRoomItem;
}

function room(sections: readonly ReturnType<typeof okSection>[]): DecisionRoomView {
  return { sections, integrity: {}, usage: {}, asOf: '2026-08-18T00:00:00.000Z', digest: 'd1' } as unknown as DecisionRoomView;
}

const Q = (n: string): DecisionRoomQueue => n as DecisionRoomQueue;

describe('toRoomView — an unanswered queue is never a zero', () => {
  it('shows a real zero for a queue the server looked at and found empty', () => {
    const v = toRoomView(room([okSection(Q('pending_approvals'), [], 0)]));
    expect(v.queues[0]?.tone).toBe('empty');
    expect(v.queues[0]?.count).toBe(0);
    expect(v.queues[0]?.countLabel).toBe('0');
  });

  it('shows NO number for a restricted queue, and says why', () => {
    const v = toRoomView(room([nonAnsweringSection(Q('pending_approvals'), 'restricted')]));
    expect(v.queues[0]?.tone).toBe('restricted');
    expect(v.queues[0]?.count).toBeNull();
    expect(v.queues[0]?.countLabel).not.toBe('0');
    expect(v.queues[0]?.note?.toLowerCase()).toContain('different from the queue being empty');
  });

  it('shows NO number for an unavailable queue, and calls it unknown rather than empty', () => {
    const v = toRoomView(room([nonAnsweringSection(Q('pending_approvals'), 'unavailable')]));
    expect(v.queues[0]?.tone).toBe('unavailable');
    expect(v.queues[0]?.count).toBeNull();
    expect(v.queues[0]?.note?.toLowerCase()).toContain('unknown rather than empty');
  });

  it('gives the three non-item states three different tones', () => {
    const tones = [
      toRoomView(room([okSection(Q('a'), [], 0)])).queues[0]?.tone,
      toRoomView(room([nonAnsweringSection(Q('a'), 'restricted')])).queues[0]?.tone,
      toRoomView(room([nonAnsweringSection(Q('a'), 'unavailable')])).queues[0]?.tone,
    ];
    expect(new Set(tones).size).toBe(3);
  });
});

describe('toRoomView — a capped sample is not the whole queue', () => {
  it('reports the TRUE total, not the number of items shown', () => {
    // `count` is the true total while `items` is capped at 20. Rendering items.length as the total would
    // under-report by design.
    const v = toRoomView(room([okSection(Q('pending_approvals'), [item('1'), item('2')], 47)]));
    expect(v.queues[0]?.count).toBe(47);
    expect(v.queues[0]?.items).toHaveLength(2);
    expect(v.queues[0]?.truncated).toBe(true);
    expect(v.queues[0]?.note).toContain('of 47');
  });

  it('adds no truncation note when the sample IS the queue', () => {
    const v = toRoomView(room([okSection(Q('pending_approvals'), [item('1')], 1)]));
    expect(v.queues[0]?.truncated).toBe(false);
    expect(v.queues[0]?.note).toBeNull();
  });
});

describe('toRoomView / describeRoom — the page must not claim a complete picture it does not have', () => {
  it('marks the room incomplete when any queue did not answer', () => {
    const v = toRoomView(room([okSection(Q('a'), [], 0), nonAnsweringSection(Q('b'), 'restricted')]));
    expect(v.incomplete).toBe(true);
    expect(v.answeredCount).toBe(1);
    expect(v.totalQueues).toBe(2);
  });

  it('says so in the announced sentence, rather than reporting a total as though it were whole', () => {
    const v = toRoomView(room([okSection(Q('a'), [item('1')], 3), nonAnsweringSection(Q('b'), 'restricted')]));
    const s = describeRoom(v);
    expect(s).toContain('1 of 2 queues');
    expect(s.toLowerCase()).toContain('not a complete picture');
  });

  it('reports a whole room plainly when every queue answered', () => {
    const v = toRoomView(room([okSection(Q('a'), [], 2), okSection(Q('b'), [], 3)]));
    expect(v.incomplete).toBe(false);
    expect(describeRoom(v)).toContain('5 items across all 2 queues');
  });

  it('never counts an unanswered queue as zero in the total', () => {
    // The sum is over answered queues only; treating a refusal as 0 would be the same lie the tri-state
    // exists to prevent, one level up.
    const withRefusal = describeRoom(toRoomView(room([okSection(Q('a'), [], 5), nonAnsweringSection(Q('b'), 'restricted')])));
    expect(withRefusal).toContain('5 items');
    expect(withRefusal).toContain('1 of 2');
  });
});
