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

/** Thin wrapper so each test states only what it cares about. `rows` are BOARD rows — drafts are excluded upstream. */
const build = (rows: readonly TaskRow[], edges: readonly TaskDependencyRow[], truncated = false, over: { draftsOffBoard?: number; offPageStates?: ReadonlyMap<string, string> } = {}) =>
  buildTaskBoard({ rows, edges, truncated, draftsOffBoard: over.draftsOffBoard ?? 0, offPageStates: over.offPageStates ?? new Map<string, string>() });

const bucketOf = (board: ReturnType<typeof build>, name: string) => board.buckets.find((b) => b.bucket === name)!;

describe('buildTaskBoard — totality (CDR-042 §3-G5)', () => {
  test('EVERY page row is accounted for: in a bucket, or counted as unplaceable — never silently dropped', () => {
    // A task present in the page but absent from every bucket AND every count would be invisible — the one outcome
    // worse than being in the wrong bucket. `draft` is filtered upstream, so it is counted here as unplaceable if it
    // ever reaches this function: a query change must not be able to make a task disappear.
    const rows = TASK_STATES.map((s, i) => row(`t${i}`, s));
    const board = build(rows, []);
    const placed = board.buckets.reduce((n, b) => n + b.tasks.length, 0);
    expect(placed + board.unplaceable).toBe(rows.length);
    // Exactly one TASK_STATES member (`draft`) is not a board state.
    expect(board.unplaceable).toBe(1);
  });

  test('the draft count comes from its OWN query, not from the page — the page budget is spent on board work', () => {
    // Regression guard for the pagination hazard: a planning run minting a page-worth of drafts must not be able to
    // push real board work out of view. Drafts never consume page budget, and their count still reaches the owner.
    const board = build([row('p', 'planned')], [], false, { draftsOffBoard: 200 });
    expect(board.draftsOffBoard).toBe(200);
    expect(bucketOf(board, 'to_do').tasks.map((t) => t.task.taskId)).toEqual(['p']);
  });

  test('an UNRECOGNIZED state is counted as unplaceable, not dropped', () => {
    const board = build([row('a', 'planned'), row('b', 'teleporting')], [], false);
    expect(board.unplaceable).toBe(1);
    expect(board.buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(1);
  });

  test('every bucket is present even when empty, and the unavailable ones say so', () => {
    const board = build([], [], false);
    expect(board.buckets).toHaveLength(8);
    expect(bucketOf(board, 'recurring').availability).toBe('not_in_this_version');
    expect(bucketOf(board, 'rejected').availability).toBe('not_in_this_version');
    expect(bucketOf(board, 'to_do').availability).toBe('available');
  });
});

describe('buildTaskBoard — placement', () => {
  test('a draft that somehow reaches the page enters NO bucket', () => {
    const board = build([row('d1', 'draft'), row('p', 'planned')], []);
    expect(board.buckets.every((b) => b.tasks.every((t) => t.task.state !== 'draft'))).toBe(true);
    expect(board.unplaceable).toBe(1);
  });

  test('held work is NOT counted as in progress', () => {
    const board = build([row('r', 'running'), row('w', 'waiting_for_approval'), row('b', 'blocked_by_policy')], [], false);
    expect(board.counts['in_progress']).toBe(1);
    expect(board.counts['held']).toBe(2);
    expect(bucketOf(board, 'in_progress').tasks.map((t) => t.task.taskId)).toEqual(['r']);
  });

  test('counts agree with the bucket contents — a summary that disagreed with the detail would be worthless', () => {
    const board = build([row('a', 'planned'), row('b', 'queued'), row('c', 'completed')], []);
    for (const b of board.buckets) expect(board.counts[b.bucket]).toBe(b.tasks.length);
    expect(board.counts['to_do']).toBe(2);
  });
});

describe('buildTaskBoard — dependencies (CDR-042 §3-G6/G7)', () => {
  test('both directions are surfaced: what a task waits on, and what waits on it', () => {
    // The cost of a stuck task is the set of tasks behind it, which the prerequisite direction alone cannot show.
    const board = build([row('a', 'running'), row('b', 'planned')], [edge('b', 'a')], false);
    const a = bucketOf(board, 'in_progress').tasks[0]!;
    const b = bucketOf(board, 'to_do').tasks[0]!;
    expect(b.dependsOnTaskIds).toEqual(['a']);
    expect(a.blocksTaskIds).toEqual(['b']);
    expect(a.dependsOnTaskIds).toEqual([]);
  });

  test('a task is blocked until its prerequisite COMPLETES', () => {
    const running = build([row('a', 'running'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(running, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
    const done = build([row('a', 'completed'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(done, 'to_do').tasks[0]!.dependencyBlocked).toBe(false);
  });

  test('a FAILED prerequisite still blocks — terminal is not the same as delivered', () => {
    const board = build([row('a', 'failed'), row('b', 'planned')], [edge('b', 'a')], false);
    expect(bucketOf(board, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
  });

  test('an off-page prerequisite is RESOLVED, so a truncated board does not report everything as blocked', () => {
    // The page is newest-first, so prerequisites are by construction older and are the first rows dropped. Failing
    // closed on every one of them is safe but wrong so often that the indicator stops meaning anything.
    const done = build([row('b', 'planned')], [edge('b', 'older')], true, { offPageStates: new Map([['older', 'completed']]) });
    expect(bucketOf(done, 'to_do').tasks[0]!.dependencyBlocked).toBe(false);
    const running = build([row('b', 'planned')], [edge('b', 'older')], true, { offPageStates: new Map([['older', 'running']]) });
    expect(bucketOf(running, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
  });

  test('a prerequisite whose state cannot be found at all still BLOCKS — fail closed', () => {
    // Resolution is best-effort; when it genuinely fails, claiming the task is ready is the dishonest direction.
    const board = build([row('b', 'planned')], [edge('b', 'vanished')], false, { offPageStates: new Map([['vanished', 'queued']]) });
    expect(bucketOf(board, 'to_do').tasks[0]!.dependencyBlocked).toBe(true);
  });

  test('DRAFT endpoints are dropped from both edge directions — a draft never reaches the board sideways', () => {
    // CDR-042 §3-G1 keeps drafts off the board; surfacing `blocksTaskIds: ['<draft>']` would put unconfirmed
    // planning-preview work back on it, and would inflate the "cost of a stuck task" signal.
    const board = build([row('a', 'running'), row('b', 'planned')], [edge('draft-1', 'a'), edge('b', 'draft-2')], false, {
      offPageStates: new Map([
        ['draft-1', 'draft'],
        ['draft-2', 'draft'],
      ]),
    });
    expect(bucketOf(board, 'in_progress').tasks[0]!.blocksTaskIds).toEqual([]);
    const b = bucketOf(board, 'to_do').tasks[0]!;
    expect(b.dependsOnTaskIds).toEqual([]);
    // With its only prerequisite dropped, the task is genuinely unblocked — not blocked by an invisible draft.
    expect(b.dependencyBlocked).toBe(false);
  });

  test('a task with several prerequisites is blocked while ANY is outstanding', () => {
    const board = build([row('a', 'completed'), row('b', 'running'), row('c', 'planned')], [edge('c', 'a'), edge('c', 'b')], false);
    const c = bucketOf(board, 'to_do').tasks[0]!;
    expect([...c.dependsOnTaskIds].sort()).toEqual(['a', 'b']);
    expect(c.dependencyBlocked).toBe(true);
  });

  test('edges never invent tasks: an edge whose dependent is off-page adds no board entry', () => {
    const board = build([row('a', 'running')], [edge('off-page', 'a')], false, { offPageStates: new Map([['off-page', 'planned']]) });
    expect(board.buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(1);
    expect(bucketOf(board, 'in_progress').tasks[0]!.blocksTaskIds).toEqual(['off-page']);
  });

  test('ONE task blocking SEVERAL dependents accumulates them all — last-writer-wins would be invisible otherwise', () => {
    const board = build([row('a', 'running'), row('b', 'planned'), row('c', 'planned')], [edge('b', 'a'), edge('c', 'a')]);
    expect([...bucketOf(board, 'in_progress').tasks[0]!.blocksTaskIds].sort()).toEqual(['b', 'c']);
    // And the two index maps never share an array.
    expect(bucketOf(board, 'to_do').tasks.every((t) => t.dependsOnTaskIds.length === 1)).toBe(true);
  });
});

describe('buildTaskBoard — truncation', () => {
  test('truncation is reported, so the board never implies it showed everything', () => {
    expect(build([row('a', 'planned')], [], true).truncated).toBe(true);
    expect(build([row('a', 'planned')], [], false).truncated).toBe(false);
  });
});
