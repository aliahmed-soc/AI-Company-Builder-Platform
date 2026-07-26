// @acbp/core — unit tests for the two pure scope helpers behind ACBP-P4-003's STRAT-005 boundary (CDR-040 §4/§8-G3).
//
// These are exported and load-bearing, but the integration suite only ever exercises them with a handful of short
// milestones — far under the prompt budget and always with contiguous goal ordinals — so neither the truncation branch
// nor the no-goals branch runs there. Both branches are exactly where a regression would be silent and expensive:
// a blind `.slice()` (the MEDIUM-1 bug) would let a task persist traced to a milestone the model never read, and a
// widened phase scope would let planning cross an approval boundary. Pinned here, model-free and database-free.
import { describe, test, expect } from 'vitest';
import type { MilestoneRow, RoadmapRow } from '@acbp/database';
import { formatMilestonesForPlanning, milestonesInPhaseScope } from './task-generation.js';

const roadmap = (over: Partial<RoadmapRow> = {}): RoadmapRow => ({ id: 'r1', version: 1, status: 'complete', ...over }) as RoadmapRow;
const milestone = (id: string, over: Partial<MilestoneRow> = {}): MilestoneRow => ({ id, title: `milestone-${id}`, description: null, goal_id: 'g0', ordinal: 0, ...over }) as MilestoneRow;

describe('formatMilestonesForPlanning — the prompt and the ordinal space are the SAME set', () => {
  test('label i is exactly the index of shown[i], so an ordinal always resolves to the milestone under that label', () => {
    const ms = [milestone('a'), milestone('b'), milestone('c')];
    const { prompt, shown } = formatMilestonesForPlanning(roadmap(), ms);
    expect(shown).toEqual(ms);
    shown.forEach((m, i) => {
      expect(prompt).toContain(`Milestone ${i}: ${m.title}`);
    });
  });

  test('a milestone too large for the remaining budget is excluded from BOTH the prompt and the ordinal space', () => {
    // Whole milestones only — the failure being prevented is a milestone present in `shown` but cut from the text,
    // which would let a task persist, complete and unflagged, traced to something the model never read (ADR-019).
    const big = (id: string) => milestone(id, { description: 'x'.repeat(5_000) });
    const ms = [big('a'), big('b'), big('c'), big('d')];
    const { prompt, shown } = formatMilestonesForPlanning(roadmap(), ms);
    expect(shown.length).toBeLessThan(ms.length);
    for (const m of shown) expect(prompt).toContain(m.title);
    for (const m of ms.slice(shown.length)) expect(prompt).not.toContain(m.title);
    // A PREFIX, never a gappy subset: `break`, not `continue`. A gap would shift every later label by one.
    expect(shown).toEqual(ms.slice(0, shown.length));
  });

  test('the partial roadmap status is carried into the prompt (the model is told what it is planning against)', () => {
    expect(formatMilestonesForPlanning(roadmap({ status: 'partial' }), [milestone('a')]).prompt).toContain('(partial)');
    expect(formatMilestonesForPlanning(roadmap(), [milestone('a')]).prompt).not.toContain('(partial)');
  });
});

describe('milestonesInPhaseScope — STRAT-005', () => {
  const g0 = [milestone('a', { goal_id: 'g0' }), milestone('b', { goal_id: 'g0' })];
  const g1 = [milestone('c', { goal_id: 'g1' }), milestone('d', { goal_id: 'g1' })];

  test('whole_plan (and an unrecorded scope) plan against every milestone', () => {
    expect(milestonesInPhaseScope('whole_plan', [{ id: 'g0', ordinal: 0 }], [...g0, ...g1])).toHaveLength(4);
    expect(milestonesInPhaseScope(null, [{ id: 'g0', ordinal: 0 }], [...g0, ...g1])).toHaveLength(4);
  });

  test('first_phase restricts to the LOWEST-ordinal goal, even when the ordinals do not start at 0', () => {
    // Resolved as a minimum rather than a lookup for `ordinal === 0`: a roadmap whose goal ordinals start at 1 must
    // still resolve to a real first goal instead of falling through to the no-goals branch.
    const goals = [
      { id: 'g1', ordinal: 2 },
      { id: 'g0', ordinal: 1 },
    ];
    expect(milestonesInPhaseScope('first_phase', goals, [...g0, ...g1]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('first_phase is order-independent — the input array order never decides the phase', () => {
    const asc = milestonesInPhaseScope('first_phase', [{ id: 'g0', ordinal: 0 }, { id: 'g1', ordinal: 1 }], [...g0, ...g1]);
    const desc = milestonesInPhaseScope('first_phase', [{ id: 'g1', ordinal: 1 }, { id: 'g0', ordinal: 0 }], [...g0, ...g1]);
    expect(asc.map((m) => m.id)).toEqual(desc.map((m) => m.id));
    expect(asc.map((m) => m.id)).toEqual(['a', 'b']);
  });

  test('with NO goals, first_phase narrows to the single first milestone — never the whole plan', () => {
    // The honest minimum. Widening here would silently let a first-phase-only approval plan the entire roadmap.
    expect(milestonesInPhaseScope('first_phase', [], [...g0, ...g1]).map((m) => m.id)).toEqual(['a']);
    expect(milestonesInPhaseScope('first_phase', [], [])).toEqual([]);
  });

  test('a first_phase goal with no milestones yields an empty scope (the caller fails closed on it)', () => {
    expect(milestonesInPhaseScope('first_phase', [{ id: 'empty', ordinal: 0 }], [...g0, ...g1])).toEqual([]);
  });
});
