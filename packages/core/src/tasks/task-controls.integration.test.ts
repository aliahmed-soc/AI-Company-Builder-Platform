// ACBP-P4-005 / CDR-043 — real-PostgreSQL proof of the task detail + repeat/delete controls through the RESTRICTED
// role. Proves: the detail view exposes TASK-002's fields with nothing defaulted and a control set derived from the
// live state; repeat mints a NEW linked draft copying content but not provenance, refuses unfinished and deleted
// sources, and audits `task.repeated`; delete requires explicit confirmation, is refused mid-flight with `cancel_first`
// (TASK-008's failure clause), writes an append-only record + `task.deleted`, is idempotent, and never puts the owner's
// reason text in the audit payload; a deleted task vanishes from get/list/board and the draft count while its row and
// audit trail survive; audit-or-nothing rollback; owner+viewer may act, a non-member is forbidden; cross-company
// isolation. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { TASK_CONTROLS, NEXT_ATTEMPT_VALUES } from '@acbp/contracts';
import { createTask, planTask, addTaskDependency, getTask, listTasks, getTaskDetail, repeatTask, deleteTask, getTaskBoard, TASK_DELETE_REASON_MAX } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('task detail + controls (real PostgreSQL, restricted role) — ACBP-P4-005/CDR-043', () => {
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

  /**
   * Assert a use case succeeded and narrow to its `ok` variant. Narrowing beats casting the result to a hand-written
   * shape: a cast would keep compiling after the DTO changed, so these tests would stop checking the real contract.
   */
  function ok<T extends { readonly status: string }>(r: T): Extract<T, { readonly status: 'ok' }> {
    expect(r.status).toBe('ok');
    return r as Extract<T, { readonly status: 'ok' }>;
  }

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();
  const deletions = async () => owner.kysely.selectFrom('task_deletions').selectAll().execute();

  /** A task in a chosen state. The state machine only reaches `planned` in this ticket, so the rest are set directly. */
  async function taskInState(state: string, over: { title?: string; description?: string | null; taskType?: string | null } = {}): Promise<string> {
    const r = await createTask(product, { ...base(), title: over.title ?? 'Interview five prospects', description: over.description ?? null, milestoneId: null });
    expect(r.status).toBe('ok');
    const id = (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
    if (over.taskType !== undefined && over.taskType !== null) {
      await sql`update tasks set task_type = ${over.taskType} where id = ${id}::uuid`.execute(owner.kysely);
    }
    if (state !== 'draft') {
      await sql`update tasks set state = ${state} where id = ${id}::uuid`.execute(owner.kysely);
    }
    return id;
  }

  // ── detail view (TASK-002) ─────────────────────────────────────────────────────────────────────────────
  test('detail exposes type, creation time and description — and leaves MISSING fields missing', async () => {
    const id = await taskInState('planned');
    const d = ok(await getTaskDetail(product, { ...base(), taskId: id })).task;
    expect(d.taskId).toBe(id);
    expect(typeof d.createdAt).toBe('string');
    // TASK-002's failure clause: nothing acquires a placeholder.
    expect(d.taskType).toBeNull();
    expect(d.description).toBeNull();
    expect(d.milestoneId).toBeNull();
    expect(d.priority).toBeNull();
    expect(d.rationale).toBeNull();
    expect(d.repeatedFromTaskId).toBeNull();
  });

  test('detail control set is derived from the LIVE state — it changes when the task does', async () => {
    const id = await taskInState('planned');
    const controlsFor = async () => ok(await getTaskDetail(product, { ...base(), taskId: id })).task.controls;

    const planned = await controlsFor();
    expect(planned).toHaveLength(TASK_CONTROLS.length);
    expect(planned.find((c) => c.control === 'delete')).toEqual({ control: 'delete', available: true, reason: null });
    expect(planned.find((c) => c.control === 'repeat')).toEqual({ control: 'repeat', available: false, reason: 'not_finished' });

    // The same task, now running: delete must flip to refused WITH the remedy, not silently disappear.
    await sql`update tasks set state = 'running' where id = ${id}::uuid`.execute(owner.kysely);
    const running = await controlsFor();
    expect(running.find((c) => c.control === 'delete')).toEqual({ control: 'delete', available: false, reason: 'cancel_first' });

    await sql`update tasks set state = 'failed' where id = ${id}::uuid`.execute(owner.kysely);
    const failed = await controlsFor();
    expect(failed.find((c) => c.control === 'repeat')).toEqual({ control: 'repeat', available: true, reason: null });
    expect(failed.find((c) => c.control === 'delete')).toEqual({ control: 'delete', available: true, reason: null });
  });

  // ── repeat (TASK-008) ──────────────────────────────────────────────────────────────────────────────────
  test('repeat mints a NEW draft linked to its source, copying content but NOT provenance', async () => {
    const src = await taskInState('failed', { title: 'Interview five prospects', description: 'Ring the waitlist.', taskType: 'market_research' });
    // Provenance the repeat must NOT inherit: a rank and a rationale about the ORIGINAL task.
    await sql`update tasks set priority = 3, rationale = 'Chosen because it is cheapest.' where id = ${src}::uuid`.execute(owner.kysely);

    const r = await repeatTask(product, { ...base(), taskId: src });
    expect(r.status).toBe('ok');
    const created = (r as { status: 'ok'; task: { taskId: string; state: string; title: string; description: string | null; taskType: string | null; priority: number | null } }).task;

    // A NEW row in `draft` — the source's own history is untouched.
    expect(created.taskId).not.toBe(src);
    expect(created.state).toBe('draft');
    expect(await stateOf(src)).toBe('failed');
    // Content carries over…
    expect(created.title).toBe('Interview five prospects');
    expect(created.description).toBe('Ring the waitlist.');
    expect(created.taskType).toBe('market_research');
    // …provenance does not. Inheriting a rationale would attribute reasoning about one task to a different one.
    expect(created.priority).toBeNull();
    const fresh = await sql<{ rationale: string | null; src: string | null }>`select rationale, repeated_from_task_id as src from tasks where id = ${created.taskId}::uuid`.execute(owner.kysely);
    expect(fresh.rows[0]?.rationale).toBeNull();
    expect(fresh.rows[0]?.src).toBe(src);
  });

  test('repeat writes a bounded task.repeated — the NEW task is the subject, with no content', async () => {
    const src = await taskInState('completed', { title: 'Secret internal codename', description: 'Confidential plan.' });
    const r = await repeatTask(product, { ...base(), taskId: src });
    const newId = (r as { status: 'ok'; task: { taskId: string } }).task.taskId;

    const events = await auditFor('task.repeated');
    expect(events).toHaveLength(1);
    expect(events[0]?.subject_id).toBe(newId);
    const blob = JSON.stringify(events[0]);
    expect(blob).toContain(src); // lineage reads from either end
    expect(blob).not.toContain('Secret internal codename');
    expect(blob).not.toContain('Confidential plan.');
  });

  test('repeat is REFUSED for work that has not finished, and the refusal names why', async () => {
    for (const state of ['draft', 'planned', 'queued', 'running', 'waiting_for_approval', 'paused'] as const) {
      const id = await taskInState(state);
      const r = await repeatTask(product, { ...base(), taskId: id });
      expect(r.status).toBe('unavailable');
      expect((r as { status: 'unavailable'; reason: string }).reason).toBe('not_finished');
    }
    // Nothing was created and nothing was audited by any of those refusals.
    expect(await auditFor('task.repeated')).toHaveLength(0);
  });

  test('a DELETED task cannot be repeated — a discarded task is not revivable through a link (G6)', async () => {
    const id = await taskInState('failed');
    expect((await deleteTask(product, { ...base(), taskId: id, confirmed: true })).status).toBe('ok');
    const r = await repeatTask(product, { ...base(), taskId: id });
    expect(r.status).toBe('not_found');
    expect(await auditFor('task.repeated')).toHaveLength(0);
  });

  // ── delete (TASK-008) ──────────────────────────────────────────────────────────────────────────────────
  test('delete WITHOUT confirmation is refused, writes nothing, and cannot be used to probe existence', async () => {
    const id = await taskInState('planned');
    const r = await deleteTask(product, { ...base(), taskId: id, confirmed: false });
    expect(r.status).toBe('confirmation_required');
    // The SAME answer for a task that does not exist at all — an unconfirmed call is not an existence oracle.
    const ghost = await deleteTask(product, { ...base(), taskId: '00000000-0000-0000-0000-000000000000', confirmed: false });
    expect(ghost.status).toBe('confirmation_required');
    expect(await deletions()).toHaveLength(0);
    expect(await auditFor('task.deleted')).toHaveLength(0);
  });

  test('delete of a RUNNING task is REFUSED — "cancel first" (TASK-008 failure clause)', async () => {
    for (const state of ['running', 'waiting_for_input', 'waiting_for_approval', 'blocked_by_policy', 'paused'] as const) {
      const id = await taskInState(state);
      const r = await deleteTask(product, { ...base(), taskId: id, confirmed: true });
      expect(r.status).toBe('unavailable');
      expect((r as { status: 'unavailable'; reason: string }).reason).toBe('cancel_first');
      expect(await stateOf(id)).toBe(state); // untouched
    }
    expect(await deletions()).toHaveLength(0);
    expect(await auditFor('task.deleted')).toHaveLength(0);
  });

  test('delete records an APPEND-ONLY fact + task.deleted; the task row and its history survive', async () => {
    const id = await taskInState('completed');
    const r = await deleteTask(product, { ...base(), taskId: id, confirmed: true, reason: 'Duplicated by the newer plan.' });
    expect(r.status).toBe('ok');
    expect((r as { status: 'ok'; stateAtDelete: string }).stateAtDelete).toBe('completed');

    // The row is STILL THERE — this is the whole design. A real DELETE would remove the evidence.
    expect(await stateOf(id)).toBe('completed');
    const recs = await deletions();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.task_id).toBe(id);
    expect(recs[0]?.state_at_delete).toBe('completed');
    expect(recs[0]?.reason).toBe('Duplicated by the newer plan.');

    const events = await auditFor('task.deleted');
    expect(events).toHaveLength(1);
    expect(events[0]?.subject_id).toBe(id);
  });

  test('the owner’s reason text NEVER reaches the audit payload — only whether one was given', async () => {
    const id = await taskInState('cancelled');
    await deleteTask(product, { ...base(), taskId: id, confirmed: true, reason: 'Because Priya said the client walked.' });
    const events = await auditFor('task.deleted');
    const blob = JSON.stringify(events[0]);
    expect(blob).not.toContain('Priya');
    expect(blob).not.toContain('the client walked');
    expect(blob).toContain('has_reason');
  });

  test('a blank reason collapses to none; an over-long one is invalid and writes nothing', async () => {
    const blank = await taskInState('failed');
    expect((await deleteTask(product, { ...base(), taskId: blank, confirmed: true, reason: '   ' })).status).toBe('ok');
    expect((await deletions())[0]?.reason).toBeNull();

    const long = await taskInState('failed');
    const r = await deleteTask(product, { ...base(), taskId: long, confirmed: true, reason: 'x'.repeat(TASK_DELETE_REASON_MAX + 1) });
    expect(r.status).toBe('invalid');
    expect(await deletions()).toHaveLength(1); // still just the blank-reason one
  });

  test('deleting twice is the SAME fact — one record, one audit event, second call not_found', async () => {
    const id = await taskInState('completed');
    expect((await deleteTask(product, { ...base(), taskId: id, confirmed: true })).status).toBe('ok');
    const second = await deleteTask(product, { ...base(), taskId: id, confirmed: true });
    expect(second.status).toBe('not_found');
    expect(await deletions()).toHaveLength(1);
    expect(await auditFor('task.deleted')).toHaveLength(1);
  });

  // ── a deleted task disappears from every product read (G9) ─────────────────────────────────────────────
  test('a deleted task vanishes from get, detail, list, the board AND the draft count', async () => {
    const kept = await taskInState('planned', { title: 'Kept' });
    const doomedDraft = await taskInState('draft', { title: 'Doomed draft' });
    const doomedBoard = await taskInState('completed', { title: 'Doomed board task' });

    expect(ok(await getTaskBoard(product, { ...base() })).board.draftsOffBoard).toBe(1);

    expect((await deleteTask(product, { ...base(), taskId: doomedDraft, confirmed: true })).status).toBe('ok');
    expect((await deleteTask(product, { ...base(), taskId: doomedBoard, confirmed: true })).status).toBe('ok');

    expect((await getTask(product, { ...base(), taskId: doomedBoard })).status).toBe('not_found');
    expect((await getTaskDetail(product, { ...base(), taskId: doomedBoard })).status).toBe('not_found');

    const ids = ok(await listTasks(product, { ...base() })).tasks.map((t) => t.taskId);
    expect(ids).toEqual([kept]);

    const b = ok(await getTaskBoard(product, { ...base() })).board;
    // A deleted draft is GONE, not off-board-but-pending: telling the owner preview work exists that they cannot
    // reach from anywhere is worse than saying nothing.
    expect(b.draftsOffBoard).toBe(0);
    const onBoard = b.buckets.flatMap((bucket) => bucket.tasks).map((t) => t.task.taskId);
    expect(onBoard).toContain(kept);
    expect(onBoard).not.toContain(doomedBoard);

    // …while the evidence survives underneath.
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks`.execute(owner.kysely)).rows[0]?.n).toBe(3);
    expect(await deletions()).toHaveLength(2);
  });

  test('a deleted DRAFT cannot be confirmed onto the board, and writes no task.created', async () => {
    // Review-pass finding: planTask read through findById, so a deleted draft could still be planned — succeeding,
    // emitting `task.created`, and then being filtered out of every board read. An audit trail claiming a task was
    // put on the board when it can never appear there is worse than no trail.
    const id = await taskInState('draft');
    expect((await deleteTask(product, { ...base(), taskId: id, confirmed: true })).status).toBe('ok');
    expect((await planTask(product, { ...base(), taskId: id })).status).toBe('not_found');
    expect(await auditFor('task.created')).toHaveLength(0);
    expect(await stateOf(id)).toBe('draft'); // untouched
  });

  test('a deleted task cannot become either end of a NEW dependency edge', async () => {
    // An edge pointing at a discarded task either blocks its dependent forever or quietly resolves as satisfied —
    // neither is something the caller can have meant.
    const live = await taskInState('planned');
    const gone = await taskInState('planned');
    expect((await deleteTask(product, { ...base(), taskId: gone, confirmed: true })).status).toBe('ok');
    expect((await addTaskDependency(product, { ...base(), taskId: live, dependsOnTaskId: gone })).status).toBe('not_found');
    expect((await addTaskDependency(product, { ...base(), taskId: gone, dependsOnTaskId: live })).status).toBe('not_found');
    expect((await sql<{ n: number }>`select count(*)::int as n from task_dependencies`.execute(owner.kysely)).rows[0]?.n).toBe(0);
  });

  // ── authorization + isolation ──────────────────────────────────────────────────────────────────────────
  test('a VIEWER may repeat but is REFUSED delete (PM ruling 2026-08-14); a non-member is forbidden and learns nothing', async () => {
    // NARROWED by ACBP-API-004: `task:delete` is owner-only. REPEAT is NOT narrowed and stays a member action —
    // it mints a task, which is what `task:create` already authorizes, and minting work is not destroying it.
    // Keeping both in one test pins the SPLIT: a future change that narrows repeat, or widens delete, has to
    // edit a line that states the distinction rather than quietly flipping a boolean.
    const forViewer = await taskInState('failed');
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect((await repeatTask(product, { ...viewer, taskId: forViewer })).status, 'repeat mints work — still a member action').toBe('ok');
    expect((await deleteTask(product, { ...viewer, taskId: forViewer, confirmed: true })).status, 'delete destroys planning work — owner only').toBe('forbidden');

    const outsider = { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1 };
    const target = await taskInState('failed');
    expect((await getTaskDetail(product, { ...outsider, taskId: target })).status).toBe('forbidden');
    expect((await repeatTask(product, { ...outsider, taskId: target })).status).toBe('forbidden');
    expect((await deleteTask(product, { ...outsider, taskId: target, confirmed: true })).status).toBe('forbidden');
  });

  test('cross-company: company B cannot see, repeat or delete company A’s task', async () => {
    const aTask = await taskInState('failed');
    const bScope = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    // `not_found`, never `forbidden` — a member of B is authorized in B; the task simply does not exist there.
    expect((await getTaskDetail(product, { ...bScope, taskId: aTask })).status).toBe('not_found');
    expect((await repeatTask(product, { ...bScope, taskId: aTask })).status).toBe('not_found');
    expect((await deleteTask(product, { ...bScope, taskId: aTask, confirmed: true })).status).toBe('not_found');
    expect(await deletions()).toHaveLength(0);
    expect(await stateOf(aTask)).toBe('failed');
  });

  // ── audit-or-nothing (ADR-015) ─────────────────────────────────────────────────────────────────────────
  test('audit-or-nothing: a failing audit write rolls the deletion record back entirely', async () => {
    const id = await taskInState('completed');
    const exploding = async (_scope: AuditScope): Promise<string> => {
      await Promise.resolve();
      throw new Error('audit sink down');
    };
    await expect(deleteTask(product, { ...base(), taskId: id, confirmed: true }, { auditWriter: exploding })).rejects.toThrow();
    // Neither half survived — the task is NOT quietly deleted with no audit trail.
    expect(await deletions()).toHaveLength(0);
    expect(await auditFor('task.deleted')).toHaveLength(0);
    expect((await getTask(product, { ...base(), taskId: id })).status).toBe('ok');
  });

  test('audit-or-nothing: a failing audit write rolls the repeated task back entirely', async () => {
    const src = await taskInState('failed');
    const before = (await sql<{ n: number }>`select count(*)::int as n from tasks`.execute(owner.kysely)).rows[0]?.n;
    const exploding = async (_scope: AuditScope): Promise<string> => {
      await Promise.resolve();
      throw new Error('audit sink down');
    };
    await expect(repeatTask(product, { ...base(), taskId: src }, { auditWriter: exploding })).rejects.toThrow();
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks`.execute(owner.kysely)).rows[0]?.n).toBe(before);
    expect(await auditFor('task.repeated')).toHaveLength(0);
  });

  // ── the repeat→plan→board round trip ───────────────────────────────────────────────────────────────────
  test('a repeated task reaches the board through the normal confirm path, carrying its lineage', async () => {
    const src = await taskInState('failed');
    const r = await repeatTask(product, { ...base(), taskId: src });
    const newId = (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
    // It is a draft like any other new task — it appears only once confirmed.
    expect((await planTask(product, { ...base(), taskId: newId })).status).toBe('ok');
    const detail = await getTaskDetail(product, { ...base(), taskId: newId });
    const d = (detail as { status: 'ok'; task: { state: string; repeatedFromTaskId: string | null } }).task;
    expect(d.state).toBe('planned');
    expect(d.repeatedFromTaskId).toBe(src);
  });

  async function stateOf(id: string): Promise<string | undefined> {
    return (await sql<{ state: string }>`select state from tasks where id = ${id}::uuid`.execute(owner.kysely)).rows[0]?.state;
  }

  // ── FAILURE DETAIL (ACBP-P5-013; TASK-006 "no blank failures") ────────────────────────────────────────────
  describe('the detail carries the latest run failure', () => {
    /** A run for this task, ended in the given state as the OWNER role. */
    async function runEndedAs(taskId: string, state: string, category: string | null, attempt = 1): Promise<void> {
      await sql`
        insert into task_runs (account_id, company_id, task_id, attempt, state, failure_category, started_at, ended_at)
        values (${w.accountA}, ${w.companyA1}, ${taskId}::uuid, ${attempt}, ${state}, ${category}, now(), now())
      `.execute(owner.kysely);
    }

    test('a FAILED run renders a COMPLETE detail — category, summary, attempts, retry safety', async () => {
      const taskId = await taskInState('failed');
      await runEndedAs(taskId, 'failed', 'timeout', 2);
      const r = await getTaskDetail(product, { ...base(), taskId });
      const failure = (r as { task: { latestFailure: { category: string; summary: string } | null } }).task.latestFailure;
      // D5. This expected `'scheduled'`, a value the contract does not have. `NextAttempt` was renamed to
      // `retry_eligible` during P5-013's own review, precisely because nothing re-runs a failed task yet — no retry
      // trigger exists and `startRun` has no production caller — so `scheduled` would promise the founder a future
      // event that never arrives (CDR-059 G4, "honest about the future"). The product was corrected; this was not.
      // `toMatchObject` compares a plain literal, so nothing type-checked the stale value against `NextAttempt`.
      expect(failure).toMatchObject({ category: 'timeout', attemptsUsed: 2, retrySafety: 'safe', nextAttempt: 'retry_eligible' });
      // Pin MEMBERSHIP of the closed set too, so the next invented value fails here rather than in a reviewer's eye.
      expect(NEXT_ATTEMPT_VALUES).toContain((failure as unknown as { nextAttempt: string }).nextAttempt);
      expect((failure?.summary ?? '').length).toBeGreaterThan(10);
    });

    test('A FAILED RUN WITH NO RECORDED CATEGORY IS unknown, NOT BLANK — the whole point of TASK-006', async () => {
      // The row a crash between the transition and the category write leaves behind. It is reachable in production,
      // so it is reachable here: written directly, because no use case would produce it deliberately.
      const taskId = await taskInState('failed');
      await runEndedAs(taskId, 'failed', null);
      const r = await getTaskDetail(product, { ...base(), taskId });
      const failure = (r as { task: { latestFailure: { category: string; summary: string } | null } }).task.latestFailure;
      expect(failure?.category).toBe('unknown');
      expect(failure?.summary ?? '').not.toBe('');
    });

    test('a task whose LATEST run succeeded has NO failure detail, even if an earlier one failed', async () => {
      // Showing the old failure would answer "what is wrong with this task" with something that is no longer true.
      const taskId = await taskInState('completed');
      await runEndedAs(taskId, 'failed', 'provider_error', 1);
      await runEndedAs(taskId, 'succeeded', null, 2);
      const r = await getTaskDetail(product, { ...base(), taskId });
      expect((r as { task: { latestFailure: unknown } }).task.latestFailure).toBeNull();
    });

    test('a NON-FAILED task with no runs has no failure detail', async () => {
      const r = await getTaskDetail(product, { ...base(), taskId: await taskInState('draft') });
      expect((r as { task: { latestFailure: unknown } }).task.latestFailure).toBeNull();
    });

    test('A FAILED TASK WITH NO RUN AT ALL STILL EXPLAINS ITSELF - the case the first test dodged', async () => {
      // Review pass 1 caught this precisely: the original test used 'draft', so the task-state/run-state pairing was
      // never checked for absence. One word - 'failed' - exposes it. A task can reach 'failed' with no run (the
      // transition is legal on its own), and that put it in the board's failed bucket with a blank explanation.
      const r = await getTaskDetail(product, { ...base(), taskId: await taskInState('failed') });
      const failure = (r as { task: { latestFailure: { category: string; summary: string } | null } }).task.latestFailure;
      expect(failure?.category).toBe('unknown');
      expect(failure?.summary ?? '').not.toBe('');
    });

    test('a FAILED task whose latest run is still RUNNING explains itself from the failed attempt', async () => {
      // attempt 1 failed, attempt 2 is in flight. listForTask orders by attempt desc, so runs[0] is the RUNNING one
      // and the naive read returned null - a blank failure on a task the board shows as failed.
      const taskId = await taskInState('failed');
      await runEndedAs(taskId, 'failed', 'provider_error', 1);
      await sql`insert into task_runs (account_id, company_id, task_id, attempt, state, started_at) values (${w.accountA}, ${w.companyA1}, ${taskId}::uuid, 2, 'running', now())`.execute(owner.kysely);
      const r = await getTaskDetail(product, { ...base(), taskId });
      const failure = (r as { task: { latestFailure: { category: string } | null } }).task.latestFailure;
      expect(failure?.category).toBe('provider_error');
    });
  });
});
