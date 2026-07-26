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
  countMissingType,
  countMissingRationale,
  PLANNED_TASK_RATIONALE_MAX,
  TASK_PLAN_SCHEMA,
  TASK_STEERING_SCHEMA,
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

describe('per-task rationale (ACBP-P4-006 / CDR-041 §3-G4; PLAN-004)', () => {
  test('the schema refs are at @2 — adding rationale changes the contract the model is held to', () => {
    // CDR-041 §3-G5: schema refs are the unit of versioning, and @1 is NOT retained (nothing persisted references it,
    // and a dead ref invites a caller to pin a version with no reason behind it). Steering bumps for the same reason:
    // its task members carry the same new field.
    expect(TASK_PLAN_SCHEMA).toBe('planning.tasks.output@2');
    expect(TASK_STEERING_SCHEMA).toBe('planning.task_steering.output@2');
  });

  test('a rationale is parsed and trimmed on both entry points', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ rationale: '  Highest-signal first contact.  ' }), task(), task()] }), MILESTONES);
    expect(r.ok && r.value.tasks[0]?.rationale).toBe('Highest-signal first contact.');
    const s = parseSteeringOutput(steer({ tasks: [task({ rationale: 'Closes the fastest.' })] }), MILESTONES);
    expect(s.ok && s.value.outcome === 'tasks' && s.value.tasks[0]?.rationale).toBe('Closes the fastest.');
  });

  test('a MISSING rationale is null ("not recorded"), never invented and never a rejection', () => {
    // PLAN-004's failure clause: "Missing rationale renders as 'not recorded'". Unlike the description (which the
    // model authors as a matter of course), a rationale it cannot give must not be fabricated — ADR-019. Absent,
    // explicitly null, and whitespace-only all mean the same honest thing.
    for (const missing of [undefined, null, '   ']) {
      const r = parseTaskPlanOutput(plan({ tasks: [task({ rationale: missing }), task(), task()] }), MILESTONES);
      expect(r.ok && r.value.tasks[0]?.rationale).toBeNull();
    }
    // Omitted entirely — the common case for a model that was never asked.
    const omitted = { title: 'T', description: 'what it involves', task_type: 'market_research', milestone_ordinal: 0 };
    const r2 = parseTaskPlanOutput(JSON.stringify({ tasks: [omitted, task(), task()] }), MILESTONES);
    expect(r2.ok && r2.value.tasks[0]?.rationale).toBeNull();
  });

  test('a MALFORMED rationale is a rejection, not a silent null (same rule as task_type)', () => {
    // Silently nulling a non-string would let a structurally wrong payload look like an honest "not recorded".
    for (const bad of [42, true, {}, ['a'], 'x'.repeat(PLANNED_TASK_RATIONALE_MAX + 1)]) {
      expect(parseTaskPlanOutput(plan({ tasks: [task({ rationale: bad }), task(), task()] }), MILESTONES).ok).toBe(false);
      expect(parseSteeringOutput(steer({ tasks: [task({ rationale: bad })] }), MILESTONES).ok).toBe(false);
    }
  });

  test('countMissingRationale reports the shortfall so it can never be silently absorbed', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ rationale: 'because' }), task(), task({ rationale: null })] }), MILESTONES);
    expect(r.ok && countMissingRationale(r.value.tasks)).toBe(2);
    const all = parseTaskPlanOutput(plan({ tasks: [task({ rationale: 'a' }), task({ rationale: 'b' }), task({ rationale: 'c' })] }), MILESTONES);
    expect(all.ok && countMissingRationale(all.value.tasks)).toBe(0);
  });

  test('the defensive narrow applies the SAME rationale rules as the parse', () => {
    // The gateway validator is injected, so the narrow must independently refuse what the parser refuses.
    const ok = narrowTaskPlanOutput({ tasks: [{ title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: 'r' }, { title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: null }, { title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: null }], partial: false }, MILESTONES);
    expect(ok?.tasks[0]?.rationale).toBe('r');
    expect(ok && countMissingRationale(ok.tasks)).toBe(2);
    const bad = (rationale: unknown) => narrowTaskPlanOutput({ tasks: [{ title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale }, { title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: null }, { title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: null }], partial: false }, MILESTONES);
    for (const v of [42, true, '   ', 'x'.repeat(PLANNED_TASK_RATIONALE_MAX + 1)]) expect(bad(v)).toBeUndefined();
    // An ABSENT field on the narrow path is the honest null, matching the parse.
    expect(narrowSteeringOutput({ outcome: 'tasks', intent: 'i', tasks: [{ title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0 }] }, MILESTONES)).toEqual({ outcome: 'tasks', intent: 'i', tasks: [{ title: 'T', description: 'D', taskType: null, milestoneOrdinal: 0, rationale: null }] });
  });
});

describe('task types (ACBP-P4-003/CDR-040 §8-G2)', () => {
  test('the set is exactly the seven PRD "initial task types"', () => {
    expect(TASK_TYPES).toEqual(['market_research', 'competitor_research', 'customer_segment_analysis', 'business_model_comparison', 'business_plan_generation', 'landing_page_copy', 'internal_product_requirements']);
    expect(isTaskType('market_research')).toBe(true);
    expect(isTaskType('vibes')).toBe(false);
  });
});

describe('parseTaskPlanOutput — autonomous planning (PLAN-001)', () => {
  test('a well-formed plan parses, trimming title and description', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ title: '  Interview ten clinics  ', description: '  Book and run the calls.  ' }), task(), task()] }), MILESTONES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tasks[0]).toEqual({ title: 'Interview ten clinics', description: 'Book and run the calls.', taskType: 'market_research', milestoneOrdinal: 0, rationale: null });
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

  test('an ABSENT type is null (explicitly missing, never guessed — ADR-019/TASK-002), and is COUNTED', () => {
    const r = parseTaskPlanOutput(plan({ tasks: [task({ task_type: null }), task(), task()] }), MILESTONES);
    expect(r.ok && r.value.tasks[0]?.taskType).toBeNull();
    const omitted = { title: 'T', description: 'what it involves', milestone_ordinal: 0 };
    const r2 = parseTaskPlanOutput(JSON.stringify({ tasks: [omitted, task(), task()] }), MILESTONES);
    expect(r2.ok && r2.value.tasks[0]?.taskType).toBeNull();
    // The shortfall is surfaced rather than absorbed — PLAN-001's failure clause covers a partial shortfall too.
    expect(r2.ok && countMissingType(r2.value.tasks)).toBe(1);
    expect(r.ok && countMissingType(r.value.tasks)).toBe(1);
    const allTyped = parseTaskPlanOutput(plan(), MILESTONES);
    expect(allTyped.ok && countMissingType(allTyped.value.tasks)).toBe(0);
  });

  test('PLAN-001 requires a DESCRIPTION on every task — a description-less task is not plannable', () => {
    // Unlike the type (a closed set the model must not be forced to guess), the description is the model's own prose
    // about what doing the task involves, so demanding it guesses nothing.
    for (const bad of [null, undefined, '   ']) {
      expect(parseTaskPlanOutput(plan({ tasks: [task({ description: bad }), task(), task()] }), MILESTONES).ok).toBe(false);
    }
    const omitted = { title: 'T', task_type: 'market_research', milestone_ordinal: 0 };
    expect(parseTaskPlanOutput(JSON.stringify({ tasks: [omitted, task(), task()] }), MILESTONES).ok).toBe(false);
    // Steering tasks obey the same rule.
    expect(parseSteeringOutput(steer({ tasks: [task({ description: null })] }), MILESTONES).ok).toBe(false);
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
