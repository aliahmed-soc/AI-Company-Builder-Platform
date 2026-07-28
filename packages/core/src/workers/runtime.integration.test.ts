// ACBP-P5-005 / CDR-057 — real-PostgreSQL proof of the worker runtime, through the RESTRICTED role.
//
// The ticket's whole point is that WORK-006's *"disable during execution triggers safe-stop"* stops being an
// unmet clause (`CDR-056 §6`) and becomes a thing that happens. These tests are what makes that claim checkable:
// the budget halt, the duration halt, and a disable landing on a run that is ALREADY EXECUTING.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Logger } from '@acbp/observability';
import { sql } from 'kysely';
import { WorkerRunRepository, TaskRunRepository, TaskRepository, type DatabaseClient } from '@acbp/database';
import { DEFAULT_MAX_SPEND_MICROS, DEFAULT_MAX_DURATION_MS, WORKER_RUN_OUTCOMES, HALT_REASONS, RUN_FAILURE_CATEGORIES } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun, reclaimLostRuns } from '../runs/index.js';
import { setCompanyWorkerState } from './registry.js';
import { startWorkerRun, runWorkerStep, finishWorkerRun } from './runtime.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('worker runtime (real PostgreSQL, restricted role) — ACBP-P5-005/CDR-057', () => {
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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  /** Register a definition as the OWNER role — there is no runtime write grant (CDR-056 §2-G1). */
  async function register(workerId: string, version: number, tools: readonly string[], bounds: { spend?: number; duration?: number } = {}): Promise<void> {
    await sql`
      insert into worker_definitions
        (worker_id, version, capabilities, allowed_tools, input_schema_ref, output_schema_ref,
         max_spend_micros, max_duration_ms, retry_categories, approval_threshold_risk_class,
         model_task_class, logging_redaction_class, status)
      values
        (${workerId}, ${version}, array['market_research']::text[], ${sql.raw(`array[${tools.map((t) => `'${t}'`).join(',')}]::text[]`)},
         'research.input@1', 'research.output@1', ${bounds.spend ?? DEFAULT_MAX_SPEND_MICROS}, ${bounds.duration ?? DEFAULT_MAX_DURATION_MS},
         array['timeout','provider_error']::text[], null,
         'generation', 'standard', 'active')
    `.execute(owner.kysely);
  }

  /** A task carried to a RUNNING run — the only state a worker may be stamped onto. */
  async function runningRun(): Promise<string> {
    const t = await createTask(product, { ...base(), title: 'Research the market', description: null, milestoneId: null });
    const taskId = (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    // planned -> queued has no use case yet (it belongs to the ticket that owns dispatch), but the app role holds
    // the column grant, so the fixture legitimately does what that use case will do.
    const moved = await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    expect(moved).toBe(1);
    const r = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; run: { id: string } }).run.id;
  }

  const rows = async () => owner.kysely.selectFrom('worker_runs').selectAll().execute();
  const auditRows = async () => owner.kysely.selectFrom('audit_events').selectAll().orderBy('event_id').execute();
  const auditNames = async () => (await auditRows()).map((r) => r.name);
  const step = (micros: number) => () => Promise.resolve({ spentMicros: micros });

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from company_worker_states`.execute(owner.kysely);
    await sql`delete from worker_definitions`.execute(owner.kysely);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
    await sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('web_research', 1, 'informational', 'fixture'), ('memory_read', 1, 'internal_reversible', 'fixture'), ('send_email', 1, 'external_reversible', 'fixture')`.execute(owner.kysely);
    await register('research', 1, ['web_research', 'memory_read']);
  });

  // ── THE STAMP ─────────────────────────────────────────────────────────────────────────────────────────────
  test('a worker is STAMPED onto a run, with its VERSION and its bounds SNAPSHOT', async () => {
    const runId = await runningRun();
    const started = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    expect(started).toMatchObject({ status: 'ok' });
    const wr = (started as { workerRun: { workerId: string; workerVersion: number; maxSpendMicros: number } }).workerRun;
    expect(wr).toMatchObject({ workerId: 'research', workerVersion: 1, maxSpendMicros: DEFAULT_MAX_SPEND_MICROS, spendMicros: 0, stepsCompleted: 0, outcome: 'running' });
    expect((await rows())[0]?.task_run_id).toBe(runId);
  });

  test('the bounds are a SNAPSHOT: editing the definition mid-flight does not move the budget', async () => {
    // CDR-057 §1-G2. If the runtime re-read the definition on each step, an owner raising a cap would retroactively
    // change what a running attempt was judged against — and the record would stop saying what was enforced.
    const runId = await runningRun();
    const started = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;

    await register('research', 2, ['web_research'], { spend: 9_999_999 });
    const after = await runWorkerStep(product, { ...base(), workerRunId: id, step: step(1) });
    expect((after as { workerRun: { maxSpendMicros: number } }).workerRun.maxSpendMicros).toBe(DEFAULT_MAX_SPEND_MICROS);
  });

  test('ONE worker per attempt — a second stamp is refused, not silently accepted', async () => {
    const runId = await runningRun();
    const first = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    const again = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    expect(again.status).toBe('already_stamped');
    expect((again as { workerRun: { id: string } }).workerRun.id).toBe((first as { workerRun: { id: string } }).workerRun.id);
    expect(await rows()).toHaveLength(1);
  });

  test('a worker is NOT stamped onto a run that is not running, nor onto a run that does not exist', async () => {
    const runId = await runningRun();
    await new TaskRunRepository(owner.kysely).transition({ runId, expectedState: 'running', nextState: 'succeeded' });
    expect((await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' })).status).toBe('run_not_running');
    expect((await startWorkerRun(product, { ...base(), taskRunId: '00000000-0000-4000-8000-000000000000', workerId: 'research' })).status).toBe('run_not_found');
    expect(await rows()).toHaveLength(0);
  });

  test('a PAUSED or DISABLED worker is never stamped onto new work (WORK-006)', async () => {
    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused' });
    expect(await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' })).toMatchObject({ status: 'not_accepting', state: 'paused' });
    expect(await rows()).toHaveLength(0);
  });

  test('a worker whose allowlist reaches PAST the MVP ceiling may exist but may not RUN (CDR-056 §6-G8)', async () => {
    await register('outreach', 1, ['web_research', 'send_email']);
    const r = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'outreach' });
    expect(r).toMatchObject({ status: 'mvp_boundary_violation', offendingTools: ['send_email'] });
    expect(await rows()).toHaveLength(0);
  });

  // ── THE BUDGET HALT (NFR-015) ─────────────────────────────────────────────────────────────────────────────
  test('BUDGET EXHAUSTION halts the run, and the overshoot is ONE step — never more', async () => {
    // NFR-015: *"a runaway task cannot exceed its budget by more than one billing increment"*. The step that crosses
    // the line is allowed to finish; the NEXT one is refused. That is the whole bound, and it only holds because the
    // check runs BEFORE the step rather than after it.
    await register('tight', 1, ['web_research'], { spend: 1_000 });
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'tight' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;

    // One enormous step: it is admitted (there was headroom), and it lands far past the cap.
    const over = await runWorkerStep(product, { ...base(), workerRunId: id, step: step(750_000) });
    expect(over.status).toBe('ok');
    expect((over as { workerRun: { spendMicros: number } }).workerRun.spendMicros).toBe(750_000);

    // ...and the run is now over. It does not get to spend a second increment.
    const halted = await runWorkerStep(product, { ...base(), workerRunId: id, step: step(750_000) });
    expect(halted).toMatchObject({ status: 'halted', reason: 'budget_exhausted' });
    expect((halted as { workerRun: { outcome: string; failureCategory: string | null } }).workerRun).toMatchObject({ outcome: 'failed', failureCategory: 'policy_blocked', haltReason: 'budget_exhausted' });
    expect((await rows())[0]?.spend_micros).toBe(750_000);
  });

  test('a halted run STAYS halted — a later step neither runs nor moves the counters', async () => {
    await register('tight', 1, ['web_research'], { spend: 1_000 });
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'tight' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    await runWorkerStep(product, { ...base(), workerRunId: id, step: step(5_000) });
    await runWorkerStep(product, { ...base(), workerRunId: id, step: step(5_000) });

    let ran = false;
    const after = await runWorkerStep(product, { ...base(), workerRunId: id, step: () => { ran = true; return Promise.resolve({ spentMicros: 5_000 }); } });
    expect(after).toMatchObject({ status: 'not_running', outcome: 'failed' });
    expect(ran).toBe(false); // THE STEP NEVER EXECUTED — the guard is not merely a status code.
    expect((await rows())[0]?.spend_micros).toBe(5_000);
  });

  // ── THE DURATION HALT ─────────────────────────────────────────────────────────────────────────────────────
  test('DURATION OVERRUN halts with `timeout` — the category canon names for it', async () => {
    // AI-AND-WORKER-ARCHITECTURE: *"wall-clock bound; overrun → safe-stop → failed(`timeout`)"*. The bound is tiny
    // rather than the clock being injected: elapsed time now comes from the DATABASE (review pass 2 — mixing Node's
    // clock with a Postgres `now()` makes it wrong, and negative skew would halt a healthy run as "unreadable"), so
    // the honest way to prove an overrun is to set a bound a real millisecond can exceed.
    await register('slow', 1, ['web_research'], { duration: 1 });
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'slow' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;

    await new Promise((resolve) => setTimeout(resolve, 30));
    const halted = await runWorkerStep(product, { ...base(), workerRunId: id, step: step(1) });
    expect(halted).toMatchObject({ status: 'halted', reason: 'duration_exceeded' });
    expect((halted as { workerRun: { failureCategory: string | null } }).workerRun.failureCategory).toBe('timeout');
    expect(RUN_FAILURE_CATEGORIES).toContain('timeout');
  });

  // ── THE SAFE STOP (WORK-006 — the clause CDR-056 §6 recorded as UNMET) ────────────────────────────────────
  test('DISABLING A WORKER MID-EXECUTION SAFE-STOPS ITS RUNNING WORK — the clause CDR-056 §6 left open', async () => {
    const runId = await runningRun();
    const started = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    expect((await runWorkerStep(product, { ...base(), workerRunId: id, step: step(10) })).status).toBe('ok');

    // The owner disables the worker WHILE it is executing. Before P5-005 this held only FUTURE work.
    const set = await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'disabled', reason: 'output looked wrong' });
    expect(set).toMatchObject({ status: 'ok', stopsRequested: 1 });

    // The request is DURABLE on the task run, so it survives a crash between the disable and the next step.
    expect((await new TaskRunRepository(owner.kysely).findById(runId))?.stop_requested_at).not.toBeNull();

    // ...and the very next step does not execute. The worker halts at a checkpoint, never mid-call.
    let ran = false;
    const stopped = await runWorkerStep(product, { ...base(), workerRunId: id, step: () => { ran = true; return Promise.resolve({ spentMicros: 999 }); } });
    expect(stopped.status).toBe('stopped');
    expect(ran).toBe(false);

    // A STOP IS NOT A FAILURE (CDR-057 §1-G7): the run did what it was told.
    const row = (await rows())[0];
    expect(row?.outcome).toBe('stopped');
    expect(row?.failure_category).toBeNull();
    expect(row?.spend_micros).toBe(10);
  });

  test('PAUSING safe-stops too, and RE-ENABLING requests no stops at all', async () => {
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    expect(started.status).toBe('ok');
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused' })).toMatchObject({ stopsRequested: 1 });
    // Re-enabling is not an emergency and must never disturb work: a stop it requested could not be taken back.
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'enabled' })).toMatchObject({ stopsRequested: 0 });
  });

  test('the sweep touches only THIS company and only THIS worker', async () => {
    // A disable is company-scoped by canon (WORK-006 is "granular"). One company disabling research must not stop
    // another's, and disabling research must not stop an unrelated worker's run.
    await register('analysis', 1, ['web_research']);
    const researchRun = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const analysisRun = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'analysis' });
    expect(analysisRun.status).toBe('ok');

    const otherCompany = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect(await setCompanyWorkerState(product, { ...otherCompany, workerId: 'research', state: 'disabled' })).toMatchObject({ status: 'ok', stopsRequested: 0 });
    expect((await runWorkerStep(product, { ...base(), workerRunId: (researchRun as { workerRun: { id: string } }).workerRun.id, step: step(1) })).status).toBe('ok');

    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'disabled' });
    expect((await runWorkerStep(product, { ...base(), workerRunId: (analysisRun as { workerRun: { id: string } }).workerRun.id, step: step(1) })).status).toBe('ok');
  });

  test("another company cannot see, step, or stop this company's worker run", async () => {
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    const intruder = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    // Absent, not forbidden: RLS makes another company's row invisible rather than answering questions about it.
    expect(await runWorkerStep(product, { ...intruder, workerRunId: id, step: step(1) })).toEqual({ status: 'not_found' });
    // The safe-stop SWEEP reads through the same policy, so a disable in company B can never reach company A's work.
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await new WorkerRunRepository(db).listRunningForWorker('research')).toEqual([]);
    });
    expect(await finishWorkerRun(product, { ...intruder, workerRunId: id, outcome: 'succeeded' })).toEqual({ status: 'not_found' });
    expect((await rows()).find((r) => r.id === id)?.outcome).toBe('running');
  });

  // ── THE HIGH FINDING: a run must never become UNSTOPPABLE ─────────────────────────────────────────────────
  test('a worker run whose TASK RUN is over stops at its next step — it does not keep spending', async () => {
    // Review pass 1's HIGH. The first version read the task run and consulted only `stop_requested_at`, ignoring its
    // STATE. A task run reclaimed as `worker_lost` (or failed by its owner) is no longer `running`, so `requestStop`
    // — guarded on `running` — can never mark it again: the safe-stop sweep would report reaching NOTHING while this
    // worker carried on spending, possibly beside a retry attempt. Every test passed because `runningRun()` only
    // ever made live task runs. That is the same shape as the P5-002 defect, and this is the test that forbids it.
    const runId = await runningRun();
    const started = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    await new TaskRunRepository(owner.kysely).transition({ runId, expectedState: 'running', nextState: 'failed', failureCategory: 'worker_lost' });

    let ran = false;
    const after = await runWorkerStep(product, { ...base(), workerRunId: id, step: () => { ran = true; return Promise.resolve({ spentMicros: 500 }); } });
    expect(after.status).toBe('stopped');
    expect(ran).toBe(false);
    expect((await rows())[0]).toMatchObject({ outcome: 'stopped', spend_micros: 0 });
  });

  test('a worker DISABLED between the start and the next step stops, even with no stop request on the run', async () => {
    // The write-skew case: a disable committing concurrently with a start sees no uncommitted worker run to sweep,
    // so that run would begin life with nothing asking it to stop. Re-reading the worker state at the checkpoint is
    // what closes it — the state, not just the stop flag, is a reason to halt.
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    await sql`update company_worker_states set state = 'disabled' where worker_id = 'research'`.execute(owner.kysely);
    await sql`insert into company_worker_states (account_id, company_id, worker_id, state, changed_by_user_id) values (${w.accountA}, ${w.companyA1}, 'research', 'disabled', ${w.aOwner}) on conflict do nothing`.execute(owner.kysely);

    let ran = false;
    const after = await runWorkerStep(product, { ...base(), workerRunId: id, step: () => { ran = true; return Promise.resolve({ spentMicros: 1 }); } });
    expect(after.status).toBe('stopped');
    expect(ran).toBe(false);
  });

  test('a run whose owner already asked it to stop is never stamped in the first place', async () => {
    const runId = await runningRun();
    await new TaskRunRepository(owner.kysely).requestStop(runId);
    expect((await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' })).status).toBe('run_not_running');
    expect(await rows()).toHaveLength(0);
  });

  test('a RECLAIMED attempt does not leave a zombie worker run in the safe-stop sweep', async () => {
    // Review pass 2. `reclaimLostRuns` ends the task run; without reaping, its worker run sat at `running` for ever —
    // no record of how it ended, and a permanent entry in "this worker's live runs" that a later disable would keep
    // finding. Both halves matter: the audit record and the sweep's honesty.
    const runId = await runningRun();
    await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    await sql`update task_runs set last_heartbeat_at = now() - interval '1 hour', started_at = now() - interval '1 hour' where id = ${runId}`.execute(owner.kysely);

    expect((await reclaimLostRuns(product, { ...base() })).status).toBe('ok');
    expect((await rows())[0]).toMatchObject({ outcome: 'failed', failure_category: 'worker_lost' });
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      expect(await new WorkerRunRepository(db).listRunningForWorker('research')).toEqual([]);
    });
    expect((await auditNames()).filter((n) => n === 'worker.failed')).toHaveLength(1);
  });

  // ── THE AUDIT TRAIL ITSELF ────────────────────────────────────────────────────────────────────────────────
  test('EVERY ending writes its audit row — start, halt, stop and finish', async () => {
    // Asserted against the table, not the factory. P5-003b lost auditing on exactly one path while every factory
    // unit test still passed, which is why the factories being tested is not evidence that they are CALLED.
    await register('tight', 1, ['web_research'], { spend: 1_000 });
    const s1 = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'tight' });
    const id1 = (s1 as { workerRun: { id: string } }).workerRun.id;
    await runWorkerStep(product, { ...base(), workerRunId: id1, step: step(9_000) });
    await runWorkerStep(product, { ...base(), workerRunId: id1, step: step(1) });

    const halt = (await auditRows()).find((r) => r.name === 'worker.failed');
    expect(halt?.subject_id).toBe(id1);
    expect(halt?.payload).toMatchObject({ worker_id: 'tight', worker_version: 1, run_outcome: 'failed', failure_category: 'policy_blocked', halt_reason: 'budget_exhausted' });
    expect(Object.values((halt?.payload ?? {}) as Record<string, unknown>).every((v) => v !== null)).toBe(true);

    const s2 = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id2 = (s2 as { workerRun: { id: string } }).workerRun.id;
    await finishWorkerRun(product, { ...base(), workerRunId: id2, outcome: 'succeeded' });

    const names = await auditNames();
    expect(names.filter((n) => n === 'worker.started')).toHaveLength(2);
    expect(names).toContain('worker.completed');
    expect((await auditRows()).find((r) => r.name === 'worker.completed')?.payload).toMatchObject({ run_outcome: 'succeeded' });
  });

  test('a SAFE-STOP is audited as completed-with-run_outcome-stopped, and the sweep audits task.cancelled', async () => {
    const runId = await runningRun();
    const started = await startWorkerRun(product, { ...base(), taskRunId: runId, workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'disabled' })).toMatchObject({ stopsRequested: 1 });

    // The sweep sets a durable stop on N task runs. Review pass 2: the first version did that with NO record at all —
    // an owner reading the trail would see the disable and not the stops it caused.
    const cancelled = (await auditRows()).find((r) => r.name === 'task.cancelled');
    expect(cancelled?.payload).toMatchObject({ phase: 'running_safe_stop' });

    await runWorkerStep(product, { ...base(), workerRunId: id, step: step(1) });
    const completed = (await auditRows()).find((r) => r.name === 'worker.completed');
    expect(completed?.payload).toMatchObject({ run_outcome: 'stopped' });
    expect(await auditNames()).not.toContain('worker.failed');
  });

  test('the budget halt ALERTS — NFR-015 says halt AND alert', async () => {
    // The `and alert` half was inert: nothing asserted the warn, so removing it would have gone unnoticed.
    await register('tight', 1, ['web_research'], { spend: 1_000 });
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'tight' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    await runWorkerStep(product, { ...base(), workerRunId: id, step: step(9_000) });

    const warnings: Array<{ event: string; metadata?: Record<string, unknown> }> = [];
    const logger = { debug() {}, info() {}, error() {}, warn: (event: string, f?: { metadata?: Record<string, unknown> }) => warnings.push({ event, ...(f ?? {}) }) };
    await runWorkerStep(product, { ...base(), workerRunId: id, step: step(1) }, { logger: logger as unknown as Logger });
    expect(warnings.map((warning) => warning.event)).toContain('worker.run_halted');
    expect(warnings[0]?.metadata).toMatchObject({ reason: 'budget_exhausted' });
  });

  // ── A STEP THAT THROWS ────────────────────────────────────────────────────────────────────────────────────
  test('a THROWING step is recorded as a provider_error, not rolled back into nothing', async () => {
    // Letting the throw propagate would undo the whole transaction, so a step that spent real provider money and
    // then failed would leave the counter untouched — and a caller retrying in a loop could spend for ever without
    // advancing toward the cap. The exception itself never reaches the caller or the record.
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    const r = await runWorkerStep(product, { ...base(), workerRunId: id, step: () => Promise.reject(new Error('provider exploded with a secret in the message')) });
    expect(r.status).toBe('step_failed');
    expect(JSON.stringify(r)).not.toContain('secret');
    expect((await rows())[0]).toMatchObject({ outcome: 'failed', failure_category: 'provider_error' });
    expect((await auditRows()).find((a) => a.name === 'worker.failed')?.payload).toMatchObject({ failure_category: 'provider_error' });
  });

  // ── FINISHING ─────────────────────────────────────────────────────────────────────────────────────────────
  test('finishing records the outcome once, and a finished run cannot be finished again', async () => {
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    expect((await finishWorkerRun(product, { ...base(), workerRunId: id, outcome: 'succeeded' })).status).toBe('ok');
    expect(await finishWorkerRun(product, { ...base(), workerRunId: id, outcome: 'failed', failureCategory: 'provider_error' })).toMatchObject({ status: 'not_running', outcome: 'succeeded' });
    expect((await rows())[0]?.ended_at).not.toBeNull();
  });

  test('a failure needs a category and a success refuses one — a row never contradicts its own outcome', async () => {
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    expect((await finishWorkerRun(product, { ...base(), workerRunId: id, outcome: 'failed' })).status).toBe('invalid');
    expect((await finishWorkerRun(product, { ...base(), workerRunId: id, outcome: 'succeeded', failureCategory: 'timeout' })).status).toBe('invalid');
    expect((await rows())[0]?.outcome).toBe('running');
  });

  // ── THE DATABASE'S OWN GUARANTEES ─────────────────────────────────────────────────────────────────────────
  test('the restricted role cannot rewrite the STAMP or the SNAPSHOT, and cannot delete a worker run', async () => {
    const started = await startWorkerRun(product, { ...base(), taskRunId: await runningRun(), workerId: 'research' });
    const id = (started as { workerRun: { id: string } }).workerRun.id;
    // ONE TRANSACTION PER ATTEMPT. Found by hosted CI on the first version of this test, which ran all six inside a
    // single `asRestricted` block: the first refusal aborts the transaction, so every statement after it fails with
    // `25P02` (transaction aborted) instead of `42501` — the test would have kept passing while proving only that the
    // FIRST column was protected. The values are type-correct too, so a uuid column is refused for the privilege and
    // not for the cast.
    const refused = async (statement: (db: Parameters<Parameters<typeof asRestricted>[2]>[0]) => Promise<unknown>): Promise<void> => {
      await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
        await expect(statement(db)).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
      });
    };
    const otherUuid = '00000000-0000-4000-8000-00000000beef';
    await refused((db) => sql`update worker_runs set worker_id = 'other' where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set worker_version = 7 where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set max_spend_micros = 7 where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set max_duration_ms = 7 where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set task_run_id = ${otherUuid} where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set company_id = ${otherUuid} where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set account_id = ${otherUuid} where id = ${id}`.execute(db));
    await refused((db) => sql`update worker_runs set started_at = now() where id = ${id}`.execute(db));
    await refused((db) => sql`delete from worker_runs where id = ${id}`.execute(db));
    expect((await rows())[0]).toMatchObject({ worker_id: 'research', worker_version: 1 });
  });

  test('the database refuses a nonsense outcome, a negative spend, and an unowned task run', async () => {
    const runId = await runningRun();
    await expect(sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms, outcome) values (${w.accountA}, ${w.companyA1}, ${runId}, 'research', 1, 100, 100, 'finished')`.execute(owner.kysely)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === CHECK_VIOLATION,
    );
    await expect(sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms, spend_micros) values (${w.accountA}, ${w.companyA1}, ${runId}, 'research', 1, 100, 100, -1)`.execute(owner.kysely)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === CHECK_VIOLATION,
    );
    // TENANT-PINNED: the composite FK is what stops a run being attached across a company boundary, because RI
    // checks always bypass RLS and a single-column FK would never be policy-checked at all.
    await expect(sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms) values (${w.accountB}, ${w.companyB1}, ${runId}, 'research', 1, 100, 100)`.execute(owner.kysely)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === FK_VIOLATION,
    );
  });

  test('a halt reason belongs only to a run that ended early, and the outcome set matches the contract', async () => {
    const runId = await runningRun();
    await expect(sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms, halt_reason) values (${w.accountA}, ${w.companyA1}, ${runId}, 'research', 1, 100, 100, 'budget_exhausted')`.execute(owner.kysely)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === CHECK_VIOLATION,
    );
    // SET EQUALITY, not one-directional containment: a class added to the contract and forgotten in the CHECK is
    // exactly the drift that was the finding on three consecutive tickets.
    const literalsIn = async (name: string, drop: readonly string[] = []): Promise<readonly string[]> => {
      const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`.execute(owner.kysely);
      const def = r.rows[0]?.def ?? '';
      expect(def).not.toBe('');
      return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').filter((v) => !drop.includes(v)).sort();
    };

    // SET EQUALITY on ALL THREE lists, not one-directional containment. A value added to a contract and forgotten in
    // the CHECK is the drift that was the finding on three consecutive tickets — and review pass 1 caught that only
    // the outcome list had this guard. `HALT_REASONS` exists as an ARRAY for exactly this: as a bare union type it
    // had no runtime form to compare against, so a fourth reason would have compiled, passed, and then broken the
    // halt path in production only.
    expect(await literalsIn('worker_runs_outcome_valid')).toEqual([...WORKER_RUN_OUTCOMES].sort());
    expect(await literalsIn('worker_runs_failure_category_valid', ['failed'])).toEqual([...RUN_FAILURE_CATEGORIES].sort());
    expect(await literalsIn('worker_runs_halt_reason_valid', ['failed', 'stopped'])).toEqual([...HALT_REASONS].sort());
  });
});
