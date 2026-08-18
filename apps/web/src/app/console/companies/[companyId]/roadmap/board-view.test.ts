/*
 * ACBP-FE-014 — the task board view mapper.
 *
 * `TaskBoardDTO` IS THE MOST CAREFULLY HONEST CONTRACT IN THIS CODEBASE, and a board screen can undo all of
 * it by rendering eight columns of tasks. Five separate facts have to survive the mapping:
 *
 *   availability      — an empty `recurring` column does NOT mean "no recurring tasks". That bucket is
 *                       `not_in_this_version`: nothing was built to fill it. Two empty columns, two meanings.
 *   draftsOffBoard    — drafts are deliberately held OFF the board. An owner who generated a plan and sees an
 *                       empty board deserves to know they exist rather than concluding planning failed.
 *   unplaceable       — "should always be 0; surfaced so that if it is ever non-zero the board says so
 *                       instead of quietly showing fewer tasks than the page contained."
 *   truncated         — the board is a PAGE, not the whole set.
 *   counts            — a per-bucket total that can disagree with the rows actually sent.
 *
 * Anything this mapper drops is a fact the server went out of its way to state.
 */
import { describe, expect, it } from 'vitest';
import { TASK_BOARD_BUCKETS, emptyBoardCounts } from '@acbp/contracts';
import type { BoardBucketDTO, BoardTaskDTO, TaskBoardDTO, TaskDTO } from '@acbp/contracts';
import { toBoardView } from './board-view';

function task(over: Partial<TaskDTO> = {}): TaskDTO {
  return {
    taskId: 't-1',
    companyId: 'co-1',
    state: 'to_do',
    phase: 'not_started',
    title: 'Draft the pilot offer',
    description: null,
    milestoneId: null,
    taskType: 'research',
    priority: 0,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
    ...over,
  } as TaskDTO;
}

function boardTask(over: Partial<BoardTaskDTO> = {}): BoardTaskDTO {
  return { task: task(), dependsOnTaskIds: [], blocksTaskIds: [], dependencyBlocked: false, ...over };
}

function buckets(filled: Partial<Record<string, BoardTaskDTO[]>> = {}): readonly BoardBucketDTO[] {
  return TASK_BOARD_BUCKETS.map((bucket) => ({
    bucket,
    availability: bucket === 'recurring' || bucket === 'rejected' ? ('not_in_this_version' as const) : ('available' as const),
    tasks: filled[bucket] ?? [],
  }));
}

function board(over: Partial<TaskBoardDTO> = {}): TaskBoardDTO {
  return { buckets: buckets(), counts: emptyBoardCounts(), draftsOffBoard: 0, unplaceable: 0, truncated: false, ...over };
}

describe('an empty available bucket and an empty unavailable bucket are different things', () => {
  it('an available bucket with no tasks reads as genuinely empty', () => {
    const view = toBoardView(board());
    const toDo = view.buckets.find((b) => b.bucket === 'to_do');
    expect(toDo?.tone).toBe('empty');
  });

  it('an unavailable bucket is NOT reported as empty', () => {
    // "not_in_this_version" means nothing was built to fill it. Calling that empty tells a founder the
    // platform looked and found nothing, which is an answer the server never gave.
    const view = toBoardView(board());
    const recurring = view.buckets.find((b) => b.bucket === 'recurring');
    expect(recurring?.tone).toBe('unavailable');
    expect(recurring?.note.toLowerCase()).not.toContain('no tasks');
  });

  it('every bucket the contract defines is rendered, including the unavailable ones', () => {
    // "Every bucket, always — including the unavailable ones, which state why they are empty."
    expect(toBoardView(board()).buckets.map((b) => b.bucket)).toEqual([...TASK_BOARD_BUCKETS]);
  });

  it('an unavailable bucket carries no count, rather than a zero', () => {
    const counts = { ...emptyBoardCounts(), recurring: 0 };
    const view = toBoardView(board({ counts }));
    expect(view.buckets.find((b) => b.bucket === 'recurring')?.countLabel).toBe('—');
  });
});

describe('drafts held off the board are counted, not hidden', () => {
  it('reports drafts when the board is otherwise empty', () => {
    const view = toBoardView(board({ draftsOffBoard: 7 }));
    expect(view.draftsOffBoard).toBe(7);
    expect(view.isEmpty).toBe(true);
    expect(view.emptyNote.toLowerCase()).toContain('draft');
  });

  it('an empty board with NO drafts rules drafts OUT rather than implying any exist', () => {
    /*
     * The requirement is not "never say the word draft" — an earlier version of this test asserted that and
     * was pinning phrasing rather than behaviour. An empty board has exactly two explanations, and the
     * useful copy is the one that eliminates the other: a founder who sees nothing needs to know whether
     * work is waiting as a draft or whether there is genuinely none. So the note must not claim any exist.
     */
    const view = toBoardView(board({ draftsOffBoard: 0 }));
    expect(view.isEmpty).toBe(true);
    expect(view.emptyNote.toLowerCase()).toContain('no drafts');
    expect(view.emptyNote).not.toMatch(/\b[1-9]\d*\s+(planned\s+)?tasks?\b/);
  });

  it('a board with tasks is not empty', () => {
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask()] }) }));
    expect(view.isEmpty).toBe(false);
  });
});

describe('unplaceable rows are surfaced because they mean the board is incomplete', () => {
  it('flags a non-zero unplaceable count', () => {
    const view = toBoardView(board({ unplaceable: 2 }));
    expect(view.unplaceable).toBe(2);
    expect(view.integrityWarning).not.toBeNull();
    expect(view.integrityWarning?.toLowerCase()).toContain('fewer');
  });

  it('says nothing when unplaceable is zero, which is the normal case', () => {
    expect(toBoardView(board({ unplaceable: 0 })).integrityWarning).toBeNull();
  });
});

describe('truncation means the board is a page', () => {
  it('is surfaced', () => {
    expect(toBoardView(board({ truncated: true })).truncated).toBe(true);
  });
});

describe('a count that disagrees with the rows sent is reported, not silently preferred', () => {
  it('flags a bucket whose count exceeds the tasks it carries', () => {
    const counts = { ...emptyBoardCounts(), to_do: 5 };
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask()] }), counts }));
    const toDo = view.buckets.find((b) => b.bucket === 'to_do');
    expect(toDo?.count).toBe(5);
    expect(toDo?.shownCount).toBe(1);
    expect(toDo?.countMismatch).toBe(true);
  });

  it('does not flag a bucket where they agree', () => {
    const counts = { ...emptyBoardCounts(), to_do: 1 };
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask()] }), counts }));
    expect(view.buckets.find((b) => b.bucket === 'to_do')?.countMismatch).toBe(false);
  });
});

describe('a blocked task says what is blocking it, and what it is blocking', () => {
  it('surfaces both directions of the dependency', () => {
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask({ dependsOnTaskIds: ['t-a', 't-b'], blocksTaskIds: ['t-c'], dependencyBlocked: true })] }) }));
    const row = view.buckets.find((b) => b.bucket === 'to_do')?.tasks[0];
    expect(row?.dependencyBlocked).toBe(true);
    expect(row?.dependsOnCount).toBe(2);
    expect(row?.blocksCount).toBe(1);
  });

  it('a task blocking others says so even when it is not itself blocked', () => {
    // The DTO comment: dependents are "surfaced so an owner can see the cost of a stuck task."
    const view = toBoardView(board({ buckets: buckets({ in_progress: [boardTask({ blocksTaskIds: ['t-c', 't-d'], dependencyBlocked: false })] }) }));
    const row = view.buckets.find((b) => b.bucket === 'in_progress')?.tasks[0];
    expect(row?.blocksCount).toBe(2);
    expect(row?.dependencyBlocked).toBe(false);
  });
});

describe('priority is a RANK, not a score', () => {
  it('renders rank 0 as first rather than as a zero score', () => {
    // The contract says: "The planning RANK (0 = first) ... Not a scale." Rendering it raw would show a
    // founder "Priority: 0", which reads as no priority at all — the opposite of what it means.
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask({ task: task({ priority: 0 }) })] }) }));
    const row = view.buckets.find((b) => b.bucket === 'to_do')?.tasks[0];
    expect(row?.rankLabel).toBe('1st in the plan');
  });

  it('says the task was not produced by planning when priority is null', () => {
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask({ task: task({ priority: null }) })] }) }));
    expect(view.buckets.find((b) => b.bucket === 'to_do')?.tasks[0]?.rankLabel).toBeNull();
  });
});

describe('a task type that was never stated is not invented', () => {
  it('marks a null taskType as not stated', () => {
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask({ task: task({ taskType: null }) })] }) }));
    const row = view.buckets.find((b) => b.bucket === 'to_do')?.tasks[0];
    expect(row?.taskTypeLabel).toBe('Not stated');
  });

  it('shows a stated type as given', () => {
    const view = toBoardView(board({ buckets: buckets({ to_do: [boardTask({ task: task({ taskType: 'research' }) })] }) }));
    expect(view.buckets.find((b) => b.bucket === 'to_do')?.tasks[0]?.taskTypeLabel).toBe('research');
  });
});

describe('the total is over AVAILABLE buckets only', () => {
  it('never counts an unavailable bucket toward the board total', () => {
    // Summing a bucket nothing can fill would report a capability the platform does not have.
    const counts = { ...emptyBoardCounts(), to_do: 3, in_progress: 2, recurring: 0 };
    const view = toBoardView(board({ counts }));
    expect(view.totalOnBoard).toBe(5);
  });
});
