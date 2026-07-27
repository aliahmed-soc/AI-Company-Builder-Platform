// ACBP-P5-001b — resume is the DIFFERENCE between the plan and the checkpoint inventory (CDR-050 §2-G3).
//
// Canon says "checkpoint inventory vs plan" (FAILURE-AND-RECOVERY row 12), and this is that sentence made executable.
// The failure being excluded is DOUBLE EXECUTION: a step whose effect already landed running a second time after a
// crash. Every case below is a crash shape that, computed wrongly, would re-run completed work.
import { describe, test, expect } from 'vitest';
import { remainingSteps, planProgress, isPlanComplete } from './resume.js';

const PLAN = ['research', 'draft', 'review', 'publish'] as const;

describe('remainingSteps — what still has to run', () => {
  test('a job with no checkpoints runs the whole plan', () => {
    expect(remainingSteps(PLAN, [])).toEqual(['research', 'draft', 'review', 'publish']);
  });

  test('completed steps are DROPPED, not re-run — the whole point', () => {
    expect(remainingSteps(PLAN, ['research', 'draft'])).toEqual(['review', 'publish']);
  });

  test('a fully checkpointed plan has nothing left', () => {
    expect(remainingSteps(PLAN, ['research', 'draft', 'review', 'publish'])).toEqual([]);
    expect(isPlanComplete(PLAN, ['research', 'draft', 'review', 'publish'])).toBe(true);
  });

  test('plan ORDER is preserved, not checkpoint order — the plan decides what runs next', () => {
    // Checkpoints arrive in completion order, which after a resume need not match the plan. If the remainder took its
    // order from the checkpoints, a resumed job could run its steps in a different sequence than a fresh one.
    expect(remainingSteps(PLAN, ['draft', 'research'])).toEqual(['review', 'publish']);
  });

  test('an OUT-OF-ORDER checkpoint still removes exactly its own step, and nothing before it', () => {
    // A step completed out of plan order (a retry that skipped ahead, a manually repaired job). The earlier step is
    // genuinely NOT done, so it must still run — dropping everything up to the latest checkpoint would silently skip
    // real work, which is the mirror-image failure of double execution.
    expect(remainingSteps(PLAN, ['review'])).toEqual(['research', 'draft', 'publish']);
  });

  test('a checkpoint for a step NOT in the plan is ignored rather than throwing', () => {
    // The plan changed between the crash and the resume (a deploy). The stale checkpoint says something ran that this
    // plan no longer contains — which is true, and harmless. What must not happen is refusing to resume the job at
    // all, stranding work that is otherwise fine.
    expect(remainingSteps(PLAN, ['research', 'obsolete_step'])).toEqual(['draft', 'review', 'publish']);
  });

  test('duplicate checkpoints for one step collapse — the DB unique makes this impossible, so it must not surprise us', () => {
    expect(remainingSteps(PLAN, ['research', 'research'])).toEqual(['draft', 'review', 'publish']);
  });

  test('an empty plan has nothing remaining and is trivially complete', () => {
    expect(remainingSteps([], ['research'])).toEqual([]);
    expect(isPlanComplete([], [])).toBe(true);
  });

  test('a duplicated step name in the PLAN is not silently deduplicated into one run', () => {
    // Two steps cannot share a name: the checkpoint key is (job_id, step_name), so completing the first would mark
    // the second done as well and skip it. Refusing is the honest answer — a plan that cannot be checkpointed is a
    // plan we must not start.
    expect(() => remainingSteps(['a', 'b', 'a'], [])).toThrow();
  });

  test('a blank step name in the plan is refused for the same reason', () => {
    expect(() => remainingSteps(['a', '  '], [])).toThrow();
  });

  test('the inputs are never mutated — a caller may hold the plan across a retry', () => {
    const plan = ['research', 'draft'];
    const done = ['research'];
    remainingSteps(plan, done);
    expect(plan).toEqual(['research', 'draft']);
    expect(done).toEqual(['research']);
  });
});

describe('planProgress — honest reporting of a partial run', () => {
  test('counts completed steps against the plan, ignoring checkpoints outside it', () => {
    expect(planProgress(PLAN, ['research', 'draft', 'obsolete_step'])).toEqual({ completed: 2, total: 4, remaining: 2, complete: false });
  });

  test('a complete plan reports complete', () => {
    expect(planProgress(PLAN, [...PLAN])).toEqual({ completed: 4, total: 4, remaining: 0, complete: true });
  });

  test('an untouched plan reports zero, not complete — "nothing ran" must never read as "all done"', () => {
    expect(planProgress(PLAN, [])).toEqual({ completed: 0, total: 4, remaining: 4, complete: false });
  });
});
