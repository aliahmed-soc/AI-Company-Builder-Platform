// @acbp/contracts — task control-availability tests (ACBP-P4-005; CDR-043; TASK-002/TASK-008).
import { describe, test, expect } from 'vitest';
import { TASK_STATES } from './task.js';
import { TASK_CONTROLS, isTaskControl, controlAvailability, availableControls, buildTaskDetail } from './controls.js';

const forState = (state: string) => Object.fromEntries(controlAvailability(state).map((c) => [c.control, c]));

describe('the control set (CDR-043 §2 — exactly what canon defines)', () => {
  test('is exactly repeat and delete — there is NO task reject control', () => {
    // TASK-008 defines repeat + delete. No requirement anywhere defines task REJECTION: the `reject` verb belongs to
    // UNDER-003 (understanding items), STRAT-003 (strategy options) and APPR-007 (approvals) — different objects.
    // The audit recorded task rejection under "Controls not exercised". The backlog Objective's "reject" is shorthand
    // contradicted by its own Acceptance criteria, and building it would invent a control from one word.
    expect(TASK_CONTROLS).toEqual(['repeat', 'delete']);
    expect(isTaskControl('repeat')).toBe(true);
    expect(isTaskControl('reject')).toBe(false);
    expect(isTaskControl('run_now')).toBe(false); // TASK-004 — needs the credit preflight, not this ticket
  });
});

describe('controlAvailability — every control reports a reason when unavailable (TASK-002)', () => {
  test('EVERY state yields a verdict for EVERY control — a control that silently vanishes cannot be explained', () => {
    for (const state of TASK_STATES) {
      const verdicts = controlAvailability(state);
      expect(verdicts.map((v) => v.control)).toEqual([...TASK_CONTROLS]);
      for (const v of verdicts) {
        // Available means no reason; unavailable MUST carry one. A greyed-out button with no explanation is the
        // failure TASK-002's "controls appropriate to its state" exists to prevent.
        if (v.available) expect(v.reason).toBeNull();
        else expect(typeof v.reason).toBe('string');
      }
    }
  });

  test('delete is REFUSED while a task is running, and the reason names the remedy', () => {
    // TASK-008's failure clause is explicit: "Delete of a running task is refused; cancel first."
    const d = forState('running')['delete']!;
    expect(d.available).toBe(false);
    expect(d.reason).toBe('cancel_first');
  });

  test('delete is refused in every HOLD state too — a task awaiting approval is equally mid-flight', () => {
    for (const held of ['waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'] as const) {
      const d = forState(held)['delete']!;
      expect(d.available).toBe(false);
      expect(d.reason).toBe('cancel_first');
    }
  });

  test('delete IS allowed for queued work — it is not yet executing, and TASK-007 owns cancellation', () => {
    for (const s of ['draft', 'planned', 'queued'] as const) expect(forState(s)['delete']!.available).toBe(true);
  });

  test('delete is allowed on terminal tasks — nothing is mid-flight to interrupt', () => {
    for (const s of ['completed', 'failed', 'cancelled'] as const) expect(forState(s)['delete']!.available).toBe(true);
  });

  test('repeat requires a task that has REACHED an outcome — repeating live work would duplicate it', () => {
    // "Re-queued as a new task" is the recovery control the audit observed on a FAILED task. Repeating something
    // still running or still queued would silently create two tasks doing the same work.
    for (const s of ['completed', 'failed', 'cancelled'] as const) {
      expect(forState(s)['repeat']!.available).toBe(true);
    }
    for (const s of ['draft', 'planned', 'queued', 'running', 'waiting_for_approval'] as const) {
      const r = forState(s)['repeat']!;
      expect(r.available).toBe(false);
      expect(r.reason).toBe('not_finished');
    }
  });

  test('an UNRECOGNIZED state offers NOTHING, with a stated reason — never a default-open control', () => {
    // Fail closed: if we cannot tell what the task is doing, offering to delete or repeat it is the unsafe guess.
    for (const bad of ['teleporting', '', null, undefined, 42]) {
      const verdicts = controlAvailability(bad);
      expect(verdicts).toHaveLength(TASK_CONTROLS.length);
      expect(verdicts.every((v) => !v.available && v.reason === 'unknown_state')).toBe(true);
    }
  });
});

describe('availableControls', () => {
  test('returns only the usable ones, for callers that just need the list', () => {
    expect(availableControls('completed')).toEqual(['repeat', 'delete']);
    expect(availableControls('running')).toEqual([]);
    expect(availableControls('planned')).toEqual(['delete']);
  });

  test('is consistent with controlAvailability — the summary can never disagree with the detail', () => {
    for (const state of TASK_STATES) {
      const detailed = controlAvailability(state)
        .filter((v) => v.available)
        .map((v) => v.control);
      expect(availableControls(state)).toEqual(detailed);
    }
  });
});

describe('buildTaskDetail (CDR-043 §4-G7/G8 — TASK-002 detail view)', () => {
  const base = {
    taskId: 't_1',
    companyId: 'co_1',
    state: 'completed' as const,
    phase: 'completed' as const,
    title: 'Interview five prospects',
    description: null,
    milestoneId: null,
    taskType: null,
    priority: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };

  test('MISSING FIELDS STAY MISSING — nothing is defaulted into existence (TASK-002 failure clause)', () => {
    // The whole failure clause is "missing fields render explicitly as missing". A placeholder here would be the
    // difference between "no type was stated" and "the type is general" — the fabrication ADR-019 forbids.
    const d = buildTaskDetail(base, { rationale: null, repeatedFromTaskId: null });
    expect(d.taskType).toBeNull();
    expect(d.description).toBeNull();
    expect(d.milestoneId).toBeNull();
    expect(d.priority).toBeNull();
    expect(d.rationale).toBeNull();
    expect(d.repeatedFromTaskId).toBeNull();
  });

  test('carries the fields TASK-002 names — type, creation time, structured description', () => {
    const d = buildTaskDetail({ ...base, taskType: 'market_research', description: 'Talk to five people.' }, { rationale: 'Fastest way to learn.', repeatedFromTaskId: 't_0' });
    expect(d.taskType).toBe('market_research');
    expect(d.createdAt).toBe('2026-07-01T00:00:00.000Z');
    expect(d.description).toBe('Talk to five people.');
    expect(d.rationale).toBe('Fastest way to learn.');
    expect(d.repeatedFromTaskId).toBe('t_0');
  });

  test('controls are DERIVED from the state on every read, and agree with controlAvailability exactly', () => {
    // Derived, never stored: a stored availability set goes stale the moment the task changes state, which is
    // precisely when the owner is most likely to be looking at it.
    for (const state of TASK_STATES) {
      const d = buildTaskDetail({ ...base, state }, { rationale: null, repeatedFromTaskId: null });
      expect(d.controls).toEqual(controlAvailability(state));
    }
  });

  test('a running task’s detail explains why delete is unavailable rather than omitting the control', () => {
    const d = buildTaskDetail({ ...base, state: 'running' }, { rationale: null, repeatedFromTaskId: null });
    const del = d.controls.find((c) => c.control === 'delete');
    expect(del).toEqual({ control: 'delete', available: false, reason: 'cancel_first' });
    expect(d.controls).toHaveLength(TASK_CONTROLS.length);
  });
});
