// ACBP-P7-002 / CDR-079 — **LAUNCH GATE 14**: "deactivation blocks new autonomous work" (ACC-004, COMP-006 final;
// SECURITY-VERIFICATION-PLAN:23 threat row "zombie autonomous work"; RELEASE-GATES.md:10).
//
// ── WHY THIS FILE EXISTS, AND WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────
//
// Before this ticket, the evidence for invariant 16 was a green test named "pause blocks new autonomous-work
// pickup" that called a PURE PREDICATE on a returned value. It exercised no pickup path and would have stayed
// green while every scheduler in the codebase ignored company status forever — which, for the whole of Phases
// 1-6, is exactly what they did (CDR-079 §1.1).
//
// So every assertion here goes through a PRODUCTION USE CASE against real PostgreSQL under the restricted
// `acbp_app` role, and every refusal is confirmed AGAINST THE DATABASE — no run row, no job row, no checkpoint —
// rather than against the value the use case returned about itself. A function can lie about what it did; the
// absence of a row cannot.
//
// THE CONTROL CASE IS LOAD-BEARING. Without it, every refusal below would also pass against a fixture that could
// never start anything at all, which is the failure mode ACBP-P6-007's fixture-guard lesson is about.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — hosted CI is the only evidence for this file.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { InMemoryObjectStorage } from '@acbp/adapters';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany, resumeCompany, getCompany } from '../company/company-lifecycle.js';
import { createTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { enqueueJob } from '../jobs/index.js';
import { runJobStep } from '../jobs/checkpoint.js';
import { dispatchToolCall } from '../tools/dispatcher.js';
import { exportCompanyData } from '../exports/index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
/** Every non-active company state. Gate 14 names deactivation; canon blocks work at BOTH deactivation phases. */
const BLOCKING_STATES = ['paused', 'deactivating', 'deactivated'] as const;

describe.skipIf(!hasTestDatabase)('LAUNCH GATE 14 — no new autonomous work (real PostgreSQL) — ACBP-P7-002/CDR-079', () => {
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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  /** Put the company in a lifecycle state directly. The TRANSITIONS are a later slice; the GATE is this one. */
  const setCompanyStatus = async (status: string) => {
    await sql`update public.companies set status = ${status} where id = ${w.companyA1}::uuid`.execute(owner.kysely);
  };
  const setAccountStatus = async (status: string) => {
    await sql`update public.accounts set status = ${status} where id = ${w.accountA}::uuid`.execute(owner.kysely);
  };

  const runRows = async () => owner.kysely.selectFrom('task_runs').selectAll().where('company_id', '=', w.companyA1).execute();
  const jobRows = async () => owner.kysely.selectFrom('jobs').selectAll().where('company_id', '=', w.companyA1).execute();
  const checkpointRows = async () => owner.kysely.selectFrom('job_checkpoints').selectAll().where('company_id', '=', w.companyA1).execute();

  async function queuedTask(): Promise<string> {
    const created = await createTask(product, { ...base(), title: 'Research five prospects', description: null, milestoneId: null });
    expect(created.status).toBe('ok');
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    // No `planned → queued` use case exists yet (it belongs to the dispatch ticket), but the app role holds the
    // `(state, updated_at)` column grant, so the fixture does exactly what that use case will do.
    await sql`update public.tasks set state = 'queued', updated_at = now() where id = ${taskId}::uuid`.execute(owner.kysely);
    return taskId;
  }

  // ── the control ────────────────────────────────────────────────────────────────────────────────────────────

  test('CONTROL: an ACTIVE company starts a run, and the row lands', async () => {
    // If this ever fails, every refusal below is worthless — they would all be passing against a fixture that
    // cannot start anything. This is the assertion that makes the rest of the file mean something.
    const taskId = await queuedTask();
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    expect(await runRows()).toHaveLength(1);
  });

  // ── startRun ───────────────────────────────────────────────────────────────────────────────────────────────

  for (const status of BLOCKING_STATES) {
    test(`a ${status} company CANNOT start a run, and NO task_run row is created`, async () => {
      const taskId = await queuedTask();
      await setCompanyStatus(status);

      const refused = await startRun(product, { ...base(), taskId, attempt: 1 });
      expect(refused).toEqual({ status: 'company_not_active', reason: 'company_not_active' });
      // THE SUBSTANTIVE ASSERTION. The returned status is what the function says about itself; this is the
      // database saying no run exists. Only the second one is Gate 14.
      expect(await runRows()).toEqual([]);
    });
  }

  test('the refusal is `company_not_active`, NOT `task_not_startable` — the task is startable, the company is not', async () => {
    // Reusing that member would be a false statement and would send an operator to the task's state machine
    // instead of the company's lifecycle.
    //
    // THE POSITIVE ASSERTION CAME FIRST AFTER A MUTATION PROBE. An earlier version asserted only
    // `.not.toBe('task_not_startable')`, and that PASSED with the gate neutralised — because a successful `'ok'`
    // is also not `task_not_startable`. A negative-only assertion cannot fail in the direction it is named
    // after, which is the defect class this whole ticket exists to remove.
    const taskId = await queuedTask();
    await setCompanyStatus('paused');
    const refused = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(refused.status).toBe('company_not_active');
    expect(refused.status).not.toBe('task_not_startable');
    // And the task really IS startable — so the refusal is about the company and nothing else.
    const task = await owner.kysely.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirst();
    expect(task?.state).toBe('queued');
  });

  test('a refusal does NOT burn the attempt number — attempt 1 is still available after resuming', async () => {
    // The reason the gate sits before `claimAttempt`. A refusal that consumed an attempt would spend a task's
    // budget on a company that was never permitted to run.
    const taskId = await queuedTask();
    await setCompanyStatus('paused');
    expect((await startRun(product, { ...base(), taskId, attempt: 1 })).status).toBe('company_not_active');

    await setCompanyStatus('active');
    expect((await startRun(product, { ...base(), taskId, attempt: 1 })).status).toBe('ok');
  });

  // ── enqueueJob ─────────────────────────────────────────────────────────────────────────────────────────────

  test('a paused company CANNOT enqueue a job, and NO jobs row is created', async () => {
    await setCompanyStatus('paused');
    const refused = await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' }, idempotencyKey: 'k-blocked' });
    expect(refused).toEqual({ status: 'company_not_active', reason: 'company_not_active' });
    expect(await jobRows()).toEqual([]);
  });

  test('but a REPLAY of a job enqueued BEFORE the pause is still answered — not refused', async () => {
    // NFR-006 replay safety, and the whole reason the gate sits after the idempotency question (CDR-079 §6-G5).
    // The dedupe is INSERT-FIRST, so a naive gate would refuse a retry of a request that already succeeded, and
    // the caller could never learn their job exists — a control meant to stop NEW work breaking replay instead.
    const first = await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' }, idempotencyKey: 'k-replay' });
    expect(first.status).toBe('ok');
    const jobId = (first as { status: 'ok'; job: { id: string } }).job.id;

    await setCompanyStatus('paused');

    const replay = await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' }, idempotencyKey: 'k-replay' });
    expect(replay.status).toBe('ok');
    expect((replay as { status: 'ok'; deduplicated: boolean }).deduplicated).toBe(true);
    expect((replay as { status: 'ok'; job: { id: string } }).job.id).toBe(jobId);
    // And still exactly ONE job: the replay answered, it did not create.
    expect(await jobRows()).toHaveLength(1);
  });

  // ── runJobStep ─────────────────────────────────────────────────────────────────────────────────────────────

  test('a paused company CANNOT run a new job step, and NO checkpoint is written', async () => {
    const enqueued = await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' }, idempotencyKey: 'k-step' });
    expect(enqueued.status).toBe('ok');
    const jobId = (enqueued as { status: 'ok'; job: { id: string } }).job.id;

    await setCompanyStatus('paused');

    let stepRan = false;
    const refused = await runJobStep(product, {
      ...base(),
      jobId,
      stepName: 'fetch',
      step: () => {
        stepRan = true;
        return Promise.resolve({ done: true });
      },
    });
    expect(refused).toEqual({ status: 'company_not_active', reason: 'company_not_active' });
    // THE STEP CLOSURE IS THE WORK. A refusal that still ran it would have done the very thing being refused.
    expect(stepRan).toBe(false);
    expect(await checkpointRows()).toEqual([]);
  });

  test('an ALREADY-COMPLETED step still answers `already_completed` when paused — a fact, not a request', async () => {
    // The ordering CDR-079 fixes: reporting a step that already ran as refused would corrupt resume arithmetic,
    // making a resumed job either re-run committed effects or conclude it can never finish.
    const enqueued = await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' }, idempotencyKey: 'k-done' });
    const jobId = (enqueued as { status: 'ok'; job: { id: string } }).job.id;
    const first = await runJobStep(product, { ...base(), jobId, stepName: 'fetch', step: () => Promise.resolve({ done: true }) });
    expect(first.status).toBe('ok');

    await setCompanyStatus('paused');

    const replayed = await runJobStep(product, { ...base(), jobId, stepName: 'fetch', step: () => Promise.reject(new Error('must not run')) });
    expect(replayed.status).toBe('already_completed');
  });

  // ── dispatchToolCall ───────────────────────────────────────────────────────────────────────────────────────

  test('a paused company CANNOT dispatch a tool call, and the refusal IS RECORDED as `company_not_active`', async () => {
    // THE POINT CANON NAMES EXPLICITLY (SECURITY-VERIFICATION-PLAN:23, "lifecycle checks in job pickup +
    // dispatcher), and the one that needed migration 0054's SECOND constraint. `tool_calls.denial_reason` is
    // CHECKed against a closed vocabulary, so if the migration had been forgotten this insert would raise 23514,
    // ABORT the transaction, and the call would be neither executed nor recorded — a refusal that loses its own
    // evidence. The recorded row below is what proves the constraint was widened.
    const taskId = await queuedTask();
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    const runId = (started as { status: 'ok'; run: { id: string } }).run.id;
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('web_research', 1, 'informational', 'gate-14 fixture', 'active')
              on conflict do nothing`.execute(owner.kysely);

    await setCompanyStatus('paused');

    const denied = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: ['web_research'], context: [] });
    expect(denied).toMatchObject({ status: 'denied', reason: 'company_not_active' });

    // TOOL-002 wants 100% of calls recorded, INCLUDING the refused ones — which is why the gate is read beside
    // the other facts rather than as an early return that would skip the recording.
    const calls = await owner.kysely.selectFrom('tool_calls').selectAll().where('company_id', '=', w.companyA1).execute();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outcome).toBe('denied');
    expect(calls[0]?.denial_reason).toBe('company_not_active');
  });

  test('the tool-call refusal is NOT `emergency_stopped`, and no stop row exists to explain it', async () => {
    // Reusing that value would send an operator hunting a stop somebody activated, and would additionally trip
    // the held-work + `running`→`paused` block that belongs to the emergency-stop controller.
    const taskId = await queuedTask();
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    const runId = (started as { status: 'ok'; run: { id: string } }).run.id;
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('web_research', 1, 'informational', 'gate-14 fixture', 'active')
              on conflict do nothing`.execute(owner.kysely);

    await setCompanyStatus('deactivated');
    const denied = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: ['web_research'], context: [] });
    expect(denied).toMatchObject({ status: 'denied' });
    expect(denied).not.toMatchObject({ reason: 'emergency_stopped' });
    expect(await owner.kysely.selectFrom('emergency_stops').selectAll().execute()).toEqual([]);
  });

  // ── the account level ──────────────────────────────────────────────────────────────────────────────────────

  test('a NON-ACTIVE ACCOUNT blocks work even though its transitions are deferred', async () => {
    // ACC-004's transitions are a later slice, but the ENFORCEMENT is live now. Nothing in production writes a
    // non-active account status yet, so this test writes it directly — and the refusal names the ACCOUNT, which
    // is the level an operator must fix first (CDR-079 §3-G4). The company here is untouched and still `active`.
    const taskId = await queuedTask();
    await setAccountStatus('suspended');

    const refused = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(refused).toEqual({ status: 'company_not_active', reason: 'account_not_active' });
    expect(await runRows()).toEqual([]);

    const company = await owner.kysely.selectFrom('companies').select('status').where('id', '=', w.companyA1).executeTakeFirst();
    expect(company?.status).toBe('active');
  });

  // ── the way back ───────────────────────────────────────────────────────────────────────────────────────────

  test('RESUMING restores the ability to work — the gate is not a one-way door', async () => {
    const taskId = await queuedTask();
    await pauseCompany(product, base());
    expect((await startRun(product, { ...base(), taskId, attempt: 1 })).status).toBe('company_not_active');

    // Through the PRODUCTION use case, not a direct UPDATE: `resumeCompany` must itself be permitted on a paused
    // company, or the gate would block the only path out of the state it created (CDR-079 §5-G5.3).
    const resumed = await resumeCompany(product, base());
    expect(resumed.status).toBe('ok');
    expect((await startRun(product, { ...base(), taskId, attempt: 1 })).status).toBe('ok');
  });

  // ── what must KEEP working (CDR-079 §5) ────────────────────────────────────────────────────────────────────

  test('EXPORT still works on a DEACTIVATED company — the ownership guarantee outlives the company', async () => {
    // ADR-002 makes export the answer to "what happens to my work if I leave". A founder who deactivates and
    // then cannot take their data is the 3am page CDR-079 §5-G5.1 exists to prevent. This is also why the gate
    // is NEVER installed in a scope primitive: it would catch this path without anyone deciding to.
    await setCompanyStatus('deactivated');
    const exported = await exportCompanyData(product, new InMemoryObjectStorage(), base(), { now: new Date('2026-08-05T12:00:00.000Z') });
    expect(exported.status).toBe('ok');
  });

  test('READING a deactivated company still works, and reports the real state', async () => {
    // COMP-008: the status must be truthful, and this read is how anyone — including the owner — learns the
    // company is deactivated at all. A gate that blocked it would hide its own effect.
    await setCompanyStatus('deactivated');
    const read = await getCompany(product, base());
    expect(read.status).toBe('ok');
    if (read.status === 'ok') expect(read.company.status).toBe('deactivated');
  });

  // ── the vocabulary the migration widened ───────────────────────────────────────────────────────────────────

  test('the CHECK constraint accepts both deactivation phases and still refuses `deleted`', async () => {
    // Migration 0054. `deleted` stays out deliberately (CDR-079 §3-G6) — COMP-007 owns it, and the allowlist
    // gate refuses it without needing a vocabulary entry, so the CHECK stays tight to what is reachable.
    for (const status of ['deactivating', 'deactivated']) {
      await expect(setCompanyStatus(status)).resolves.not.toThrow();
    }
    await expect(setCompanyStatus('deleted')).rejects.toThrow();
  });
});
