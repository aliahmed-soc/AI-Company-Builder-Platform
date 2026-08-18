/*
 * ACBP-FE-014 — the roadmap view mapper.
 *
 * A ROADMAP CARRIES SEVEN FACTS A CARELESS SCREEN COLLAPSES INTO "here is your plan": whether it is complete
 * or partial, whether the MODEL separately flagged it partial, whether a human edited it and why, which
 * roadmap it replaced, its version, the decision it was built from, and which milestones belong to which
 * goal. The last one has a trap in it: `MilestoneDTO.goalId` is NULLABLE, so a milestone can belong to no
 * goal at all, and a screen that renders milestones only underneath their goal drops those silently.
 */
import { describe, expect, it } from 'vitest';
import type { GoalDTO, MilestoneDTO, RoadmapDTO } from '@acbp/contracts';
import { toRoadmapView } from './roadmap-view';

function goal(over: Partial<GoalDTO> = {}): GoalDTO {
  return { goalId: 'g-1', ordinal: 0, title: 'Reach ten paying customers', description: null, status: 'active', ...over };
}

function milestone(over: Partial<MilestoneDTO> = {}): MilestoneDTO {
  return { milestoneId: 'm-1', ordinal: 0, goalId: 'g-1', title: 'Ship the pilot', description: null, status: 'planned', ...over };
}

function roadmap(over: Partial<RoadmapDTO> = {}): RoadmapDTO {
  return {
    roadmapId: 'r-1',
    companyId: 'co-1',
    version: 1,
    decisionId: 'dec-1',
    status: 'complete',
    origin: 'generated',
    supersedesRoadmapId: null,
    editReason: null,
    modelFlaggedPartial: false,
    goals: [goal()],
    milestones: [milestone()],
    createdAt: '2026-08-18T10:00:00.000Z',
    ...over,
  };
}

describe('an absent roadmap is a success, not an error', () => {
  it('reports nothing_planned', () => {
    expect(toRoadmapView(null).state).toBe('nothing_planned');
  });

  it('carries no failure vocabulary', () => {
    // The route's own comment: an absent roadmap "is a success carrying null, never a not-found ... Mapping
    // that to 404 is how a UI shows an error page on a normal first visit."
    const text = toRoadmapView(null).headline.toLowerCase();
    for (const word of ['error', 'failed', 'refused', 'denied', 'not found', 'unavailable']) {
      expect(text, `an empty first visit must not read as "${word}"`).not.toContain(word);
    }
  });

  it('has no goals and no unattached milestones', () => {
    const view = toRoadmapView(null);
    expect(view.goals).toEqual([]);
    expect(view.unattachedMilestones).toEqual([]);
  });
});

describe('milestones with no goal are shown, not dropped', () => {
  it('surfaces a null-goalId milestone in its own group', () => {
    const view = toRoadmapView(roadmap({ milestones: [milestone({ milestoneId: 'm-2', goalId: null, title: 'Register the company' })] }));
    expect(view.unattachedMilestones.map((m) => m.milestoneId)).toEqual(['m-2']);
  });

  it('every milestone appears exactly once across the groups', () => {
    // The invariant that makes the grouping safe: nothing is dropped and nothing is double-counted.
    const ms = [milestone({ milestoneId: 'm-1', goalId: 'g-1' }), milestone({ milestoneId: 'm-2', goalId: null }), milestone({ milestoneId: 'm-3', goalId: 'g-2' })];
    const view = toRoadmapView(roadmap({ goals: [goal({ goalId: 'g-1' }), goal({ goalId: 'g-2', ordinal: 1 })], milestones: ms }));
    const placed = [...view.goals.flatMap((g) => g.milestones.map((m) => m.milestoneId)), ...view.unattachedMilestones.map((m) => m.milestoneId)];
    expect(placed.sort()).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('a milestone naming a goal that is not in this roadmap is treated as unattached rather than lost', () => {
    // A dangling reference is a real possibility and dropping it would hide work from the founder.
    const view = toRoadmapView(roadmap({ goals: [goal({ goalId: 'g-1' })], milestones: [milestone({ milestoneId: 'm-9', goalId: 'g-missing' })] }));
    expect(view.unattachedMilestones.map((m) => m.milestoneId)).toEqual(['m-9']);
    expect(view.hasDanglingMilestone).toBe(true);
  });

  it('does not report a dangling milestone when every goalId resolves', () => {
    expect(toRoadmapView(roadmap()).hasDanglingMilestone).toBe(false);
  });
});

describe('ordering comes from the server ordinal, never from array position', () => {
  it('orders goals by ordinal', () => {
    const view = toRoadmapView(roadmap({ goals: [goal({ goalId: 'g-b', ordinal: 1, title: 'B' }), goal({ goalId: 'g-a', ordinal: 0, title: 'A' })], milestones: [] }));
    expect(view.goals.map((g) => g.goalId)).toEqual(['g-a', 'g-b']);
  });

  it('orders milestones within a goal by ordinal', () => {
    const view = toRoadmapView(
      roadmap({
        goals: [goal({ goalId: 'g-1' })],
        milestones: [milestone({ milestoneId: 'm-b', ordinal: 5 }), milestone({ milestoneId: 'm-a', ordinal: 2 })],
      }),
    );
    expect(view.goals[0]?.milestones.map((m) => m.milestoneId)).toEqual(['m-a', 'm-b']);
  });
});

describe('partial is disclosed, and the two partial signals are independent', () => {
  it('a partial roadmap says so', () => {
    expect(toRoadmapView(roadmap({ status: 'partial' })).state).toBe('partial');
  });

  it('modelFlaggedPartial is surfaced even on a complete roadmap', () => {
    // Same shape as the strategy generation: the model reporting on its own output is a separate fact from
    // the server's completeness ruling, and folding them together loses one of them.
    const view = toRoadmapView(roadmap({ status: 'complete', modelFlaggedPartial: true }));
    expect(view.state).toBe('complete');
    expect(view.modelFlaggedPartial).toBe(true);
  });
});

describe('an edited roadmap is not a generated one', () => {
  it('surfaces the edit reason', () => {
    const view = toRoadmapView(roadmap({ origin: 'edited', editReason: 'Dropped the enterprise goal after the pilot feedback.' }));
    expect(view.origin).toBe('edited');
    expect(view.editReason).toBe('Dropped the enterprise goal after the pilot feedback.');
  });

  it('says an edit gave no reason rather than going quiet', () => {
    const view = toRoadmapView(roadmap({ origin: 'edited', editReason: null }));
    expect(view.origin).toBe('edited');
    expect(view.originNote.toLowerCase()).toContain('no reason');
  });

  it('reports that this version replaced an earlier one', () => {
    const view = toRoadmapView(roadmap({ version: 3, supersedesRoadmapId: 'r-0' }));
    expect(view.supersedesEarlier).toBe(true);
    expect(view.version).toBe(3);
  });

  it('does not claim a first version replaced anything', () => {
    expect(toRoadmapView(roadmap({ version: 1, supersedesRoadmapId: null })).supersedesEarlier).toBe(false);
  });
});

describe('goal and milestone statuses are not all "on track"', () => {
  it('a dropped goal is marked dropped', () => {
    const view = toRoadmapView(roadmap({ goals: [goal({ status: 'dropped' })] }));
    expect(view.goals[0]?.status).toBe('dropped');
  });

  it('counts only ACTIVE goals as outstanding, never dropped or achieved ones', () => {
    const view = toRoadmapView(
      roadmap({
        goals: [goal({ goalId: 'g-1', status: 'active' }), goal({ goalId: 'g-2', ordinal: 1, status: 'achieved' }), goal({ goalId: 'g-3', ordinal: 2, status: 'dropped' })],
        milestones: [],
      }),
    );
    expect(view.activeGoalCount).toBe(1);
    expect(view.goals).toHaveLength(3);
  });

  it('counts reached milestones separately from planned ones, and excludes dropped from both', () => {
    const view = toRoadmapView(
      roadmap({
        goals: [goal()],
        milestones: [milestone({ milestoneId: 'm-1', status: 'reached' }), milestone({ milestoneId: 'm-2', ordinal: 1, status: 'planned' }), milestone({ milestoneId: 'm-3', ordinal: 2, status: 'dropped' })],
      }),
    );
    expect(view.reachedMilestoneCount).toBe(1);
    expect(view.plannedMilestoneCount).toBe(1);
    expect(view.droppedMilestoneCount).toBe(1);
  });
});

describe('the decision this roadmap was built from is carried', () => {
  it('surfaces the decision id, because a roadmap is downstream of exactly one decision', () => {
    expect(toRoadmapView(roadmap({ decisionId: 'dec-7' })).decisionId).toBe('dec-7');
  });
});
