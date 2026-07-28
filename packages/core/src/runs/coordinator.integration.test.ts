// ACBP-P5-002 / CDR-053 — real-PostgreSQL proof of the workflow coordinator, through the RESTRICTED role.
//
// Acceptance clause, all three halves: **"Cancel queued instant; running safe-stop bounded; timeout works"**. Each is
// demonstrated against a real database rather than asserted about a constant.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { TaskRunRepository, TaskRepository, type DatabaseClient } from '@acbp/database';
import { DEFAULT_HEARTBEAT_GRACE_MS } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask, deleteTask } from '../tasks/index.js';
import { startRun, heartbeatRun, succeedRun, failRun, cancelRun, reclaimLostRuns } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('workflow coordinator (real PostgreSQL, restricted role) — ACBP-P5-002/CDR-053', () => {
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

  function ok<T extends { readonly status: string }>(r: T): Extract<T, { readonly status: 'ok' }> {
    expect(r.status).toBe('ok');
    return r as Extract<T, { readonly status: 'ok' }>;
  }

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const runRows = async () => owner.kysely.selectFrom('task_runs').selectAll().execute();
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();

  async function draftTask(): Promise<string> {
    const r = await createTask(product, { ...base(), title: 'Research five prospects', description: null, milestoneId: null });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
  }

  /**
   * Advance a task through its own guarded update. There is no `planned → queued` USE CASE yet — that belongs to the
   * ticket that owns dispatch — but the app role holds the `(state, updated_at)` column grant, so the fixture can
   * legitimately do what that use case will do.
   */
  async function setTaskState(taskId: string, from: string, to: string): Promise<void> {
    const n = await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, from, to));
    expect(n).toBe(1);
  }

  /** A task in `queued` — the state a coordinator actually picks up from, and the only one most of these tests want. */
  async function newTask(): Promise<string> {
    const taskId = await draftTask();
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    await setTaskState(taskId, 'planned', 'queued');
    return taskId;
  }

  /** Claim an attempt WITHOUT starting it: a genuinely queued run, which is what a coordinator produces before pickup. */
  async function queuedRun(taskId: string, attempt: number): Promise<string> {
    const claimed = await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
      new TaskRunRepository(db).claimAttempt({ accountId: w.accountA, companyId: w.companyA1, taskId, attempt }),
    );
    expect(claimed?.state).toBe('queued');
    return claimed?.id ?? '';
  }

  /**
   * Block until some backend is waiting on a lock held by `pid`.
   *
   * This is what makes the race test DETERMINISTIC rather than timing-dependent, and it THROWS if nothing ever blocks
   * — so the test can never quietly degrade into proving the ordinary running-cancel path instead of the race.
   */
  async function waitForBlockedBy(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from pg_locks l where not l.granted and ${pid}::int = any (pg_blocking_pids(l.pid))
      `.execute(owner.kysely);
      if ((r.rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('nothing ever blocked on the held lock — the race was not reproduced');
  }

  // ── the happy path ────────────────────────────────────────────────────────────────────────────────────────
  test('a run starts, heartbeats and succeeds, stamped with the caller\'s tenancy', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    expect(started.run.state).toBe('running');
    expect(started.run.attempt).toBe(1);

    const beat = ok(await heartbeatRun(product, { ...base(), runId: started.run.id }));
    expect(beat.stopRequested).toBe(false);

    const done = ok(await succeedRun(product, { ...base(), runId: started.run.id }));
    expect(done.run.state).toBe('succeeded');

    const row = (await runRows())[0];
    expect(row?.account_id).toBe(w.accountA);
    expect(row?.company_id).toBe(w.companyA1);
    expect(row?.ended_at).not.toBeNull();
    expect(await auditFor('task.started')).toHaveLength(1);
  });

  test('an attempt number is claimed ONCE — a second claimant is told, not given a duplicate', async () => {
    const taskId = await newTask();
    ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    expect((await startRun(product, { ...base(), taskId, attempt: 1 })).status).toBe('attempt_taken');
    expect(await runRows()).toHaveLength(1);
    // A retry uses the NEXT attempt number, and that is a different run.
    const second = ok(await startRun(product, { ...base(), taskId, attempt: 2 }));
    expect(second.run.attempt).toBe(2);
    expect(await runRows()).toHaveLength(2);
  });

  // ── ACCEPTANCE 1: "cancel queued instant" ─────────────────────────────────────────────────────────────────
  test('CANCEL QUEUED IS INSTANT — the run is terminal immediately, with no worker consulted', async () => {
    const taskId = await newTask();
    const runId = await queuedRun(taskId, 1);
    const r = await cancelRun(product, { ...base(), runId });
    expect(r.status).toBe('cancelled');
    const row = (await runRows())[0];
    expect(row?.state).toBe('cancelled');
    expect(row?.ended_at).not.toBeNull();
    // No stop request was needed — there was nothing running to ask.
    expect(row?.stop_requested_at).toBeNull();
    const events = await auditFor('task.cancelled');
    expect(events[0]?.payload).toMatchObject({ phase: 'queued' });
  });

  // ── ACCEPTANCE 2: "running safe-stop bounded" ─────────────────────────────────────────────────────────────
  test('CANCEL RUNNING IS A BOUNDED SAFE-STOP — the run keeps running and the worker learns at its next heartbeat', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));

    const r = await cancelRun(product, { ...base(), runId: started.run.id });
    expect(r.status).toBe('stop_requested');

    // The run is STILL running: claiming otherwise would report work stopped before it actually had.
    const row = (await runRows())[0];
    expect(row?.state).toBe('running');
    expect(row?.stop_requested_at).not.toBeNull();

    // BOUNDED: the worker's next ordinary heartbeat carries the request. Nothing had to interrupt it mid-call.
    const beat = ok(await heartbeatRun(product, { ...base(), runId: started.run.id }));
    expect(beat.stopRequested).toBe(true);

    // The worker halts and reports; only then is the run terminal.
    ok(await succeedRun(product, { ...base(), runId: started.run.id }));
    expect((await runRows())[0]?.state).toBe('succeeded');
    expect((await auditFor('task.cancelled'))[0]?.payload).toMatchObject({ phase: 'running_safe_stop' });
  });

  test('asking to stop twice keeps the FIRST request time — "when was it asked for?" has one answer', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await cancelRun(product, { ...base(), runId: started.run.id });
    const first = (await runRows())[0]?.stop_requested_at;
    await cancelRun(product, { ...base(), runId: started.run.id });
    expect((await runRows())[0]?.stop_requested_at).toEqual(first);
  });

  // ── ACCEPTANCE 3: "timeout works" ─────────────────────────────────────────────────────────────────────────
  test('TIMEOUT WORKS — a run whose worker went silent past the grace is failed as worker_lost', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));

    // Age the heartbeat past the grace. Done in SQL because the run's liveness lives in the database, and faking it
    // in the caller would prove only that the caller can lie to itself.
    await sql`update task_runs set last_heartbeat_at = now() - interval '10 minutes', started_at = now() - interval '10 minutes' where id = ${started.run.id}::uuid`.execute(owner.kysely);

    const swept = ok(await reclaimLostRuns(product, { ...base() }));
    expect(swept.reclaimed).toEqual([started.run.id]);
    const row = (await runRows())[0];
    expect(row?.state).toBe('failed');
    expect(row?.failure_category).toBe('worker_lost');
    expect((await auditFor('task.failed'))[0]?.payload).toMatchObject({ failure_category: 'worker_lost' });
  });

  test('a LIVE run is never reclaimed — the sweep must not kill healthy work', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    ok(await heartbeatRun(product, { ...base(), runId: started.run.id }));
    expect(ok(await reclaimLostRuns(product, { ...base() })).reclaimed).toEqual([]);
    expect((await runRows())[0]?.state).toBe('running');
  });

  test('a heartbeat cannot revive a reclaimed run — the worker is told to stop', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await sql`update task_runs set last_heartbeat_at = now() - interval '10 minutes' where id = ${started.run.id}::uuid`.execute(owner.kysely);
    ok(await reclaimLostRuns(product, { ...base() }));
    // The worker comes back after the reclaim. It must NOT be able to carry on as if nothing happened.
    expect((await heartbeatRun(product, { ...base(), runId: started.run.id })).status).toBe('not_running');
    expect((await runRows())[0]?.state).toBe('failed');
  });

  // ── review pass 1 findings ────────────────────────────────────────────────────────────────────────────────
  test('cancelling a queued run that STARTS mid-race becomes a safe-stop, never a false "already terminal"', async () => {
    // The pass-1 HIGH, reproduced as a REAL interleaving rather than asserted about. Previously the guarded
    // queued→cancelled UPDATE would miss and the caller was told `already_terminal` — a lie about a RUNNING run, and
    // the worst kind: the owner believes their cancellation landed while the work carries on.
    //
    // The interleaving is made deterministic with a row lock instead of a sleep. A held-open transaction moves the run
    // to `running` WITHOUT committing, so under READ COMMITTED `cancelRun`'s read still sees `queued` while its
    // guarded UPDATE blocks on the lock. Committing then releases it, PostgreSQL re-checks the predicate against the
    // new row version, and the guard misses — exactly the race, every time.
    const taskId = await newTask();
    const runId = await queuedRun(taskId, 1);

    const pickup = await owner.kysely.startTransaction().execute();
    let cancelling: Promise<Awaited<ReturnType<typeof cancelRun>>> | undefined;
    try {
      await pickup.updateTable('task_runs').set({ state: 'running', started_at: new Date() }).where('id', '=', runId).execute();
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(pickup)).rows[0]?.pid ?? 0;
      cancelling = cancelRun(product, { ...base(), runId });
      await waitForBlockedBy(pid);
    } finally {
      await pickup.commit().execute();
    }

    const r = await cancelling;
    // Honest: the owner is told the stop was REQUESTED of a live run, not that it was already over.
    expect(r?.status).toBe('stop_requested');
    const row = (await runRows())[0];
    expect(row?.state).toBe('running');
    expect(row?.stop_requested_at).not.toBeNull();
    // And the event records the phase that actually happened.
    expect((await auditFor('task.cancelled'))[0]?.payload).toMatchObject({ phase: 'running_safe_stop' });
  });

  test('startRun REFUSES a bad attempt number with a typed status, not a constraint error', async () => {
    const taskId = await newTask();
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect((await startRun(product, { ...base(), taskId, attempt })).status).toBe('invalid_attempt');
    }
    expect(await runRows()).toHaveLength(0);
  });

  test('startRun on a FOREIGN or absent task is task_not_found, not an opaque FK error', async () => {
    const taskId = await newTask();
    // Company B cannot start a run against company A's task — and learns nothing about whether it exists.
    const foreign = await startRun(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, taskId, attempt: 1 });
    expect(foreign.status).toBe('task_not_found');
    const absent = await startRun(product, { ...base(), taskId: '00000000-0000-4000-8000-000000000000', attempt: 1 });
    expect(absent.status).toBe('task_not_found');
    expect(await runRows()).toHaveLength(0);
  });

  // ── review pass 2: the coordinator must not start work that is over ───────────────────────────────────────
  test('startRun REFUSES a DELETED task — the AI never begins work the owner discarded', async () => {
    // The pass-2 HIGH. `tasks` has no DELETE grant, so a deleted task's row survives; a raw id lookup finds it and the
    // coordinator would put it straight into `running`. The probe reads through `findLive` for exactly this reason.
    const taskId = await newTask();
    expect((await deleteTask(product, { ...base(), taskId, confirmed: true })).status).toBe('ok');

    const r = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(r.status).toBe('task_not_found');
    expect(await runRows()).toHaveLength(0);
    // Nothing was claimed, so nothing was audited as started either.
    expect(await auditFor('task.started')).toHaveLength(0);
  });

  test('startRun REFUSES a task that cannot be executing — terminal, or never queued', async () => {
    const cancelled = await newTask();
    await setTaskState(cancelled, 'queued', 'cancelled');
    expect(await startRun(product, { ...base(), taskId: cancelled, attempt: 1 })).toEqual({ status: 'task_not_startable', taskState: 'cancelled' });

    // A draft task has never been queued: no worker was ever asked to run it.
    const draft = await draftTask();
    expect(await startRun(product, { ...base(), taskId: draft, attempt: 1 })).toEqual({ status: 'task_not_startable', taskState: 'draft' });

    // But `running` IS startable — that is a retry attempt while the task itself stays running.
    const running = await newTask();
    await setTaskState(running, 'queued', 'running');
    expect((await startRun(product, { ...base(), taskId: running, attempt: 1 })).status).toBe('ok');
    expect(await runRows()).toHaveLength(1);
  });

  // ── the state machine and the store ───────────────────────────────────────────────────────────────────────
  test('a QUEUED run cannot succeed — it never ran, so it has no outcome to report', async () => {
    const taskId = await newTask();
    const runId = await queuedRun(taskId, 1);
    expect((await succeedRun(product, { ...base(), runId })).status).toBe('not_running');
  });

  test('a terminal run stays terminal — nothing reopens a finished attempt', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    ok(await succeedRun(product, { ...base(), runId: started.run.id }));
    expect((await succeedRun(product, { ...base(), runId: started.run.id })).status).toBe('not_running');
    expect((await failRun(product, { ...base(), runId: started.run.id, failureCategory: 'timeout' })).status).toBe('not_running');
    expect((await cancelRun(product, { ...base(), runId: started.run.id })).status).toBe('already_terminal');
  });

  test('failing REQUIRES a category and succeeding REFUSES one — a row must not contradict its own state', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    expect((await failRun(product, { ...base(), runId: started.run.id })).status).toBe('invalid');
    expect((await succeedRun(product, { ...base(), runId: started.run.id, failureCategory: 'timeout' })).status).toBe('invalid');
    expect((await runRows())[0]?.state).toBe('running');
  });

  test('the database refuses a failure category on a non-failed run, and an unregistered category', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update task_runs set failure_category = 'timeout' where id = ${started.run.id}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update task_runs set state = 'failed', failure_category = 'Error: socket hang up' where id = ${started.run.id}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('the duplicate attempt is refused by the DATABASE, not only by the repository', async () => {
    const taskId = await newTask();
    ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${taskId}::uuid, 1)`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
  });

  test('identity, tenancy, task linkage and attempt are IMMUTABLE to the app role', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    for (const stmt of ['company_id = ' + `'${w.companyB1}'::uuid`, 'attempt = 99']) {
      await expect(
        asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
          sql`update task_runs set ${sql.raw(stmt)} where id = ${started.run.id}::uuid`.execute(db),
        ),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    }
  });

  test('there is NO DELETE — a run is the record that an attempt happened', async () => {
    const taskId = await newTask();
    ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`delete from task_runs`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect(await runRows()).toHaveLength(1);
  });

  // ── tenancy and authorization ─────────────────────────────────────────────────────────────────────────────
  test('a run is invisible from another company, and a foreign task cannot be run', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    const foreign = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    expect((await heartbeatRun(product, { ...foreign, runId: started.run.id })).status).toBe('not_running');
    expect((await succeedRun(product, { ...foreign, runId: started.run.id })).status).toBe('not_found');
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await new TaskRunRepository(db).findById(started.run.id)).toBeUndefined();
    });
  });

  test('a VIEWER can neither execute nor cancel — both actions are owner-only', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    const asViewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect((await startRun(product, { ...asViewer, taskId, attempt: 2 })).status).toBe('forbidden');
    expect((await heartbeatRun(product, { ...asViewer, runId: started.run.id })).status).toBe('forbidden');
    expect((await cancelRun(product, { ...asViewer, runId: started.run.id })).status).toBe('forbidden');
    expect((await reclaimLostRuns(product, asViewer)).status).toBe('forbidden');
    expect(await runRows()).toHaveLength(1);
  });

  test('the sweep judges every run against ONE instant, and never touches another company\'s runs', async () => {
    const taskId = await newTask();
    const started = ok(await startRun(product, { ...base(), taskId, attempt: 1 }));
    await sql`update task_runs set last_heartbeat_at = now() - interval '10 minutes' where id = ${started.run.id}::uuid`.execute(owner.kysely);
    // Company B sweeps: it must reclaim nothing, because A's run is not B's to judge.
    expect(ok(await reclaimLostRuns(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 })).reclaimed).toEqual([]);
    expect((await runRows())[0]?.state).toBe('running');
    // A sweeps with an explicit `now` — the same instant for the whole batch (see the grace note in CDR-053 §3-G4).
    const fixedNow = new Date(Date.now());
    expect(ok(await reclaimLostRuns(product, { ...base() }, { now: fixedNow, heartbeatGraceMs: DEFAULT_HEARTBEAT_GRACE_MS })).reclaimed).toEqual([started.run.id]);
  });
});
