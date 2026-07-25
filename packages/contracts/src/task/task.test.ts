// ACBP-P4-002 — unit tests for the task state-machine contract (CDR-033; TASK-001; WORKFLOW §4). The load-bearing
// test is 100% transition-table conformance: every (from,to) pair is checked against the expected map (no extra, no
// missing legal transition).
import { describe, test, expect } from 'vitest';
import { TASK_STATES, isTaskState, INITIAL_TASK_STATE, isLegalTaskTransition, legalTaskSuccessors, isTerminalTaskState, isOpenTaskState, isTaskHold, toTaskDisplayPhase, type TaskState } from './task.js';

// The EXACT expected transition map (WORKFLOW §4). The test asserts the contract matches this, pair-by-pair.
const EXPECTED: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ['planned'],
  planned: ['queued'],
  queued: ['running', 'cancelled'],
  running: ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled'],
  waiting_for_input: ['running'],
  waiting_for_approval: ['running', 'cancelled'],
  blocked_by_policy: ['running'],
  paused: ['running'],
  completed: [],
  failed: [],
  cancelled: [],
};

describe('task state set', () => {
  test('the closed 11-state set is exactly the WORKFLOW §4 states', () => {
    expect([...TASK_STATES]).toEqual(['draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused', 'completed', 'failed', 'cancelled']);
  });
  test('isTaskState is a deny-by-default guard', () => {
    for (const s of TASK_STATES) expect(isTaskState(s)).toBe(true);
    for (const bad of ['DRAFT', 'done', 'pending', '', 42, null, undefined, {}]) expect(isTaskState(bad)).toBe(false);
  });
  test('a task is minted in draft', () => {
    expect(INITIAL_TASK_STATE).toBe('draft');
  });
});

describe('transition-table conformance (TASK-001: 100%)', () => {
  test('every (from,to) pair matches the expected map exactly — no extra, no missing', () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const expected = EXPECTED[from].includes(to);
        expect(isLegalTaskTransition(from, to), `${from} -> ${to} should be ${expected ? 'legal' : 'illegal'}`).toBe(expected);
      }
    }
  });
  test('legalTaskSuccessors returns a defensive copy matching the map', () => {
    for (const from of TASK_STATES) {
      expect([...legalTaskSuccessors(from)].sort()).toEqual([...EXPECTED[from]].sort());
    }
    const copy = legalTaskSuccessors('running');
    (copy as TaskState[]).push('draft');
    expect(legalTaskSuccessors('running')).not.toContain('draft'); // mutation did not leak
  });
  test('an unknown from-state yields no successors and no legal transition', () => {
    expect(isLegalTaskTransition('nope' as TaskState, 'planned')).toBe(false);
    expect(legalTaskSuccessors('nope' as TaskState)).toEqual([]);
  });
});

describe('terminal / open / hold classification', () => {
  test('completed, failed, cancelled are terminal; everything else is open', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      expect(isTerminalTaskState(s)).toBe(true);
      expect(isOpenTaskState(s)).toBe(false);
    }
    for (const s of ['draft', 'planned', 'queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'] as const) {
      expect(isTerminalTaskState(s)).toBe(false);
      expect(isOpenTaskState(s)).toBe(true);
    }
  });
  test('the four holds are holds; core lifecycle states are not', () => {
    for (const s of ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'] as const) expect(isTaskHold(s)).toBe(true);
    for (const s of ['draft', 'planned', 'queued', 'running', 'completed', 'failed', 'cancelled'] as const) expect(isTaskHold(s)).toBe(false);
  });
});

describe('toTaskDisplayPhase (honest projection)', () => {
  test('maps each state; the four holds project to held; unknown → unknown', () => {
    expect(toTaskDisplayPhase('draft')).toBe('draft');
    expect(toTaskDisplayPhase('queued')).toBe('queued');
    expect(toTaskDisplayPhase('running')).toBe('running');
    for (const s of ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused']) expect(toTaskDisplayPhase(s)).toBe('held');
    expect(toTaskDisplayPhase('completed')).toBe('completed');
    expect(toTaskDisplayPhase('failed')).toBe('failed');
    expect(toTaskDisplayPhase('cancelled')).toBe('cancelled');
    expect(toTaskDisplayPhase('garbage')).toBe('unknown');
    expect(toTaskDisplayPhase(undefined)).toBe('unknown');
  });
});
