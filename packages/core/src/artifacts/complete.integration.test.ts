// ACBP-P5-011 / TASK-005 — `completeTask` against a REAL database. THE PROOF THAT THE GUARD IS APPLIED.
//
// `validateCompletionEvidence` makes the forbidden shape unrepresentable, but a contract nobody calls enforces
// nothing — a guard WRITTEN and never APPLIED is the defect pattern this repo has hit most often. These tests run
// through the use case, and every refusal asserts the task did NOT move and NO audit row was written, because a
// refusal that still completed the task would be the bug wearing the right return value.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { InMemoryObjectStorage } from '@acbp/adapters';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { persistArtifact } from './persist.js';
import { completeTask } from './complete.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('completeTask — "no artifactless completion" enforced (ACBP-P5-011/TASK-005)', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let storage: InMemoryObjectStorage;
  let taskA = '';
  let runA = '';
  let otherRun = '';

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
    storage = new InMemoryObjectStorage();

    const mk = async (title: string): Promise<{ task: string; run: string }> => {
      const task = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'running', ${title}, ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
      // The run is SUCCEEDED: a succeeded run is the precondition for completing its task, and the distinction
      // between the two facts is the reason this event was deferred to this ticket at all.
      const run = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt, state, ended_at) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${task}::uuid, 1, 'succeeded', now()) returning id`.execute(owner.kysely)).rows[0]!.id;
      return { task, run };
    };
    ({ task: taskA, run: runA } = await mk('produce research'));
    ({ run: otherRun } = await mk('produce something else'));
  }, 60_000);

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  async function writeArtifact(runId: string, content: string): Promise<string> {
    const r = await persistArtifact(product, storage, { ...base(), runId, workerId: 'research', workerVersion: 1, modelVersion: 'fake@1', title: 'Market research', format: 'markdown', content });
    if (r.status !== 'ok') throw new Error(`artifact setup failed: ${r.status}`);
    return r.artifact.id;
  }

  async function taskState(taskId: string): Promise<string> {
    return (await sql<{ state: string }>`select state from tasks where id = ${taskId}::uuid`.execute(owner.kysely)).rows[0]!.state;
  }

  async function completedAudits(): Promise<ReadonlyArray<Record<string, unknown>>> {
    const r = await sql<{ metadata: Record<string, unknown> }>`select metadata from audit_events where event_name = 'task.completed'`.execute(owner.kysely);
    return r.rows.map((x) => x.metadata);
  }

  describe('the two shapes canon permits', () => {
    test('artifacts: the task completes, and the audit row records how many', async () => {
      const artifact = await writeArtifact(runA, '# Findings');
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'artifacts', artifactIds: [artifact] } })).toMatchObject({ status: 'ok', artifactCount: 1 });
      expect(await taskState(taskA)).toBe('completed');
      expect(await completedAudits()).toEqual([{ run_id: runA, artifact_count: 1, no_artifact_rationale: false }]);
    });

    test('no_artifact: an EXPLICIT rationale completes the task, and the row says so', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'Already answered by an existing memory item.' } })).toMatchObject({ status: 'ok', artifactCount: 0 });
      expect(await taskState(taskA)).toBe('completed');
      // `0` + `true` is how an artifactless completion is VISIBLE. The pair `0`/`false` is unreachable.
      expect(await completedAudits()).toEqual([{ run_id: runA, artifact_count: 0, no_artifact_rationale: true }]);
      // The rationale TEXT is never in the payload — unbounded caller prose, like `task.deleted`'s reason.
      expect(JSON.stringify(await completedAudits())).not.toContain('Already answered');
    });
  });

  describe('the forbidden third shape never completes anything', () => {
    test('an EMPTY artifact list refuses, the task stays running, and NO audit row is written', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'artifacts', artifactIds: [] } })).toMatchObject({ status: 'refused', reason: 'no_evidence' });
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });

    test('a blank rationale refuses and changes nothing', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: '   ' } })).toMatchObject({ status: 'refused', reason: 'blank_rationale' });
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });

    test('no evidence at all refuses — there is no default completion', async () => {
      for (const bad of [undefined, null, {}, { kind: 'whatever' }]) {
        expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: bad })).toMatchObject({ status: 'refused' });
      }
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });
  });

  describe('the artifacts must be REAL, and must be THIS run s', () => {
    test('a fabricated artifact id refuses — the shape check alone would have let this through', async () => {
      // `validateCompletionEvidence` is perfectly happy with a well-formed id that names nothing. Only the database
      // read catches it, and without that read the audit row would faithfully record `artifact_count: 1`.
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'artifacts', artifactIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } })).toMatchObject({ status: 'unknown_artifact' });
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });

    test('an artifact produced by a DIFFERENT run of this company refuses', async () => {
      // Real artifact, real company, wrong provenance. A count-only check would pass; this is the test that makes
      // the linkage `task.completed` asserts actually true.
      const foreign = await writeArtifact(otherRun, '# Something else');
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'artifacts', artifactIds: [foreign] } })).toMatchObject({ status: 'unknown_artifact' });
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });

    test('a mix of one real and one fabricated id refuses — every id is checked, not just the first', async () => {
      const real = await writeArtifact(runA, '# Findings');
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'artifacts', artifactIds: [real, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'] } })).toMatchObject({ status: 'unknown_artifact' });
      expect(await taskState(taskA)).toBe('running');
    });
  });

  describe('the run and the task must agree', () => {
    test('a run belonging to a DIFFERENT task refuses', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: otherRun, evidence: { kind: 'no_artifact', rationale: 'x' } })).toMatchObject({ status: 'run_mismatch' });
      expect(await taskState(taskA)).toBe('running');
    });

    test('a run that has NOT succeeded refuses — a running attempt cannot complete its task', async () => {
      const task = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'running', 'in flight', ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
      const run = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${task}::uuid, 1) returning id`.execute(owner.kysely)).rows[0]!.id;
      expect(await completeTask(product, { ...base(), taskId: task, runId: run, evidence: { kind: 'no_artifact', rationale: 'x' } })).toMatchObject({ status: 'run_not_succeeded', runState: 'running' });
      expect(await taskState(task)).toBe('running');
    });

    test('an unknown run refuses rather than completing on trust', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', evidence: { kind: 'no_artifact', rationale: 'x' } })).toMatchObject({ status: 'run_not_found' });
    });
  });

  describe('transitions and authority', () => {
    test('completing an already-completed task is refused — terminal means terminal', async () => {
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'first' } })).toMatchObject({ status: 'ok' });
      expect(await completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'second' } })).toMatchObject({ status: 'illegal_transition', from: 'completed' });
      // Exactly ONE audit row — a second completion must not add a second claim about the same task.
      expect(await completedAudits()).toHaveLength(1);
    });

    test('a VIEWER cannot complete a task — completion is `run:execute`, owner-only', async () => {
      expect(await completeTask(product, { ...base(), userId: w.aViewer, taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'x' } })).toMatchObject({ status: 'forbidden' });
      expect(await taskState(taskA)).toBe('running');
      expect(await completedAudits()).toEqual([]);
    });

    test("another company's owner cannot complete this task", async () => {
      expect(await completeTask(product, { ...base(), userId: w.bOwner, taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'x' } })).toMatchObject({ status: 'forbidden' });
      expect(await taskState(taskA)).toBe('running');
    });
  });

  test('AUDIT-OR-NOTHING: if the audit write fails, the completion does not happen either (ADR-015)', async () => {
    const failingAudit = (): Promise<never> => Promise.reject(new Error('audit unavailable'));
    await expect(completeTask(product, { ...base(), taskId: taskA, runId: runA, evidence: { kind: 'no_artifact', rationale: 'x' } }, { auditWriter: failingAudit })).rejects.toThrow();
    // The state change and the audit row are one transaction, so a task cannot end up completed with no record of it.
    expect(await taskState(taskA)).toBe('running');
  });
});
