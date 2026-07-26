// @acbp/contracts — planning transparency (ACBP-P4-006; CDR-041; PLAN-004). Zero-dep, provider-neutral.
//
// PLAN-004: "Each planning run shows what inputs it considered … and why the top tasks were chosen." The "why" is the
// per-task `rationale` (see `task-plan.ts`); the "what it considered" is a RUN plus the set of inputs linked to it.
//
// The snapshot LINKS, it does not COPY (CDR-041 §3-G2): every input is a resolvable reference to a row that already
// exists, never a captured blob of the assembled prompt. Copying would duplicate content the secret blocklist already
// redacted once, and would leave two divergent versions of the same fact.

/** How the run was initiated. Autonomous planning (PLAN-001) or an owner's natural-language steer (PLAN-002). */
export const PLANNING_RUN_MODES = ['autonomous', 'steered'] as const;
export type PlanningRunMode = (typeof PLANNING_RUN_MODES)[number];
export function isPlanningRunMode(v: unknown): v is PlanningRunMode {
  return typeof v === 'string' && (PLANNING_RUN_MODES as readonly string[]).includes(v);
}

/**
 * What the run produced. A run is recorded even when generation FAILED (CDR-041 §3-G3) — "every planning run links its
 * input snapshot" is unqualified, and a failed run is exactly the one an owner wants to inspect.
 *
 * `clarification` and `refusal` are steering's honest SUCCESSFUL answers (PLAN-002), kept distinct from `failed` so
 * the record cannot misrepresent an honest model answer as a system fault.
 */
export const PLANNING_RUN_OUTCOMES = ['ok', 'partial', 'clarification', 'refusal', 'failed'] as const;
export type PlanningRunOutcome = (typeof PLANNING_RUN_OUTCOMES)[number];
export function isPlanningRunOutcome(v: unknown): v is PlanningRunOutcome {
  return typeof v === 'string' && (PLANNING_RUN_OUTCOMES as readonly string[]).includes(v);
}

/**
 * The kind of thing an input reference points at. CLOSED, and deliberately wider than what P4-006 records today:
 * `metric` and `prior_result` have no subsystem yet (usage rollups are P6-009; task-run artifacts are Phase 5), and
 * declaring them now is what makes adding them later an INSERT rather than a migration (CDR-041 §2).
 *
 * `memory_item_withheld` is not a lesser `memory_item`: it records an item that WAS considered and then deliberately
 * withheld from the model for a MEM-004 conflict. "Considered it, and did not use it, because…" is transparency;
 * dropping it silently would make the snapshot claim the item was never looked at.
 */
export const PLANNING_INPUT_KINDS = ['roadmap', 'decision', 'milestone', 'memory_item', 'memory_item_withheld', 'metric', 'prior_result'] as const;
export type PlanningInputKind = (typeof PLANNING_INPUT_KINDS)[number];
export function isPlanningInputKind(v: unknown): v is PlanningInputKind {
  return typeof v === 'string' && (PLANNING_INPUT_KINDS as readonly string[]).includes(v);
}

/** One resolvable link from a run to something it considered. */
export interface PlanningRunInputDTO {
  readonly kind: PlanningInputKind;
  /** The id of the referenced row. Resolvable within the same company (MEM-003 "resolvable source link"). */
  readonly refId: string;
}

export interface PlanningRunDTO {
  readonly id: string;
  readonly mode: PlanningRunMode;
  readonly outcome: PlanningRunOutcome;
  readonly roadmapId: string;
  readonly roadmapVersion: number;
  readonly decisionId: string;
  /** The approved phase scope this run planned within (STRAT-005), or null when none was recorded. */
  readonly phaseScope: string | null;
  readonly taskCount: number;
  /**
   * How many of this run's tasks carry NO rationale. PLAN-004's failure clause: a missing rationale renders as "not
   * recorded" and is COUNTED — it must never vanish into a run that presents itself as fully explained.
   */
  readonly tasksMissingRationale: number;
  readonly milestonesInScope: number;
  readonly memoryItemsConsidered: number;
  readonly createdAt: string;
  readonly inputs: readonly PlanningRunInputDTO[];
}

/**
 * Does this run have a complete "why"? False when any task lacks a rationale — the honest summary a reader needs
 * before trusting the explanation. Derived, never stored: storing it would let it drift from the counts it summarizes.
 */
export function isFullyExplained(run: Pick<PlanningRunDTO, 'taskCount' | 'tasksMissingRationale'>): boolean {
  return run.taskCount > 0 && run.tasksMissingRationale === 0;
}
