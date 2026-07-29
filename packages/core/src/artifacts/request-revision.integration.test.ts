// ACBP-P5-012 — real-PostgreSQL proof of `requestRevision` (CDR-064; J-13; TASK-005 lineage).
//
// J-13: *"Trigger: revision request with guidance. Flow: new linked task created (lineage to original) →
// re-execution → both versions retained."* This suite proves the request half; slice 2 proved the table.
//
// Skips when ACBP_TEST_DATABASE_URL is unset - a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { TaskRepository, type DatabaseClient } from '@acbp/database';
import { REVISION_GUIDANCE_MAX } from '@acbp/contracts';
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
  asRestricted,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask, deleteTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { requestRevision } from './request-revision.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('requestRevision (real PostgreSQL, restricted role) — ACBP-P5-012/CDR-064/J-13', () => {
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
  const revisionRows = async () => owner.kysely.selectFrom('artifact_revisions').selectAll().execute();
  const taskRows = async () => owner.kysely.selectFrom('tasks').selectAll().execute();
  const auditRows = async () => owner.kysely.selectFrom('audit_events').selectAll().orderBy('event_id').execute();

  /** A task carried to a running run, returning both ids. */
  async function runningRun(over: { companyId?: string; userId?: string; accountId?: string; title?: string } = {}): Promise<{ taskId: string; runId: string }> {
    const params = { userId: over.userId ?? w.aOwner, accountId: over.accountId ?? w.accountA, companyId: over.companyId ?? w.companyA1 };
    const t = await createTask(product, { ...params, title: over.title ?? 'Research the market', description: 'Ring the waitlist.', milestoneId: null });
    const taskId = (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...params, taskId })).status).toBe('ok');
    await asRestricted(product, { account: params.accountId, company: params.companyId }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const r = await startRun(product, { ...params, taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return { taskId, runId: (r as { status: 'ok'; run: { id: string } }).run.id };
  }

  let seq = 0;
  async function seedArtifact(runId: string, companyId = w.companyA1, accountId = w.accountA): Promise<string> {
    seq += 1;
    const hash = seq.toString(16).padStart(64, 'b');
    const r = await sql<{ id: string }>`
      insert into artifacts (account_id, company_id, object_key, content_hash, format, size_bytes, run_id, worker_id, worker_version, model_version, title)
      values (${accountId}, ${companyId}, ${'company/' + companyId.toLowerCase() + '/' + hash}, ${hash}, 'markdown', 128, ${runId}, 'research', 1, 'fake-1', 'Market research')
      returning id
    `.execute(owner.kysely);
    return r.rows[0]?.id ?? '';
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from artifact_revisions`.execute(owner.kysely);
    await sql`delete from artifacts`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  // ── J-13's flow ───────────────────────────────────────────────────────────────────────────────────────────
  test('a revision creates a NEW LINKED TASK and records both ends of the lineage', async () => {
    const { taskId: sourceTask, runId } = await runningRun();
    const artifact = await seedArtifact(runId);

    const r = await requestRevision(product, { ...base(), artifactId: artifact, guidance: '  Shorten it to one page.  ', idempotencyKey: 'rev-1' });
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.deduplicated).toBe(false);
    expect(ok.revision.originalArtifactId).toBe(artifact);
    // TRIMMED at the contract, so what is stored is what the founder meant.
    expect(ok.revision.guidance).toBe('Shorten it to one page.');

    // A NEW task, distinct from the source, in `draft` - not a re-opening of the completed one.
    expect(ok.newTaskId).not.toBe(sourceTask);
    const tasks = await taskRows();
    expect(tasks).toHaveLength(2);
    const fresh = tasks.find((t) => t.id === ok.newTaskId);
    expect(fresh?.state).toBe('draft');
    // Content carries over so the worker knows what to do, and `task_type` so the SAME worker runs it.
    expect(fresh?.title).toBe('Research the market');
    expect(fresh?.description).toBe('Ring the waitlist.');
    // Provenance does NOT carry over (the P4-005 lesson), and the lineage is NOT duplicated onto the task (G1).
    expect(fresh?.priority).toBeNull();
    expect(fresh?.rationale).toBeNull();
    expect(fresh?.repeated_from_task_id).toBeNull();
  });

  test('THE ORIGINAL SURVIVES UNTOUCHED, and both versions are retained', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    const before = await owner.kysely.selectFrom('artifacts').selectAll().where('id', '=', artifact).executeTakeFirst();

    expect((await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Add sources.', idempotencyKey: 'k' })).status).toBe('ok');

    const after = await owner.kysely.selectFrom('artifacts').selectAll().where('id', '=', artifact).executeTakeFirst();
    expect(after).toEqual(before);
  });

  // ── the owner gate ────────────────────────────────────────────────────────────────────────────────────────
  test('a VIEWER may not request a revision - it spends the company credits (API-CONTRACTS "owner (revise)")', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    const asViewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect(await requestRevision(product, { ...asViewer, artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'v' })).toEqual({ status: 'forbidden' });
    expect(await revisionRows()).toHaveLength(0);
    expect(await taskRows()).toHaveLength(1); // no orphan task left behind by the refusal
  });

  // ── NO CREDIT IS CHARGED HERE (CDR-064 G4, corrected) ─────────────────────────────────────────────────────
  test('requesting a revision charges NOTHING - the metering is on planned→queued, and charging here would double it', async () => {
    // The D9 shape, caught before it shipped: a second charge on a path whose lifecycle already charges once.
    // `WORKFLOW-STATE-MACHINES` §4 puts the credit check on `planned→queued`, which the new task goes through like
    // any other. If this use case ever reserves a credit, this test fails and the double charge is visible.
    await sql`insert into credit_transactions (account_id, kind, credits) values (${w.accountA}, 'grant', 5)`.execute(owner.kysely);
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);

    expect((await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'k' })).status).toBe('ok');

    const ledger = await owner.kysely.selectFrom('credit_transactions').selectAll().execute();
    expect(ledger.map((x) => x.kind)).toEqual(['grant']);
    expect(ledger.reduce((sum, x) => sum + x.credits, 0)).toBe(5);
  });

  // ── idempotency (CDR-064 G3) ──────────────────────────────────────────────────────────────────────────────
  test('RETRYING with the same key returns the FIRST request and creates NO second task', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);

    const first = await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'same' });
    const second = await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'same' });
    const a = first as Extract<typeof first, { status: 'ok' }>;
    const b = second as Extract<typeof second, { status: 'ok' }>;

    expect(b.deduplicated).toBe(true);
    expect(b.revision.revisionId).toBe(a.revision.revisionId);
    expect(b.newTaskId).toBe(a.newTaskId);
    expect(await revisionRows()).toHaveLength(1);
    // THE ORPHAN-TASK TRAP: the idempotency check runs BEFORE the task is created, so a retry leaves no stray task.
    expect(await taskRows()).toHaveLength(2); // the source, and exactly one revision task
    expect((await auditRows()).filter((e) => e.name === 'artifact.revision_requested')).toHaveLength(1);
  });

  test('REUSING one key for a DIFFERENT artifact is REFUSED, not silently answered with the other one', async () => {
    // Review pass 2. Idempotency means "this exact request already happened" - it does NOT mean "any request with
    // this key already happened". Returning the first revision here would tell the founder their SECOND document was
    // revised when nothing of the sort occurred, and they would wait for a version that is never coming. P5-014 hit
    // the same shape with reservation keys and answered it with a typed refusal; so does this.
    const first = await seedArtifact((await runningRun()).runId);
    const second = await seedArtifact((await runningRun()).runId);
    expect((await requestRevision(product, { ...base(), artifactId: first, guidance: 'Shorten it.', idempotencyKey: 'shared' })).status).toBe('ok');

    expect(await requestRevision(product, { ...base(), artifactId: second, guidance: 'Shorten it.', idempotencyKey: 'shared' })).toEqual({
      status: 'key_reused_for_different_artifact',
    });
    expect(await revisionRows()).toHaveLength(1);
    expect(await taskRows()).toHaveLength(3); // the two sources and ONE revision task - no task minted for the refusal
  });

  test('a DIFFERENT key is a DIFFERENT request - two revisions of one artifact are both real', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    expect((await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorter.', idempotencyKey: 'k1' })).status).toBe('ok');
    expect((await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorter still.', idempotencyKey: 'k2' })).status).toBe('ok');
    expect(await revisionRows()).toHaveLength(2);
    expect(await taskRows()).toHaveLength(3);
  });

  // ── refusals ──────────────────────────────────────────────────────────────────────────────────────────────
  test('BLANK guidance is refused, and nothing at all is created', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    expect(await requestRevision(product, { ...base(), artifactId: artifact, guidance: '   ', idempotencyKey: 'k' })).toEqual({ status: 'invalid', reason: 'guidance_required' });
    expect(await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'x'.repeat(REVISION_GUIDANCE_MAX + 1), idempotencyKey: 'k' })).toEqual({
      status: 'invalid',
      reason: 'guidance_too_long',
    });
    expect(await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Fine.', idempotencyKey: '  ' })).toEqual({ status: 'invalid', reason: 'key_required' });
    expect(await revisionRows()).toHaveLength(0);
    expect(await taskRows()).toHaveLength(1);
  });

  test('an artifact in ANOTHER COMPANY reads as ABSENT, never as a refusal that confirms it exists', async () => {
    const foreign = await runningRun({ companyId: w.companyB1, userId: w.bOwner, accountId: w.accountB });
    const foreignArtifact = await seedArtifact(foreign.runId, w.companyB1, w.accountB);
    expect(await requestRevision(product, { ...base(), artifactId: foreignArtifact, guidance: 'Shorten it.', idempotencyKey: 'x' })).toEqual({ status: 'artifact_not_found' });
    expect(await revisionRows()).toHaveLength(0);
  });

  test('a DELETED source task is honestly unavailable - there is nothing to re-execute', async () => {
    const { taskId, runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    await sql`update tasks set state = 'completed' where id = ${taskId}::uuid`.execute(owner.kysely);
    expect((await deleteTask(product, { ...base(), taskId, confirmed: true })).status).toBe('ok');

    expect(await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'k' })).toEqual({ status: 'source_task_unavailable' });
    expect(await revisionRows()).toHaveLength(0);
  });

  // ── audit-or-nothing (ADR-015) ────────────────────────────────────────────────────────────────────────────
  test('the audit event names BOTH ends of the lineage and NEVER the guidance text', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    const r = await requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Please remove the pricing section entirely.', idempotencyKey: 'k' });
    const ok = r as Extract<typeof r, { status: 'ok' }>;

    const ev = (await auditRows()).find((e) => e.name === 'artifact.revision_requested');
    expect(ev?.payload).toMatchObject({ original_artifact_id: artifact, new_task_id: ok.newTaskId, has_guidance: true });
    // The founder's words are in the row the owner can read - never in the audit trail.
    expect(JSON.stringify(ev?.payload)).not.toContain('pricing');
  });

  test('AUDIT-OR-NOTHING: an in-tx audit failure rolls back the task AND the revision row', async () => {
    const { runId } = await runningRun();
    const artifact = await seedArtifact(runId);
    const failing = () => Promise.reject(new Error('audit write failed'));

    await expect(
      requestRevision(product, { ...base(), artifactId: artifact, guidance: 'Shorten it.', idempotencyKey: 'k' }, { auditWriter: failing }),
    ).rejects.toBeDefined();

    // Neither survives: a task nobody asked for, or lineage pointing at nothing, are both worse than no revision.
    expect(await revisionRows()).toHaveLength(0);
    expect(await taskRows()).toHaveLength(1);
  });
});
