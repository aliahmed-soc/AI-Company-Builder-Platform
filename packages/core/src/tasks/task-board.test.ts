// @acbp/core — buildTaskBoard unit tests (ACBP-P4-004; CDR-042; TASK-001 views).
//
// The board's honesty properties are pure functions of the rows and edges, so they are pinned here without a database:
// totality (no task silently vanishes), drafts counted rather than hidden, held kept distinct from in-progress, the
// derived blocked flag, and truncation reported rather than implied away.
import { describe, test, expect } from 'vitest';
import type { TaskRow, TaskDependencyRow } from '@acbp/database';
import { TASK_STATES } from '@acbp/contracts';
import { buildTaskBoard } from './task-board.js';

const row = (id: string, state: string, over: Partial<TaskRow> = {}): TaskRow => ({
  id,
  account_id: 'acc',
  company_id: 'co',
  state,
  title: `task ${id}`,
  description: null,
  milestone_id: null,
  task_type: null,
  priority: null,
  rationale: null,
  created_by_user_id: 'u',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

const edge = (taskId: string, dependsOn: string): TaskDependencyRow => ({ id: `${taskId}->${dependsOn}`, account_id: 'acc', company_id: 'co', task_id: taskId, depends_on_task_id: dependsOn, created_at: new Date() });

const bucketOf = (board: ReturnType<typeof buildTaskBoard>, name: string) => board.buckets.find((b) => b.bucket === name)!;

describe('buildTaskBoard — totality (CDR-042 §3-G5)', () => {
  test('EVERY internal state is accounted for: on the board, counted as a draft, or counted as unplaceable', () => {
    // A task present in the company but absent from every bucket AND every count would be invisible — the one
    // outcome worse than being in the wrong bucket.
    const rows = TASK_STATES.map((s, i) => row(`t${i}`, s));
    const board = buildTaskBoard(rows, [], false);
    const placed = board.buckets.reduce((n, b) => n + b.tasks.length, 0);
    expect(placed + board.draftsOffBoard + board.unplaceable).toBe(rows.length);
    expect(board.unplaceable).toBe(0);
  });

  test('an UNRECOGNIZED state is counted as unplaceable, not dropped', () => {
    const board = buildTaskBoard([row('a', 'planned'), row('b', 'teleporting')], [], false);
    expect(board.unplaceable).toBe(1);
    expect(board.buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(1);
  });

  test('every bucket is present even when empty, and the unavailable ones say so', () => {
    const board = buildTaskBoard([], [], false);
    expect(board.buckets).toHaveLength(8);
    expect(bucketOf(board, 'recurring').availability).toBe('not_in_this_version');
    expect(bucketOf(board, 'rejected').availability).toBe('not_in_this_version');
    expect(bucketOf(board, 'to_do').availability).toBe('available');
  });
});

describe('buildTaskBoard — placement', () => {
  test('drafts are OFF the board but COUNTED — an owner who just generated a plan is told they exist', () => {
    const board = buildTaskBoard([row('d1', 'draft'), row('d2', 'draft'), row('p', 'planned')], [], false);
    expect(board.draftsOffBoard).toBe(2);
    expect(bucketOf(board, 'to_do').tasks.map((t) => t.task.taskId)).toEqual(['p']);
    // No bucket contains a draft.
    expect(board.buckets.every((b) => b.tasks.every((t) => t.task.state !== 'draft'))).toBe(true);
  });

  test('held work is NOT counted as in progress', () => {
    const board = buildTaskBoard([row('r', 'running'), row('w', 'waiting_for_approval'), row('b', 'blocked_by_policy')], [], false);
    expect(board.counts['in_progress']).toBe(1);
    expect(board.counts['held']).toBe(2);
    expect(bucketOf(board, 'in_progress').tasks.map((t) => t.task.taskId)).toEqual(['r']);
  });

  test('counts agree with the bucket contents — a summary that disagreed with the detail would be worthless', () => {
    const board = buildTaskBoard([row('a', 'planned'), row('b', 'queued'), row('c', 'completed'), row('d', 'draft')], [], false);
    for (const b of board.buckets) expect(board.counts[b.bucket]).toBe(b.tasks.length);
    expect(board.counts['to_do']).toBe(2);
  });
});

describe('buildTaskBoard — dependencies (CDR-042 §3-G6/G7)', () => {
  test('both directions are surfaced: what a task waits on, and what waits on it', () => {
    // The cost of a stuck task is the set of tasks behind it, which the prerequisite direction alone cannot show.
    const board = buildTaskBoard([row('a', 'running'), row('b', 'planned')], [edge('b', 'a')], false);
    const a = bucketOf(board, 'in_progress').tasks[0]!;
    const b = bucketOf(board, 'to_do').tasks[0]!;
    expect(b.dependsOnTaskIds).toEqual(['a']);
    expect(a.blocksTaskIds).toEqual(['b']);
    expect(a.dependsOnTaskIds).toEqual([]);
  });

  test('a task is blocked until its prerequisite COMPLETES', () => {
    const running = buildTaskBoard([row('a', 'running'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(running, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
    const done = buildTaskBoard([row('a', 'completed'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(done, 'to_do').tasks[0]!.dependencyBlocked).toBe(false);
  });

  test('a FAILED prerequisite still blocks — terminal is not the same as delivered', () => {
    const board = buildTaskBoard([row('a', 'failed'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(board, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
  });

  test('a prerequisite OUTSIDE the page blocks — never assumed complete because it was not fetched', () => {
    // Fail closed: claiming a task is ready because we did not look at its prerequisite is the dishonest direction.
    const board = buildTaskBoard([row('b', 'planned')], [edge('b', 'off-page')], false);
    const b = bucketOf(board, 'to_do').tasks[0]!;
    expect(b.dependsOnTaskIds).toEqual(['off-page']);
    expect(b.dependencyBlocked).toBe(true);
  });

  test('a task with several prerequisites is blocked while ANY is outstanding', () => {
    const board = buildTaskBoard([row('a', 'completed'), row('b', 'running'), row('c', 'planned')], [edge('c', 'a'), edge('c', 'b')], false);
    const c = bucketOf(board, 'to_do').tasks[0]!;
    expect([...c.dependsOnTaskIds].sort()).toEqual(['a', 'b']);
    expect(c.dependencyBlocked).toBe(true);
  });

  test('edges never invent tasks: an edge whose dependent is off-page adds no board entry', () => {
    const board = buildTaskBoard([row('a', 'running')], [edge('off-page', 'a')], false);
    expect(board.buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(1);
    expect(bucketOf(board, 'in_progress').tasks[0]!.blocksTaskIds).toEqual(['off-page']);
  });
});

describe('buildTaskBoard — truncation', () => {
  test('truncation is reported, so the board never implies it showed everything', () => {
    expect(buildTaskBoard([row('a', 'planned')], [], true).truncated).toBe(true);
    expect(buildTaskBoard([row('a', 'planned')], [], false).truncated).toBe(false);
  });
});
