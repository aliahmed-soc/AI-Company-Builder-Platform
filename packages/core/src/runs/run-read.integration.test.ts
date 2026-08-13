// ACBP-API-003 / CDR-089 — real-PostgreSQL proof of the run read through the RESTRICTED role.
//
// WHAT THE UNIT TESTS CANNOT PROVE, AND THIS FILE MUST. `run-read.test.ts` exercises the DTO mapper on a literal
// row; it never touches a database, so it says nothing about whether `run:read` actually gates anything or whether
// RLS confines the read. Those are the claims that matter, and only a real database can settle them.
//
// THIS MATRIX MAKES THE STRONGER CLAIM THAT SLICE 2 MOSTLY COULD NOT. `task_runs` seeds from a task and tasks seed
// standalone, so a foreign run PROVABLY EXISTS here and is still invisible — CDR-089 §4. The roadmap, artifact and
// approvals matrices could only prove refusal at company scope because their tables need seeding chains; this one
// has no such excuse and does not claim one.
//
// Skips when ACBP_TEST_DATABASE_URL is unset. Skipped is not green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, assertRestrictedRole, teardown, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask } from '../tasks/task-management.js';
import { getTaskRun, listTaskRuns } from './run-read.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000000ff';

describe.skipIf(!hasTestDatabase)('run read (real PostgreSQL, restricted role) — ACBP-API-003/CDR-089', () => {
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

  /** A task in the given company, created through the real use case so the row is one the product could produce. */
  async function taskIn(userId: string, accountId: string, companyId: string, title: string): Promise<string> {
    const r = await createTask(product, { userId, accountId, companyId, title, description: null, milestoneId: null });
    expect(r.status, `createTask in ${companyId}`).toBe('ok');
    return (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
  }

  /**
   * A run of that task, seeded on the OWNER connection.
   *
   * Seeded directly rather than through a worker claim: this ticket reads runs, it does not execute them, and
   * driving the executor would test P5's machinery instead of this read. The row still has to satisfy every real
   * constraint, which is what makes it a fixture rather than a mock.
   */
  async function runFor(accountId: string, companyId: string, taskId: string, state = 'failed'): Promise<string> {
    const row = await owner.kysely
      .insertInto('task_runs')
      .values({ account_id: accountId, company_id: companyId, task_id: taskId, attempt: 1, state })
      .returning('id')
      .executeTakeFirstOrThrow();
    // `failure_category` has INSERT type `never` — the schema forbids setting it at insert, so a run cannot be
    // BORN failed; it has to fail. The compiler caught this, and the fixture now respects the rule rather than
    // routing around it: the category is applied as an UPDATE, which is the only way a real run acquires one.
    if (state === 'failed') {
      await sql`update task_runs set failure_category = 'timeout' where id = ${row.id}::uuid`.execute(owner.kysely);
    }
    return row.id;
  }

  test('a member reads a run in their own company, and the DTO carries NO tenant id', async () => {
    // The POSITIVE first: without it every negative below would also pass against a read that refused everything.
    const taskId = await taskIn(w.aOwner, w.accountA, w.companyA1, 'Interview five prospects');
    const runId = await runFor(w.accountA, w.companyA1, taskId);

    const r = await getTaskRun(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.run.runId).toBe(runId);
    expect(r.run.taskId).toBe(taskId);
    expect(r.run.failureCategory).toBe('timeout');
    // The allowlist holds against a REAL row, not just the literal one the unit test builds.
    expect(JSON.stringify(r.run)).not.toContain(w.accountA);
    expect(JSON.stringify(r.run)).not.toContain(w.companyA1);
  });

  test('a viewer may read — `run:read` is granted owner|viewer, and this is what proves it', async () => {
    const taskId = await taskIn(w.aOwner, w.accountA, w.companyA1, 'Viewer-readable');
    const runId = await runFor(w.accountA, w.companyA1, taskId);
    const r = await getTaskRun(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, runId });
    expect(r.status, 'a viewer holds run:read').toBe('ok');
  });

  test('CROSS-COMPANY: a run in B PROVABLY EXISTS and is still invisible from A', async () => {
    const taskB = await taskIn(w.bOwner, w.accountB, w.companyB1, 'B-only work');
    const runB = await runFor(w.accountB, w.companyB1, taskB);
    // The fixture guard: if this ever returns zero the negative below is vacuous and must fail HERE, loudly.
    const exists = await owner.kysely.selectFrom('task_runs').select('id').where('id', '=', runB).execute();
    expect(exists.length, 'fixture guard: the foreign run must exist').toBe(1);

    const r = await getTaskRun(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId: runB });
    expect(r.status, "B's run must not be readable from A").not.toBe('ok');
  });

  test('a FOREIGN run id and an UNKNOWN one are INDISTINGUISHABLE', async () => {
    const taskB = await taskIn(w.bOwner, w.accountB, w.companyB1, 'B-only work');
    const runB = await runFor(w.accountB, w.companyB1, taskB);
    const foreign = await getTaskRun(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId: runB });
    const unknown = await getTaskRun(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId: UNKNOWN_UUID });
    expect(foreign.status, 'identical status').toBe(unknown.status);
    expect(JSON.stringify(foreign), 'identical payload').toBe(JSON.stringify(unknown));
  });

  test('a NON-MEMBER is forbidden', async () => {
    const taskId = await taskIn(w.aOwner, w.accountA, w.companyA1, 'Members only');
    const runId = await runFor(w.accountA, w.companyA1, taskId);
    const r = await getTaskRun(product, { userId: w.outsider, accountId: w.accountA, companyId: w.companyA1, runId });
    expect(r.status).toBe('forbidden');
  });

  test('listTaskRuns returns the task\'s runs, and NEVER another company\'s', async () => {
    const taskA = await taskIn(w.aOwner, w.accountA, w.companyA1, 'A work');
    await runFor(w.accountA, w.companyA1, taskA, 'succeeded');
    const taskB = await taskIn(w.bOwner, w.accountB, w.companyB1, 'B work');
    const runB = await runFor(w.accountB, w.companyB1, taskB);

    const r = await listTaskRuns(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, taskId: taskA });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.runs.length).toBe(1);
    expect(r.runs.map((x) => x.runId)).not.toContain(runB);
  });

  test('an UNKNOWN task and a task with NO RUNS agree — the empty list is honest, not a hidden 404', async () => {
    // CDR-089 §3: `listForTask` cannot tell these apart, so the use case must not pretend it can. Asserting the
    // agreement pins that decision — if a `not_found` arm is ever added, this test fails and forces the argument.
    const taskA = await taskIn(w.aOwner, w.accountA, w.companyA1, 'No runs yet');
    const empty = await listTaskRuns(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, taskId: taskA });
    const unknown = await listTaskRuns(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, taskId: UNKNOWN_UUID });
    expect(JSON.stringify(empty)).toBe(JSON.stringify(unknown));
  });

  test('a paused company still permits the read — pausing halts WORK, it does not blind the founder', async () => {
    const taskId = await taskIn(w.aOwner, w.accountA, w.companyA1, 'Before the pause');
    const runId = await runFor(w.accountA, w.companyA1, taskId);
    await sql`update companies set status = 'paused' where id = ${w.companyA1}::uuid`.execute(owner.kysely);
    const r = await getTaskRun(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId });
    // Recorded as an assertion rather than an assumption: if the platform ever decides a paused company hides its
    // execution history, this test is where that decision has to be made deliberately.
    expect(r.status, 'a paused company can still be inspected').toBe('ok');
  });
});
