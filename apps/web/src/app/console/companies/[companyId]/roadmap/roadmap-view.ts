/*
 * ACBP-FE-014 — turning the roadmap read into something a founder can read.
 *
 * AN ABSENT ROADMAP IS A SUCCESS. `LatestRoadmapResult` has two arms and a NULLABLE payload, and the request
 * layer says why in its own words: "An absent roadmap is a success carrying null, never a not-found ...
 * Mapping that to 404 is how a UI shows an error page on a normal first visit." So `null` is the ordinary
 * empty state and its copy carries no failure vocabulary — pinned by a test.
 *
 * `MilestoneDTO.goalId` IS NULLABLE, AND THAT IS THE TRAP IN THIS SHAPE. A screen that renders milestones
 * only underneath their goal silently drops every milestone that belongs to none — and drops a milestone
 * whose `goalId` names a goal that is not in this roadmap, which is worse, because that one looks like data
 * loss to nobody. Both land in `unattachedMilestones`, and a dangling reference additionally raises
 * `hasDanglingMilestone` so the screen can say the roadmap is internally inconsistent rather than just short.
 * A test asserts the real invariant: every milestone appears EXACTLY ONCE across the groups.
 *
 * TWO PARTIAL SIGNALS, INDEPENDENT. `status: 'partial'` is the server's completeness ruling;
 * `modelFlaggedPartial` is the model reporting on its own output. A roadmap can be `complete` and still be
 * flagged by the model that wrote it. Folding them together loses whichever one you drop — the same shape as
 * the strategy generation, and the same reason.
 */
import type { GoalDTO, MilestoneDTO, RoadmapDTO, RoadmapOrigin, RoadmapStatus } from '@acbp/contracts';

export type RoadmapState = 'nothing_planned' | 'complete' | 'partial';

export interface GoalView {
  readonly goalId: string;
  readonly ordinal: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: GoalDTO['status'];
  /** This goal's milestones, ordered by the SERVER's ordinal. */
  readonly milestones: readonly MilestoneDTO[];
}

export interface RoadmapView {
  readonly state: RoadmapState;
  readonly headline: string;
  readonly roadmapId: string | null;
  readonly version: number | null;
  /** The decision this roadmap was built from. A roadmap is downstream of exactly one. */
  readonly decisionId: string | null;
  readonly origin: RoadmapOrigin | null;
  readonly originNote: string | null;
  readonly editReason: string | null;
  readonly supersedesEarlier: boolean;
  readonly modelFlaggedPartial: boolean;
  readonly goals: readonly GoalView[];
  /** Milestones belonging to no goal, or to a goal absent from this roadmap. Never dropped. */
  readonly unattachedMilestones: readonly MilestoneDTO[];
  /** True when at least one milestone names a goal this roadmap does not contain. */
  readonly hasDanglingMilestone: boolean;
  readonly activeGoalCount: number;
  readonly reachedMilestoneCount: number;
  readonly plannedMilestoneCount: number;
  readonly droppedMilestoneCount: number;
  readonly createdAt: string | null;
}

const EMPTY: RoadmapView = {
  state: 'nothing_planned',
  // NO FAILURE VOCABULARY — a first visit is not a fault. Pinned by a test.
  headline: 'No roadmap has been planned for this company yet.',
  roadmapId: null,
  version: null,
  decisionId: null,
  origin: null,
  originNote: null,
  editReason: null,
  supersedesEarlier: false,
  modelFlaggedPartial: false,
  goals: [],
  unattachedMilestones: [],
  hasDanglingMilestone: false,
  activeGoalCount: 0,
  reachedMilestoneCount: 0,
  plannedMilestoneCount: 0,
  droppedMilestoneCount: 0,
  createdAt: null,
};

/** Ordered by the SERVER's ordinal, never by array position — transport order is an accident. */
function byOrdinal<T extends { readonly ordinal: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.ordinal - b.ordinal);
}

function originNoteFor(origin: RoadmapOrigin, editReason: string | null): string {
  if (origin === 'generated') return 'This roadmap was generated and has not been edited since.';
  return editReason === null
    ? 'This roadmap was edited after it was generated, and no reason was recorded for the edit.'
    : 'This roadmap was edited after it was generated. The reason given:';
}

function headlineFor(status: RoadmapStatus, goalCount: number, version: number): string {
  const plan = `Version ${String(version)} of the plan, with ${String(goalCount)} ${goalCount === 1 ? 'goal' : 'goals'}.`;
  return status === 'partial' ? `${plan} The server marked it partial — it is not the whole plan.` : plan;
}

export function toRoadmapView(roadmap: RoadmapDTO | null): RoadmapView {
  if (roadmap === null) return EMPTY;

  const goalIds = new Set(roadmap.goals.map((g) => g.goalId));
  const byGoal = new Map<string, MilestoneDTO[]>();
  const unattached: MilestoneDTO[] = [];
  let dangling = false;

  for (const m of roadmap.milestones) {
    if (m.goalId === null) {
      unattached.push(m);
      continue;
    }
    if (!goalIds.has(m.goalId)) {
      // A REFERENCE TO A GOAL THAT IS NOT HERE. Dropping it would hide real work; silently attaching it
      // somewhere would invent a relationship. It is shown, and the inconsistency is named.
      dangling = true;
      unattached.push(m);
      continue;
    }
    const list = byGoal.get(m.goalId) ?? [];
    list.push(m);
    byGoal.set(m.goalId, list);
  }

  const goals: readonly GoalView[] = byOrdinal(roadmap.goals).map((g) => ({
    goalId: g.goalId,
    ordinal: g.ordinal,
    title: g.title,
    description: g.description,
    status: g.status,
    milestones: byOrdinal(byGoal.get(g.goalId) ?? []),
  }));

  return {
    state: roadmap.status === 'partial' ? 'partial' : 'complete',
    headline: headlineFor(roadmap.status, roadmap.goals.length, roadmap.version),
    roadmapId: roadmap.roadmapId,
    version: roadmap.version,
    decisionId: roadmap.decisionId,
    origin: roadmap.origin,
    originNote: originNoteFor(roadmap.origin, roadmap.editReason),
    editReason: roadmap.editReason,
    supersedesEarlier: roadmap.supersedesRoadmapId !== null,
    modelFlaggedPartial: roadmap.modelFlaggedPartial,
    goals,
    unattachedMilestones: byOrdinal(unattached),
    hasDanglingMilestone: dangling,
    // COUNTED BY STATUS, not by array length. A dropped goal is not outstanding work and an achieved one is
    // not either; reporting "5 goals" for a roadmap with three dropped would overstate what is left.
    activeGoalCount: roadmap.goals.filter((g) => g.status === 'active').length,
    reachedMilestoneCount: roadmap.milestones.filter((m) => m.status === 'reached').length,
    plannedMilestoneCount: roadmap.milestones.filter((m) => m.status === 'planned').length,
    droppedMilestoneCount: roadmap.milestones.filter((m) => m.status === 'dropped').length,
    createdAt: roadmap.createdAt,
  };
}
