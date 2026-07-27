// ACBP-P5-001b / CDR-050 — real-PostgreSQL proof of checkpoints and resume, through the RESTRICTED role under
// FORCE RLS. Acceptance clause: "kill-and-resume green" (NFR-005).
//
// The centrepiece is an ACTUAL kill-and-resume: a plan runs, a step crashes mid-flight, the job resumes, and the
// completed step is asserted NOT to have run a second time. Everything else here exists to make that assertion mean
// something — that the checkpoint shares the step's transaction, that a crash leaves no half-state, and that the
// append-only table cannot be edited to claim a step did not run.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is "discovered but not executed", never green, so hosted
// CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { JobRepository, type DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { enqueueJob, runJobStep, getResumeState } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('job checkpoints + resume (real PostgreSQL, restricted role) — ACBP-P5-001b/CDR-050', () => {
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
  const checkpointRows = async () => owner.kysely.selectFrom('job_checkpoints').selectAll().execute();

  async function newJob(): Promise<string> {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    return r.job.id;
  }

  const PLAN = ['research', 'draft', 'publish'] as const;

  // ── THE ACCEPTANCE CLAUSE ─────────────────────────────────────────────────────────────────────────────────
  test('KILL AND RESUME — a crashed plan resumes without re-running the step that already completed', async () => {
    const jobId = await newJob();
    const executed: string[] = [];
    // A step body that records the fact it ran. If resume re-executed a completed step, this array is where it shows.
    const step = (name: string) => (): Promise<Record<string, unknown>> => {
      executed.push(name);
      return Promise.resolve({ ran: name });
    };

    // First attempt: `research` completes, then `draft` CRASHES mid-flight.
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: step('research') }));
    await expect(
      runJobStep(product, {
        ...base(),
        jobId,
        stepName: 'draft',
        step: () => {
          executed.push('draft-attempt-1');
          return Promise.reject(new Error('worker killed mid-step'));
        },
      }),
    ).rejects.toThrow();

    // The crash left NO checkpoint for `draft` — the checkpoint shares the step's transaction, so a step that threw
    // genuinely did not complete, and re-running it is correct rather than a double execution.
    expect((await checkpointRows()).map((c) => c.step_name)).toEqual(['research']);

    // Resume: the plan minus the inventory.
    const state = ok(await getResumeState(product, { ...base(), jobId, plan: [...PLAN] }));
    expect(state.completedSteps).toEqual(['research']);
    expect(state.remainingSteps).toEqual(['draft', 'publish']);
    expect(state.progress).toEqual({ completed: 1, total: 3, remaining: 2, complete: false });

    // Run the remainder. THIS IS THE ASSERTION THE TICKET EXISTS FOR: `research` is not in the second run.
    for (const name of state.remainingSteps) {
      ok(await runJobStep(product, { ...base(), jobId, stepName: name, step: step(name) }));
    }
    expect(executed).toEqual(['research', 'draft-attempt-1', 'draft', 'publish']);
    expect(executed.filter((e) => e === 'research')).toHaveLength(1);

    const final = ok(await getResumeState(product, { ...base(), jobId, plan: [...PLAN] }));
    expect(final.remainingSteps).toEqual([]);
    expect(final.progress.complete).toBe(true);
  });

  test('a step already checkpointed is reported `already_completed` and its body NEVER runs', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve({ v: 1 }) }));

    let ran = false;
    const second = await runJobStep(product, {
      ...base(),
      jobId,
      stepName: 'research',
      step: () => {
        ran = true;
        return Promise.resolve({ v: 2 });
      },
    });
    expect(second.status).toBe('already_completed');
    expect(ran).toBe(false);
    // The ORIGINAL output survives: a completed step's record is a fact about the past, not something a later call
    // can overwrite with a different answer.
    expect(second.status === 'already_completed' ? second.output : null).toEqual({ v: 1 });
    expect(await checkpointRows()).toHaveLength(1);
  });

  test('the checkpoint shares the step\'s TRANSACTION — a step that writes and then throws leaves nothing behind', async () => {
    const jobId = await newJob();
    // The step writes a real row through the same transaction it was handed, then fails. Both must roll back: if the
    // write survived without a checkpoint, a resume would re-run the step and duplicate that write.
    await expect(
      runJobStep(product, {
        ...base(),
        jobId,
        stepName: 'draft',
        step: async (ctx) => {
          await sql`update jobs set state = 'running', updated_at = now() where id = ${jobId}::uuid`.execute(ctx.db);
          throw new Error('crash after the effect landed');
        },
      }),
    ).rejects.toThrow();

    expect(await checkpointRows()).toHaveLength(0);
    const job = await owner.kysely.selectFrom('jobs').selectAll().where('id', '=', jobId).executeTakeFirst();
    expect(job?.state).toBe('queued'); // the step's effect rolled back with its missing checkpoint
  });

  test('a step receives the outputs of previously completed steps', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve({ documentId: 'doc-1' }) }));
    let seen: Readonly<Record<string, Record<string, unknown>>> = {};
    ok(
      await runJobStep(product, {
        ...base(),
        jobId,
        stepName: 'draft',
        step: (ctx) => {
          seen = ctx.previousOutputs;
          return Promise.resolve({ drafted: true });
        },
      }),
    );
    expect(seen).toEqual({ research: { documentId: 'doc-1' } });
  });

  test('a step that records no output is ABSENT from the output map rather than present-and-empty', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve(undefined) }));
    const state = ok(await getResumeState(product, { ...base(), jobId, plan: [...PLAN] }));
    expect(state.completedSteps).toEqual(['research']);
    expect(state.outputs).toEqual({});
  });

  // ── the store's guarantees ────────────────────────────────────────────────────────────────────────────────
  test('a step completes ONCE — the database refuses a second checkpoint for the same (job, step)', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve(undefined) }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`insert into job_checkpoints (account_id, company_id, job_id, step_name)
            values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${jobId}::uuid, 'research')`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
    expect(await checkpointRows()).toHaveLength(1);
  });

  test('checkpoints are APPEND-ONLY — no UPDATE and no DELETE, so a completed step cannot be un-recorded', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve({ v: 1 }) }));
    // Erasing a checkpoint is exactly how a step gets run twice, so the grant must not permit it.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`delete from job_checkpoints`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update job_checkpoints set step_name = 'other'`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect(await checkpointRows()).toHaveLength(1);
  });

  test('the job FK is TENANT-PINNED — a checkpoint cannot reference another company\'s job', async () => {
    const jobId = await newJob();
    // RI checks always bypass RLS, so a single-column FK would have allowed this. The composite (job_id, company_id)
    // reference is what makes it impossible, and B holds a perfectly valid session for its own company.
    await expect(
      asRestricted(product, { account: w.accountB, company: w.companyB1 }, (db) =>
        new JobRepository(db).insertCheckpoint({ accountId: w.accountB, companyId: w.companyB1, jobId, stepName: 'research' }),
      ),
    ).rejects.toThrow();
    expect(await checkpointRows()).toHaveLength(0);
  });

  test('checkpoints are invisible across companies, and a foreign job is `job_not_found`', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve({ v: 1 }) }));
    const foreign = await getResumeState(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, jobId, plan: [...PLAN] });
    expect(foreign.status).toBe('job_not_found');
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await new JobRepository(db).listCheckpoints(jobId)).toEqual([]);
    });
  });

  test('a viewer cannot run a step or read resume state — `job:enqueue` is owner-only', async () => {
    const jobId = await newJob();
    let ran = false;
    const asViewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect(
      await runJobStep(product, {
        ...asViewer,
        jobId,
        stepName: 'research',
        step: () => {
          ran = true;
          return Promise.resolve({});
        },
      }),
    ).toEqual({ status: 'forbidden' });
    expect(ran).toBe(false);
    expect((await getResumeState(product, { ...asViewer, jobId, plan: [...PLAN] })).status).toBe('forbidden');
  });

  test('resume ignores a checkpoint for a step the plan no longer contains, rather than stranding the job', async () => {
    const jobId = await newJob();
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'research', step: () => Promise.resolve({ v: 1 }) }));
    ok(await runJobStep(product, { ...base(), jobId, stepName: 'obsolete_step', step: () => Promise.resolve({ v: 1 }) }));
    // The plan changed between the crash and the resume. The stale checkpoint is true about a step this plan does not
    // contain — harmless — and the job must still resume.
    const state = ok(await getResumeState(product, { ...base(), jobId, plan: [...PLAN] }));
    expect(state.remainingSteps).toEqual(['draft', 'publish']);
    expect(state.progress).toEqual({ completed: 1, total: 3, remaining: 2, complete: false });
  });
});
