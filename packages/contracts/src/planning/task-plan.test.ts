// @acbp/contracts — task planning + steering contract tests (ACBP-P4-003; CDR-040; PLAN-001/002). Adversarial: one
// malformed task rejects the WHOLE plan, a task can never name a milestone that does not exist, the `partial` flag is
// never coerced, PLAN-001's 3+ can only be relaxed by an honest partial, and the steering discriminator is never
// defaulted (guessing which answer the model meant is the "guessed execution" PLAN-002 forbids).
import { describe, test, expect } from 'vitest';
import {
  TASK_TYPES,
  isTaskType,
  parseTaskPlanOutput,
  parseSteeringOutput,
  narrowTaskPlanOutput,
  narrowSteeringOutput,
  normalizeSteeringRequest,
  PLANNED_TASK_TITLE_MAX,
  PLANNED_TASK_DESCRIPTION_MAX,
  PLANNED_TASKS_MAX,
  PLANNED_TASKS_MIN,
  STEERING_REQUEST_MAX,
  STEERING_MESSAGE_MAX,
} from './task-plan.js';

const MILESTONES = 3;
const task = (over: Record<string, unknown> = {}) => ({ title: 'Interview ten clinics', description: 'Book and run the calls.', task_type: 'market_research', milestone_ordinal: 0, ...over });
const plan = (over: Record<string, unknown> = {}) => JSON.stringify({ tasks: [task(), task({ title: 'Map competitors' }), task({ title: 'Draft pricing' })], ...over });
const steer = (over: Record<string, unknown> = {}) => JSON.stringify({ outcome: 'tasks', intent: 'Find early customers', tasks: [task()], ...over });

describe('task types (ACBP-P4-003/CDR-040 §8-G2)', () => {
  test('the set is exactly the seven PRD "initial task types"', () => {
    expect(TASK_TYPES).toEqual(['market_research', 'competitor_research', 'customer_segment_analysis', 'business_model_comparison', 'business_plan_generation', 'landing_page_copy', 'internal_product_requirements']);
    expect(isTaskType('market_research')).toBe(true);
    expect(isTaskType('vibes')).toBe(false);
  });
});

describe('parseTaskPlanOutput — autonomous planning (PLAN-001)', () => {
  test('a well-formed plan parses, trimming and normalizing a blank description to null', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ title: '  Interview ten clinics  ', description: '   ' }), task(), task()] }), MILESTONES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tasks[0]).toEqual({ title: 'Interview ten clinics', description: null, taskType: 'market_research', milestoneOrdinal: 0 });
    expect(r.value.partial).toBe(false);
  });

  test("PLAN-001's 3+ is enforced, and can ONLY be relaxed by the model honestly flagging partial", () => {
    const two = { tasks: [task(), task()] };
    expect(parseTaskPlanOutput(JSON.stringify(two), MILESTONES).ok).toBe(false);
    expect(parseTaskPlanOutput(JSON.stringify({ ...two, partial: true }), MILESTONES).ok).toBe(true);
    // Even flagged partial, an EMPTY plan is nothing to persist.
    expect(parseTaskPlanOutput(JSON.stringify({ tasks: [], partial: true }), MILESTONES).ok).toBe(false);
    expect(PLANNED_TASKS_MIN).toBe(3);
  });

  test('the partial flag is never coerced (absent → complete; non-boolean → REJECT)', () => {
    const complete = parseTaskPlanOutput(plan(), MILESTONES);
    expect(complete.ok && complete.value.partial).toBe(false);
    expect(parseTaskPlanOutput(plan({ partial: 'yes' }), MILESTONES).ok).toBe(false);
    expect(parseTaskPlanOutput(plan({ partial: 1 }), MILESTONES).ok).toBe(false);
  });

  test('a task can NEVER name a milestone that does not exist (ROAD-001 traceability, before the DB FK)', () => {
    for (const bad of [MILESTONES, MILESTONES + 5, -1, 1.5, '0', null, undefined]) {
      expect(parseTaskPlanOutput(plan({ tasks: [task({ milestone_ordinal: bad }), task(), task()] }), MILESTONES).ok).toBe(false);
    }
    // Every in-range ordinal is fine.
    expect(parseTaskPlanOutput(plan({ tasks: [task({ milestone_ordinal: 0 }), task({ milestone_ordinal: 1 }), task({ milestone_ordinal: 2 })] }), MILESTONES).ok).toBe(true);
  });

  test('ONE malformed task rejects the WHOLE plan — never a silent drop', () => {
    const withBad = (bad: unknown) => parseTaskPlanOutput(plan({ tasks: [task(), task(), bad] }), MILESTONES).ok;
    expect(withBad(task({ title: '   ' }))).toBe(false);
    expect(withBad(task({ title: 'x'.repeat(PLANNED_TASK_TITLE_MAX + 1) }))).toBe(false);
    expect(withBad(task({ description: 'x'.repeat(PLANNED_TASK_DESCRIPTION_MAX + 1) }))).toBe(false);
    expect(withBad(task({ task_type: 'made_up_type' }))).toBe(false); // a MALFORMED type rejects, never silently null
    expect(withBad(null)).toBe(false);
    expect(withBad('a string')).toBe(false);
  });

  test('an ABSENT type is null (explicitly missing, never guessed — ADR-019/TASK-002)', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ task_type: null }), task(), task()] }), MILESTONES);
    expect(r.ok && r.value.tasks[0]?.taskType).toBeNull();
    const omitted = { title: 'T', description: null, milestone_ordinal: 0 };
    const r2 = parseTaskPlanOutput(JSON.stringify({ tasks: [omitted, task(), task()] }), MILESTONES);
    expect(r2.ok && r2.value.tasks[0]?.taskType).toBeNull();
  });

  test('structurally unusable payloads are rejected', () => {
    expect(parseTaskPlanOutput('not json', MILESTONES).ok).toBe(false);
    expect(parseTaskPlanOutput('[]', MILESTONES).ok).toBe(false);
    expect(parseTaskPlanOutput('null', MILESTONES).ok).toBe(false);
    expect(parseTaskPlanOutput(JSON.stringify({ partial: false }), MILESTONES).ok).toBe(false); // no tasks key
    const tooMany = Array.from({ length: PLANNED_TASKS_MAX + 1 }, () => task());
    expect(parseTaskPlanOutput(JSON.stringify({ tasks: tooMany }), MILESTONES).ok).toBe(false);
  });
});

describe('parseSteeringOutput — the three honest answers (PLAN-002)', () => {
  test('tasks: the interpreted INTENT is required (it is what must be previewed)', () => {
    const r = parseSteeringOutput(steer(), MILESTONES);
    expect(r.ok && r.value.outcome).toBe('tasks');
    if (r.ok && r.value.outcome === 'tasks') {
      expect(r.value.intent).toBe('Find early customers');
      expect(r.value.tasks).toHaveLength(1); // NO 3+ minimum on steering — one relevant task is a legitimate answer
    }
    expect(parseSteeringOutput(steer({ intent: '   ' }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(JSON.stringify({ outcome: 'tasks', tasks: [task()] }), MILESTONES).ok).toBe(false); // no intent
  });

  test('clarification: an ambiguous request yields a QUESTION, never guessed tasks', () => {
    const r = parseSteeringOutput(JSON.stringify({ outcome: 'clarification', question: 'Which customer segment do you mean?' }), MILESTONES);
    expect(r.ok && r.value.outcome).toBe('clarification');
    if (r.ok && r.value.outcome === 'clarification') expect(r.value.question).toBe('Which customer segment do you mean?');
    expect(parseSteeringOutput(JSON.stringify({ outcome: 'clarification', question: '  ' }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(JSON.stringify({ outcome: 'clarification', question: 'x'.repeat(STEERING_MESSAGE_MAX + 1) }), MILESTONES).ok).toBe(false);
  });

  test('refusal: an honest refusal carries a reason', () => {
    const r = parseSteeringOutput(JSON.stringify({ outcome: 'refusal', reason: 'That is outside this roadmap.' }), MILESTONES);
    expect(r.ok && r.value.outcome).toBe('refusal');
    expect(parseSteeringOutput(JSON.stringify({ outcome: 'refusal' }), MILESTONES).ok).toBe(false);
  });

  test('the outcome discriminator is CLOSED and REQUIRED — never defaulted to tasks', () => {
    // Defaulting would be exactly the "guessed execution" PLAN-002's failure clause forbids.
    expect(parseSteeringOutput(JSON.stringify({ tasks: [task()], intent: 'x' }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(JSON.stringify({ outcome: 'maybe', tasks: [task()], intent: 'x' }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(JSON.stringify({ outcome: null }), MILESTONES).ok).toBe(false);
  });

  test('steering tasks obey the same per-task rules', () => {
    expect(parseSteeringOutput(steer({ tasks: [task({ milestone_ordinal: 99 })] }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(steer({ tasks: [] }), MILESTONES).ok).toBe(false);
    expect(parseSteeringOutput(steer({ tasks: [task({ task_type: 'nope' })] }), MILESTONES).ok).toBe(false);
  });
});

describe('defensive re-entry — the gateway validator is INJECTED, so narrow must re-apply the invariants', () => {
  test('a validated plan round-trips; corrupted or non-persistable values yield undefined', () => {
    const parsed = parseTaskPlanOutput(plan(), MILESTONES);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(narrowTaskPlanOutput(parsed.value, MILESTONES)).toEqual(parsed.value);
    for (const bad of [undefined, null, 'str', 42, {}, { tasks: [], partial: false }, { tasks: 'x', partial: false }]) {
      expect(narrowTaskPlanOutput(bad, MILESTONES)).toBeUndefined();
    }
    // The persistability invariants, not just types: below 3 without partial, and a now-unresolvable ordinal.
    const two = { tasks: parsed.value.tasks.slice(0, 2), partial: false };
    expect(narrowTaskPlanOutput(two, MILESTONES)).toBeUndefined();
    expect(narrowTaskPlanOutput({ ...two, partial: true }, MILESTONES)).toBeDefined();
    expect(narrowTaskPlanOutput(parsed.value, 0)).toBeUndefined(); // the roadmap lost its milestones
  });

  test('a validated steering answer round-trips; each outcome is re-checked', () => {
    const t = parseSteeringOutput(steer(), MILESTONES);
    expect(t.ok && narrowSteeringOutput(t.value, MILESTONES)).toEqual(t.ok ? t.value : undefined);
    expect(narrowSteeringOutput({ outcome: 'clarification', question: 'which?' }, MILESTONES)).toBeDefined();
    expect(narrowSteeringOutput({ outcome: 'clarification', question: '' }, MILESTONES)).toBeUndefined();
    expect(narrowSteeringOutput({ outcome: 'refusal', reason: 'no' }, MILESTONES)).toBeDefined();
    expect(narrowSteeringOutput({ outcome: 'tasks', intent: 'x', tasks: [] }, MILESTONES)).toBeUndefined();
    expect(narrowSteeringOutput({ outcome: 'unknown' }, MILESTONES)).toBeUndefined();
  });
});

describe('normalizeSteeringRequest', () => {
  test('a usable request is trimmed; blank/over-long/non-string are undefined', () => {
    expect(normalizeSteeringRequest('  get me customers  ')).toBe('get me customers');
    expect(normalizeSteeringRequest('x'.repeat(STEERING_REQUEST_MAX))).toHaveLength(STEERING_REQUEST_MAX);
    expect(normalizeSteeringRequest('   ')).toBeUndefined();
    expect(normalizeSteeringRequest('x'.repeat(STEERING_REQUEST_MAX + 1))).toBeUndefined();
    expect(normalizeSteeringRequest(42)).toBeUndefined();
    expect(normalizeSteeringRequest(undefined)).toBeUndefined();
  });
});
