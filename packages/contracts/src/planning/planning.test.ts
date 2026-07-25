// @acbp/contracts — planning contract tests (ACBP-P4-001; CDR-039; ROAD-001/002). Adversarial: the parse is
// deny-by-default (a malformed member rejects the WHOLE plan rather than being silently dropped), the `partial` flag
// can only come from the model deliberately setting it, and a milestone can never dangle off a missing goal.
import { describe, test, expect } from 'vitest';
import {
  parseRoadmapOutput,
  narrowRoadmapOutput,
  normalizeEditReason,
  isRoadmapStatus,
  isRoadmapOrigin,
  ROADMAP_STATUSES,
  ROADMAP_ORIGINS,
  GOAL_STATUSES,
  MILESTONE_STATUSES,
  PLAN_TITLE_MAX,
  PLAN_DESCRIPTION_MAX,
  EDIT_REASON_MAX,
  PLAN_ITEMS_MAX,
} from './planning.js';

const plan = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    goals: [{ title: 'Reach first paying customer', description: 'Validate willingness to pay.' }],
    milestones: [{ title: 'Ship the landing page', description: null, goal_ordinal: 0 }],
    ...over,
  });

describe('closed value sets (ACBP-P4-001/CDR-039)', () => {
  test('the status/origin sets are exactly the canon values', () => {
    expect(ROADMAP_STATUSES).toEqual(['complete', 'partial']);
    expect(ROADMAP_ORIGINS).toEqual(['generated', 'edited']);
    expect(GOAL_STATUSES).toEqual(['active', 'achieved', 'dropped']);
    expect(MILESTONE_STATUSES).toEqual(['planned', 'reached', 'dropped']);
    expect(isRoadmapStatus('partial')).toBe(true);
    expect(isRoadmapStatus('done')).toBe(false);
    expect(isRoadmapOrigin('edited')).toBe(true);
    expect(isRoadmapOrigin('model')).toBe(false);
  });
});

describe('parseRoadmapOutput — deny-by-default (ROAD-001)', () => {
  test('a well-formed plan parses, trimming titles and normalizing a blank description to null', () => {
    const r = parseRoadmapOutput(plan({ goals: [{ title: '  Reach revenue  ', description: '   ' }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.goals[0]).toEqual({ title: 'Reach revenue', description: null });
    expect(r.value.milestones[0]?.goalOrdinal).toBe(0);
    expect(r.value.partial).toBe(false);
  });

  test('the `partial` flag is honest labeling: absent → complete, true → partial, non-boolean → REJECT (never coerced)', () => {
    expect(parseRoadmapOutput(plan()).ok && parseRoadmapOutput(plan()).ok).toBe(true);
    const complete = parseRoadmapOutput(plan());
    expect(complete.ok && complete.value.partial).toBe(false);
    const partial = parseRoadmapOutput(plan({ partial: true }));
    expect(partial.ok && partial.value.partial).toBe(true);
    // A truthy non-boolean must NOT be coerced into an honest partial label.
    expect(parseRoadmapOutput(plan({ partial: 'yes' })).ok).toBe(false);
    expect(parseRoadmapOutput(plan({ partial: 1 })).ok).toBe(false);
  });

  test('a milestone can never dangle: goal_ordinal must reference a goal present in THIS payload', () => {
    expect(parseRoadmapOutput(plan({ milestones: [{ title: 'M', description: null, goal_ordinal: 5 }] })).ok).toBe(false);
    expect(parseRoadmapOutput(plan({ milestones: [{ title: 'M', description: null, goal_ordinal: -1 }] })).ok).toBe(false);
    expect(parseRoadmapOutput(plan({ milestones: [{ title: 'M', description: null, goal_ordinal: 1.5 }] })).ok).toBe(false);
    // Unlinked is legal (CDR-039 §7-G5 — the goal↔milestone edge is optional).
    const r = parseRoadmapOutput(plan({ milestones: [{ title: 'M', description: null }] }));
    expect(r.ok && r.value.milestones[0]?.goalOrdinal).toBeNull();
  });

  test('ONE malformed member rejects the WHOLE plan — a half-understood plan is never presented as a plan', () => {
    const twoGoals = (second: unknown) => plan({ goals: [{ title: 'Good', description: null }, second] });
    expect(parseRoadmapOutput(twoGoals({ title: '   ' })).ok).toBe(false); // blank title
    expect(parseRoadmapOutput(twoGoals({ title: 'x'.repeat(PLAN_TITLE_MAX + 1) })).ok).toBe(false); // over-long title
    expect(parseRoadmapOutput(twoGoals({ title: 'T', description: 'x'.repeat(PLAN_DESCRIPTION_MAX + 1) })).ok).toBe(false);
    expect(parseRoadmapOutput(twoGoals({ description: 'no title' })).ok).toBe(false);
    expect(parseRoadmapOutput(twoGoals(null)).ok).toBe(false);
    expect(parseRoadmapOutput(twoGoals('a string')).ok).toBe(false);
  });

  test('structurally unusable payloads are rejected', () => {
    expect(parseRoadmapOutput('not json').ok).toBe(false);
    expect(parseRoadmapOutput('[]').ok).toBe(false);
    expect(parseRoadmapOutput('null').ok).toBe(false);
    // Empty is never an honest partial — refused even WITH the partial label (so it cannot pass for the wrong reason).
    expect(parseRoadmapOutput(JSON.stringify({ goals: [], milestones: [] })).ok).toBe(false);
    expect(parseRoadmapOutput(JSON.stringify({ goals: [], milestones: [], partial: true })).ok).toBe(false);
    expect(parseRoadmapOutput(JSON.stringify({ goals: [{ title: 'g', description: null }] })).ok).toBe(false); // no milestones key
    const tooMany = Array.from({ length: PLAN_ITEMS_MAX + 1 }, (_, i) => ({ title: `g${i}`, description: null }));
    expect(parseRoadmapOutput(plan({ goals: tooMany })).ok).toBe(false);
  });

  test('a one-sided plan is legal ONLY when honestly labeled partial — never as `complete`', () => {
    // ROAD-001 acceptance is a roadmap containing goals AND sequenced milestones, so a one-sided plan cannot be
    // complete. It IS a legitimate honest partial.
    expect(parseRoadmapOutput(JSON.stringify({ goals: [{ title: 'g', description: null }], milestones: [], partial: true })).ok).toBe(true);
    expect(parseRoadmapOutput(JSON.stringify({ goals: [], milestones: [{ title: 'm', description: null }], partial: true })).ok).toBe(true);
    // The same shapes WITHOUT the partial label are refused — otherwise a milestone-less plan would persist as complete.
    expect(parseRoadmapOutput(JSON.stringify({ goals: [{ title: 'g', description: null }], milestones: [], partial: false })).ok).toBe(false);
    expect(parseRoadmapOutput(JSON.stringify({ goals: [{ title: 'g', description: null }], milestones: [] })).ok).toBe(false);
    expect(parseRoadmapOutput(JSON.stringify({ goals: [], milestones: [{ title: 'm', description: null }] })).ok).toBe(false);
  });
});

describe('narrowRoadmapOutput — defensive re-entry of the gateway-validated value', () => {
  test('a validated value round-trips; a corrupted seam value yields undefined', () => {
    const parsed = parseRoadmapOutput(plan());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(narrowRoadmapOutput(parsed.value)).toEqual(parsed.value);
    for (const bad of [undefined, null, 'str', 42, {}, { goals: [], milestones: [] }, { goals: 'x', milestones: [], partial: false }]) {
      expect(narrowRoadmapOutput(bad)).toBeUndefined();
    }
    // A milestone whose goalOrdinal no longer resolves is a corrupted seam value, not a usable plan.
    expect(narrowRoadmapOutput({ goals: [], milestones: [{ title: 'm', description: null, goalOrdinal: 0 }], partial: false })).toBeUndefined();
  });

  test('narrow re-applies the PERSISTABILITY invariants, not just types — the gateway validator is injected', () => {
    // A caller wiring a different (or missing) validator must not be able to slip past the honesty rules the parser
    // enforces. These all typecheck as a "RoadmapOutput" but are not persistable plans.
    const goal = { title: 'g', description: null };
    const milestone = { title: 'm', description: null, goalOrdinal: null };
    expect(narrowRoadmapOutput({ goals: [], milestones: [], partial: false })).toBeUndefined(); // empty
    expect(narrowRoadmapOutput({ goals: [], milestones: [], partial: true })).toBeUndefined(); // empty ≠ partial
    expect(narrowRoadmapOutput({ goals: [goal], milestones: [], partial: false })).toBeUndefined(); // one-sided + complete
    expect(narrowRoadmapOutput({ goals: [goal], milestones: [], partial: true })).toBeDefined(); // one-sided + honest
    // Bounds the DB would otherwise be the first to reject (surfacing a raw constraint error, not generation_failed).
    expect(narrowRoadmapOutput({ goals: [{ title: 'x'.repeat(PLAN_TITLE_MAX + 1), description: null }], milestones: [milestone], partial: false })).toBeUndefined();
    expect(narrowRoadmapOutput({ goals: [{ title: 'g', description: 'x'.repeat(PLAN_DESCRIPTION_MAX + 1) }], milestones: [milestone], partial: false })).toBeUndefined();
    expect(narrowRoadmapOutput({ goals: [{ title: '', description: null }], milestones: [milestone], partial: false })).toBeUndefined();
    const tooMany = Array.from({ length: PLAN_ITEMS_MAX + 1 }, (_, i) => ({ title: `g${i}`, description: null }));
    expect(narrowRoadmapOutput({ goals: tooMany, milestones: [milestone], partial: false })).toBeUndefined();
  });
});

describe('normalizeEditReason — REQUIRED for a ROAD-002 edit', () => {
  test('a usable reason is trimmed; absent/blank/over-long/non-string are undefined (the caller denies)', () => {
    expect(normalizeEditReason('  scope cut after customer calls  ')).toBe('scope cut after customer calls');
    expect(normalizeEditReason('x'.repeat(EDIT_REASON_MAX))).toHaveLength(EDIT_REASON_MAX);
    // Unlike a decision rationale, an edit reason is mandatory — ROAD-002 "record rationale".
    expect(normalizeEditReason(undefined)).toBeUndefined();
    expect(normalizeEditReason(null)).toBeUndefined();
    expect(normalizeEditReason('   ')).toBeUndefined();
    expect(normalizeEditReason('x'.repeat(EDIT_REASON_MAX + 1))).toBeUndefined();
    expect(normalizeEditReason(42)).toBeUndefined();
  });
});
