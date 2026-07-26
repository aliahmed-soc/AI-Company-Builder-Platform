// @acbp/contracts — board projection tests (ACBP-P4-004; CDR-042; TASK-001 views).
import { describe, test, expect } from 'vitest';
import { TASK_STATES, TERMINAL_TASK_STATES } from './task.js';
import {
  TASK_BOARD_BUCKETS,
  BUCKET_AVAILABILITY,
  isTaskBoardBucket,
  placeOnBoard,
  isDependencyBlocked,
  emptyBoardCounts,
  type TaskBoardBucket,
} from './board.js';

describe('the bucket set (CDR-042 §2 — the six observed TABS, plus held and cancelled)', () => {
  test('the six PRD buckets are all present, in the order the reference product showed them', () => {
    // TASK-001 names six; `raw-audit/evidence/task-states.csv` recorded them as TABS, four of them empty.
    expect(TASK_BOARD_BUCKETS.slice(0, 6)).toEqual(['to_do', 'recurring', 'in_progress', 'completed', 'rejected', 'failed']);
    // Plus the two this platform must show honestly: cancelled (named by TASK-001) and held (CDR-042 §3-G4).
    expect(TASK_BOARD_BUCKETS).toContain('cancelled');
    expect(TASK_BOARD_BUCKETS).toContain('held');
    expect(isTaskBoardBucket('to_do')).toBe(true);
    expect(isTaskBoardBucket('in_review')).toBe(false);
  });

  test('recurring and rejected declare themselves UNAVAILABLE in this version rather than looking empty', () => {
    // Omitting them would misrepresent the product as lacking the concept; showing them as ordinary empty columns
    // would imply the owner simply has no such work. Neither is true (CDR-042 §3-G2/G3).
    expect(BUCKET_AVAILABILITY['recurring']).toBe('not_in_this_version');
    expect(BUCKET_AVAILABILITY['rejected']).toBe('not_in_this_version');
    for (const b of ['to_do', 'in_progress', 'held', 'completed', 'failed', 'cancelled'] as const) {
      expect(BUCKET_AVAILABILITY[b]).toBe('available');
    }
  });

  test('availability is one of exactly two values — a typo would otherwise render as an unknown label', () => {
    // `toBeDefined()` here would be vacuous: the Record type already makes a missing key a compile error. What a
    // runtime test can still catch is a WRONG value.
    for (const b of TASK_BOARD_BUCKETS) expect(['available', 'not_in_this_version']).toContain(BUCKET_AVAILABILITY[b]);
    expect(Object.keys(BUCKET_AVAILABILITY)).toHaveLength(TASK_BOARD_BUCKETS.length);
  });
});

describe('placeOnBoard — the projection is TOTAL and closed (CDR-042 §3-G5)', () => {
  test('EVERY internal state is placed; none is silently dropped from the board', () => {
    // A task that vanished from every bucket would be worse than one in the wrong bucket: it would be invisible.
    for (const state of TASK_STATES) {
      const placed = placeOnBoard(state);
      expect(placed.kind === 'bucket' || placed.kind === 'off_board').toBe(true);
    }
  });

  test('draft is OFF the board, with the reason stated — it is the planning preview, not accepted work', () => {
    // Already ratified: CDR-033 §4 and CDR-040 §2. `planTask` (draft -> planned) is what puts work on the board.
    expect(placeOnBoard('draft')).toEqual({ kind: 'off_board', reason: 'draft' });
  });

  test('To Do holds the states the reference product called "queued task"', () => {
    for (const s of ['planned', 'queued'] as const) {
      expect(placeOnBoard(s)).toEqual({ kind: 'bucket', bucket: 'to_do' });
    }
  });

  test('HELD is its own bucket — a stalled task must never read as progressing (CDR-042 §3-G4)', () => {
    for (const s of ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'] as const) {
      expect(placeOnBoard(s)).toEqual({ kind: 'bucket', bucket: 'held' });
    }
    // Only genuinely running work is In Progress.
    expect(placeOnBoard('running')).toEqual({ kind: 'bucket', bucket: 'in_progress' });
  });

  test('the terminal states land in their own buckets, never merged', () => {
    expect(placeOnBoard('completed')).toEqual({ kind: 'bucket', bucket: 'completed' });
    expect(placeOnBoard('failed')).toEqual({ kind: 'bucket', bucket: 'failed' });
    expect(placeOnBoard('cancelled')).toEqual({ kind: 'bucket', bucket: 'cancelled' });
    // Cancelled is NOT failed: one is the owner's choice, the other is the platform falling over.
    expect(placeOnBoard('cancelled')).not.toEqual(placeOnBoard('failed'));
  });

  test('nothing maps into the unavailable buckets — they are empty BY CONSTRUCTION, not by chance', () => {
    const placedBuckets = TASK_STATES.map(placeOnBoard)
      .filter((p): p is { kind: 'bucket'; bucket: TaskBoardBucket } => p.kind === 'bucket')
      .map((p) => p.bucket);
    expect(placedBuckets).not.toContain('recurring');
    expect(placedBuckets).not.toContain('rejected');
  });

  test('an UNRECOGNIZED state renders as unknown — never folded into a healthy bucket', () => {
    // The `toTaskDisplayPhase` precedent: a value we cannot classify must not be quietly shown as fine.
    for (const bad of ['in_review', '', null, undefined, 42, {}]) {
      expect(placeOnBoard(bad).kind).toBe('unknown');
    }
  });
});

describe('isDependencyBlocked — derived, never stored (CDR-042 §3-G7)', () => {
  test('a task is blocked while any prerequisite has not COMPLETED', () => {
    expect(isDependencyBlocked(['completed', 'completed'])).toBe(false);
    expect(isDependencyBlocked(['completed', 'running'])).toBe(true);
    expect(isDependencyBlocked(['queued'])).toBe(true);
  });

  test('a FAILED or CANCELLED prerequisite still blocks — terminal is not the same as satisfied', () => {
    // The dependency exists because the work was needed. A prerequisite that failed did not deliver it, so treating
    // "terminal" as "done" would silently unblock work whose input never arrived.
    expect(isDependencyBlocked(['failed'])).toBe(true);
    expect(isDependencyBlocked(['cancelled'])).toBe(true);
    expect(TERMINAL_TASK_STATES).toContain('failed');
  });

  test('no prerequisites means not blocked', () => {
    expect(isDependencyBlocked([])).toBe(false);
  });

  test('an unrecognized prerequisite state BLOCKS — fail closed', () => {
    // If we cannot tell whether the input arrived, claiming the task is ready to run is the dishonest direction.
    expect(isDependencyBlocked(['who_knows'])).toBe(true);
  });
});

describe('emptyBoardCounts', () => {
  test('starts every bucket at zero, so a bucket is never absent from the board', () => {
    const counts = emptyBoardCounts();
    for (const b of TASK_BOARD_BUCKETS) expect(counts[b]).toBe(0);
    expect(Object.keys(counts)).toHaveLength(TASK_BOARD_BUCKETS.length);
  });

  test('returns a FRESH object each call — a shared mutable zero map would leak counts between companies', () => {
    const a = emptyBoardCounts();
    a['to_do'] = 5;
    expect(emptyBoardCounts()['to_do']).toBe(0);
  });
});
