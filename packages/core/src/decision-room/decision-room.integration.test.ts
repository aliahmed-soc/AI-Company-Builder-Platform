// ACBP-P6-008 / CDR-076 — real-PostgreSQL proof of the Decision Room through the RESTRICTED role.
//
// This suite discharges the CDR-076 §5 claims, and three of them are the reason the ticket was designed the way
// it was rather than the obvious way:
//
//   §5.2 HOLLOW SUCCESS IS UNRENDERABLE — a `completed` task with no succeeded run is FORGED here (the real
//        completion path refuses to create one, which is the point) and asserted absent from `results` AND
//        counted in `integrity.unverifiedCompletions`. Invariant 20 / trust-critical #18.
//   §5.3 ONE FAILING SECTION DOES NOT EMPTY THE OTHER NINE — the savepoint claim. Without savepoints, the first
//        failed statement aborts the transaction and the remaining sections all report nothing, which renders
//        identically to "nothing needs your decision". The test forces a failure and checks the other nine.
//   §5.4 EMPTY ≠ UNAVAILABLE — an `ok` section with no rows carries count 0 (a positive claim); a degraded or
//        restricted section carries `null`.
//
// Setup/seed on the superuser (owner); every service call runs through the restricted `acbp_app` client.
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import { DECISION_ROOM_QUEUES, type DecisionRoomQueue, type DecisionRoomSection, type DecisionRoomView } from '@acbp/contracts';
import {
  hasTestDatabase,
  createOwnerFixtureClient,
  createRestrictedProductClient,
  enableAppLogin,
  resetSchema,
  truncateFixtures,
  seedTwoTenantWorld,
  teardown,
  assertRestrictedRole,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun, succeedRun } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { requestApproval } from '../approvals/index.js';
import { readDecisionRoom } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('Decision Room (real PostgreSQL, restricted role) — ACBP-P6-008/CDR-076', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  const asOwner = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const asViewer = () => ({ userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 });

  async function room(params = asOwner(), failSectionsForTest?: readonly DecisionRoomQueue[]): Promise<DecisionRoomView> {
    const r = await readDecisionRoom(product, params, failSectionsForTest === undefined ? {} : { failSectionsForTest });
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    return r.room;
  }
  const sectionOf = (v: DecisionRoomView, q: DecisionRoomQueue): DecisionRoomSection => {
    const s = v.sections.find((x) => x.queue === q);
    if (s === undefined) throw new Error(`missing section ${q}`);
    return s;
  };

  // ── Fixture builders: real use cases where a real path exists, owner SQL only where one deliberately does not ──

  /** A task driven through the real use cases to `planned`. */
  async function plannedTask(title: string, companyId = w.companyA1, userId = w.aOwner, accountId = w.accountA): Promise<string> {
    const created = await createTask(product, { userId, accountId, companyId, title, description: null, milestoneId: null });
    if ((created as { status: string }).status !== 'ok') throw new Error(`createTask failed: ${(created as { status: string }).status}`);
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { userId, accountId, companyId, taskId })).status).toBe('ok');
    return taskId;
  }

  /** Force a task into a state whose real transition path is not what this suite is testing. */
  async function forceTaskState(taskId: string, state: string): Promise<void> {
    await sql`update tasks set state = ${state}, updated_at = now() where id = ${taskId}::uuid`.execute(owner.kysely);
  }

  /** A task with a genuinely SUCCEEDED run behind it — the evidence invariant 20 requires. */
  async function taskWithSucceededRun(title: string): Promise<{ taskId: string; runId: string }> {
    const taskId = await plannedTask(title);
    await forceTaskState(taskId, 'queued');
    const started = await startRun(product, { ...asOwner(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    const runId = (started as { status: 'ok'; run: { id: string } }).run.id;
    await forceTaskState(taskId, 'running');
    expect((await succeedRun(product, { ...asOwner(), runId })).status).toBe('ok');
    return { taskId, runId };
  }

  /** A pending approval request, raised through the real service (needs a policy, a run and a registered tool). */
  async function pendingApproval(): Promise<string> {
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('send_email', 1, 'external_reversible', 'fixture tool', 'active')
              on conflict do nothing`.execute(owner.kysely);
    expect((await initializeCompanyPolicy(product, asOwner())).status).toBe('ok');
    const { runId } = await taskWithSucceededRun('Outreach run');
    const r = await requestApproval(product, {
      ...asOwner(),
      runId,
      toolId: 'send_email',
      // Stated explicitly: ACBP-P6-004 ships the expiry mechanism with NO default value anywhere, so a fixture
      // that omitted it would mean the platform was quietly answering an open owner question.
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: 'one_action' as const,
      action: 'Email three suppliers',
      reason: 'Outreach is the next planned step',
      expectedResult: 'Three emails delivered',
      data: { recipients: 3 },
      estimatedCostCredits: 1,
      preview: 'To: 3 suppliers',
    });
    if (r.status !== 'ok') throw new Error(`approval request failed: ${r.status}`);
    return r.request.id;
  }

  // ── The shape of the room ─────────────────────────────────────────────────────────────────────────────────

  test('all TEN queues are present, in canonical order, and an empty world answers 0 rather than null', async () => {
    const v = await room();
    expect(v.sections.map((s) => s.queue)).toEqual([...DECISION_ROOM_QUEUES]);
    for (const s of v.sections) {
      // The §5.4 claim: an empty queue is a POSITIVE claim, so it is `ok` with a real zero — never a null that a
      // renderer would have to guess about.
      expect({ queue: s.queue, status: s.status, count: s.count }).toEqual({ queue: s.queue, status: 'ok', count: 0 });
    }
    expect(v.integrity.unverifiedCompletions).toBe(0);
    expect(v.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  test('a non-member is refused the room entirely — there is no partial view for a stranger', async () => {
    expect(await readDecisionRoom(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 })).toEqual({ status: 'forbidden' });
    expect(await readDecisionRoom(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1 })).toEqual({ status: 'forbidden' });
  });

  // ── Queue population and counts (§5.1) ────────────────────────────────────────────────────────────────────

  test('each queue counts its own precondition, and a task appears in exactly one of the mutually exclusive ones', async () => {
    const planned = await plannedTask('Draft positioning brief');
    const queued = await plannedTask('Publish landing page');
    await forceTaskState(queued, 'queued');
    const running = await plannedTask('Run competitor scan');
    await forceTaskState(running, 'queued');
    await forceTaskState(running, 'running');
    const blocked = await plannedTask('Await founder input');
    await forceTaskState(blocked, 'waiting_for_input');
    const failed = await plannedTask('Broken integration');
    await forceTaskState(failed, 'failed');

    const v = await room();
    expect(sectionOf(v, 'recommended_next_actions').count).toBe(1);
    expect(sectionOf(v, 'recommended_next_actions').items[0]?.id).toBe(planned);
    expect(sectionOf(v, 'approved_and_queued').count).toBe(1);
    expect(sectionOf(v, 'approved_and_queued').items[0]?.id).toBe(queued);
    expect(sectionOf(v, 'executing').count).toBe(1);
    expect(sectionOf(v, 'executing').items[0]?.id).toBe(running);
    expect(sectionOf(v, 'blocked_work').count).toBe(1);
    expect(sectionOf(v, 'blocked_work').items[0]?.id).toBe(blocked);
    expect(sectionOf(v, 'failed_work').count).toBe(1);
    expect(sectionOf(v, 'failed_work').items[0]?.id).toBe(failed);

    // ONE SNAPSHOT (§5.8): the five tasks are in five mutually exclusive states, so no id may appear twice
    // across those sections. Two sections reading different instants is exactly how that would break.
    const exclusive: DecisionRoomQueue[] = ['recommended_next_actions', 'approved_and_queued', 'executing', 'blocked_work', 'failed_work'];
    const ids = exclusive.flatMap((q) => sectionOf(v, q).items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a pending approval lands in "needs your decision" and is marked PROPOSED, never executed', async () => {
    const id = await pendingApproval();
    const v = await room();
    const s = sectionOf(v, 'needs_your_decision');
    expect(s.status).toBe('ok');
    expect(s.count).toBe(1);
    expect(s.items[0]?.id).toBe(id);
    expect(s.items[0]?.kind).toBe('approval_request');
    // ACT-003: an approval REQUEST describes an action that has not happened.
    expect(s.items[0]?.state).toBe('proposed');
    // Redaction (CDR-076 §3-G10): no payload hash, no data, no ids beyond the request's own.
    expect(Object.keys(s.items[0]?.detail ?? {}).sort()).toEqual(['estimatedCostCredits', 'expiresAt', 'riskClass', 'scope']);
  });

  test('open interview questions are the ones with NO answer, and answering one empties the queue', async () => {
    const sessionId = (
      await owner.kysely
        .insertInto('interview_sessions')
        .values({ account_id: w.accountA, company_id: w.companyA1, state: 'in_progress', started_at: sql<Date>`now()` })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const questionId = (
      await owner.kysely
        .insertInto('interview_questions')
        .values({ session_id: sessionId, account_id: w.accountA, company_id: w.companyA1, position: 1, prompt: 'Who is the first customer?' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    expect(sectionOf(await room(), 'questions_from_ai').count).toBe(1);

    await owner.kysely
      .insertInto('interview_answers')
      .values({ question_id: questionId, revision: 1, session_id: sessionId, account_id: w.accountA, company_id: w.companyA1, status: 'answered', content: 'Independent cafés', created_by_user_id: w.aOwner })
      .execute();

    const after = sectionOf(await room(), 'questions_from_ai');
    expect(after.status).toBe('ok');
    expect(after.count).toBe(0);
  });

  test('held work appears for a member who may read stops, and reviewed held work does not', async () => {
    const taskId = await plannedTask('Held task');
    const stopId = (
      await owner.kysely
        .insertInto('emergency_stops')
        // `company` is an IDENTITY scope, so the schema requires the target it names — a scoped stop with no
        // target is unstorable by design (migration 0050).
        .values({ account_id: w.accountA, company_id: w.companyA1, scope: 'company', target_id: w.companyA1, status: 'active', activated_by_user_id: w.aOwner })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const heldId = (
      await owner.kysely
        .insertInto('held_work')
        .values({ account_id: w.accountA, company_id: w.companyA1, stop_id: stopId, task_id: taskId, status: 'held' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;

    const v = await room();
    expect(sectionOf(v, 'needs_your_decision').items.map((i) => i.id)).toContain(heldId);
    expect(sectionOf(v, 'blocked_work').items.map((i) => i.id)).toContain(heldId);

    // A reviewed hold is history, not a queue: it is no longer blocking a decision.
    await sql`update held_work set status = 'confirmed', reviewed_by_user_id = ${w.aOwner}::uuid, reviewed_at = now() where id = ${heldId}::uuid`.execute(owner.kysely);
    expect(sectionOf(await room(), 'needs_your_decision').count).toBe(0);
  });

  // ── §5.2 invariant 20: hollow success ─────────────────────────────────────────────────────────────────────

  test('a COMPLETED task with a succeeded run is a result, marked EXECUTED', async () => {
    const { taskId } = await taskWithSucceededRun('Market scan');
    await forceTaskState(taskId, 'completed');

    const s = sectionOf(await room(), 'results');
    expect(s.count).toBe(1);
    expect(s.items[0]?.id).toBe(taskId);
    expect(s.items[0]?.state).toBe('executed');
  });

  test('a COMPLETED task with NO succeeded run is unrenderable as a result — and is COUNTED, not swallowed', async () => {
    // Forged directly, because the real completion path refuses to produce this state. That refusal is what makes
    // the row rare; this test is about what the READ does when one exists anyway (a bad migration, a manual fix,
    // a future bug). Showing it as done is a lie; dropping it silently is a quieter one.
    const orphan = await plannedTask('Claimed done, never ran');
    await forceTaskState(orphan, 'completed');

    const v = await room();
    expect(sectionOf(v, 'results').status).toBe('ok');
    expect(sectionOf(v, 'results').count).toBe(0);
    expect(sectionOf(v, 'results').items).toHaveLength(0);
    expect(v.integrity.unverifiedCompletions).toBe(1);
  });

  test('a FAILED run does not evidence a completion — only a succeeded one does', async () => {
    const taskId = await plannedTask('Failed attempt');
    await forceTaskState(taskId, 'queued');
    const started = await startRun(product, { ...asOwner(), taskId, attempt: 1 });
    const runId = (started as { status: 'ok'; run: { id: string } }).run.id;
    await sql`update task_runs set state = 'failed', failure_category = 'provider_error', ended_at = now() where id = ${runId}::uuid`.execute(owner.kysely);
    await forceTaskState(taskId, 'completed');

    const v = await room();
    expect(sectionOf(v, 'results').count).toBe(0);
    expect(v.integrity.unverifiedCompletions).toBe(1);
  });

  // ── §5.3 the savepoint claim ──────────────────────────────────────────────────────────────────────────────

  test('ONE failing section degrades ALONE — the other nine keep their snapshot and their counts', async () => {
    const planned = await plannedTask('Still visible');
    const v = await room(asOwner(), ['results']);

    const results = sectionOf(v, 'results');
    expect(results.status).toBe('unavailable');
    // The §0 property: a broken section reports NO count. A zero here would read as "nothing was completed".
    expect(results.count).toBeNull();
    expect(results.items).toHaveLength(0);

    // Every other section still answered — this is what the savepoints buy. Without them the failed statement
    // would have aborted the transaction and all nine of these would be unavailable too.
    for (const q of DECISION_ROOM_QUEUES) {
      if (q === 'results') continue;
      expect({ queue: q, status: sectionOf(v, q).status }).toEqual({ queue: q, status: 'ok' });
    }
    expect(sectionOf(v, 'recommended_next_actions').items[0]?.id).toBe(planned);
    expect(v.integrity.unverifiedCompletions).toBe(0);
  });

  test('several failing sections degrade independently, and the digest distinguishes them from empty ones', async () => {
    const healthy = await room();
    const degraded = await room(asOwner(), ['results', 'failed_work', 'executing']);
    for (const q of ['results', 'failed_work', 'executing'] as const) {
      expect(sectionOf(degraded, q).status).toBe('unavailable');
      expect(sectionOf(degraded, q).count).toBeNull();
    }
    expect(sectionOf(degraded, 'needs_your_decision').status).toBe('ok');
    // A degraded room and an empty room must never produce the same change token: a stream that could not tell
    // them apart would report "no change" while the surface silently stopped answering.
    expect(degraded.digest).not.toBe(healthy.digest);
  });

  // ── §5.6 restricted ≠ empty, and ACT-004 scoping ──────────────────────────────────────────────────────────

  test('ACT-004 usage: an owner sees THIS COMPANY\'S figures; a viewer is told the section is restricted', async () => {
    await sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'anthropic', 'test-model', 'generation', 'ok', 100, 50, 4200, false, 10)`.execute(owner.kysely);
    // A sibling company's usage in the SAME account — the figure must not absorb it (CDR-076 §3-G8).
    await sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms)
              values (${w.accountA}::uuid, ${w.companyA2}::uuid, 'anthropic', 'test-model', 'generation', 'ok', 900, 900, 99999, false, 10)`.execute(owner.kysely);

    const asOwnerRoom = await room();
    expect(asOwnerRoom.usage.status).toBe('ok');
    expect(asOwnerRoom.usage.figures).toEqual({ eventCount: 1, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 4200 });

    const asViewerRoom = await room(asViewer());
    // RESTRICTED, not zero: a viewer is not told "you spent nothing", they are told it is not theirs to see.
    expect(asViewerRoom.usage.status).toBe('restricted');
    expect(asViewerRoom.usage.figures).toBeNull();
  });

  test('a viewer still gets the ten queues, and the approval-backed sections read for them', async () => {
    await pendingApproval();
    const v = await room(asViewer());
    expect(v.sections.map((s) => s.queue)).toEqual([...DECISION_ROOM_QUEUES]);
    // `approval:read` is owner|viewer, so a viewer sees WHAT is waiting without being able to decide it.
    expect(sectionOf(v, 'needs_your_decision').count).toBe(1);
  });

  // ── §5.5 never the wrong company ──────────────────────────────────────────────────────────────────────────

  test('company B\'s work never appears in company A\'s room', async () => {
    const foreign = await plannedTask('Beta work', w.companyB1, w.bOwner, w.accountB);
    await sql`insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms)
              values (${w.accountB}::uuid, ${w.companyB1}::uuid, 'anthropic', 'test-model', 'generation', 'ok', 777, 777, 7777, false, 10)`.execute(owner.kysely);

    const v = await room();
    const everyId = v.sections.flatMap((s) => s.items.map((i) => i.id));
    expect(everyId).not.toContain(foreign);
    for (const s of v.sections) expect(s.count).toBe(0);
    expect(v.usage.figures).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });

    // And the same read from B's own room DOES see it — otherwise the assertion above could pass vacuously.
    const bRoom = await readDecisionRoom(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 });
    if (bRoom.status !== 'ok') throw new Error('expected B owner to read B1');
    expect(sectionOf(bRoom.room, 'recommended_next_actions').items.map((i) => i.id)).toEqual([foreign]);
  });

  // ── The change digest over a real room ────────────────────────────────────────────────────────────────────

  test('the digest changes when work changes, and is stable when nothing does', async () => {
    const first = await room();
    expect((await room()).digest).toBe(first.digest);
    await plannedTask('New proposal');
    expect((await room()).digest).not.toBe(first.digest);
  });
});
