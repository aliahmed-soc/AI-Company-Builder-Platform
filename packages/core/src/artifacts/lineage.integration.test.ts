// ACBP-P5-012 slice 4 — the lineage READ (CDR-064; TASK-005 lineage; J-13).
//
// The backlog's acceptance criteria for this ticket are exactly two: **"revision lineage visible; both versions
// retained."** Slices 2 and 3 made the lineage EXIST; this is the surface that makes it VISIBLE, and these tests are
// the acceptance criteria written down.
//
// Skips when ACBP_TEST_DATABASE_URL is unset - a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { TaskRepository, type DatabaseClient } from '@acbp/database';
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
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { requestRevision } from './request-revision.js';
import { readArtifactLineage } from './lineage.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('readArtifactLineage (real PostgreSQL, restricted role) — ACBP-P5-012/CDR-064', () => {
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

  async function runOnTask(taskId: string, companyId = w.companyA1, userId = w.aOwner, accountId = w.accountA): Promise<string> {
    const params = { userId, accountId, companyId };
    expect((await planTask(product, { ...params, taskId })).status).toBe('ok');
    await asRestricted(product, { account: accountId, company: companyId }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const r = await startRun(product, { ...params, taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; run: { id: string } }).run.id;
  }

  async function runningRun(over: { companyId?: string; userId?: string; accountId?: string } = {}): Promise<string> {
    const params = { userId: over.userId ?? w.aOwner, accountId: over.accountId ?? w.accountA, companyId: over.companyId ?? w.companyA1 };
    const t = await createTask(product, { ...params, title: 'Research the market', description: null, milestoneId: null });
    const taskId = (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
    return runOnTask(taskId, params.companyId, params.userId, params.accountId);
  }

  let seq = 0;
  async function seedArtifact(runId: string, companyId = w.companyA1, accountId = w.accountA): Promise<string> {
    seq += 1;
    const hash = seq.toString(16).padStart(64, 'c');
    const r = await sql<{ id: string }>`
      insert into artifacts (account_id, company_id, object_key, content_hash, format, size_bytes, run_id, worker_id, worker_version, model_version, title)
      values (${accountId}, ${companyId}, ${'company/' + companyId.toLowerCase() + '/' + hash}, ${hash}, 'markdown', 128, ${runId}, 'research', 1, 'fake-1', 'Market research')
      returning id
    `.execute(owner.kysely);
    return r.rows[0]?.id ?? '';
  }

  /** original artifact -> revision requested -> the new task runs -> the revised artifact. J-13, end to end. */
  async function revisedPair(): Promise<{ original: string; revised: string; revisionId: string }> {
    const original = await seedArtifact(await runningRun());
    const r = await requestRevision(product, { ...base(), artifactId: original, guidance: 'Shorten it.', idempotencyKey: `k${seq}` });
    const ok = r as Extract<typeof r, { status: 'ok' }>;
    expect(ok.status).toBe('ok');
    const revised = await seedArtifact(await runOnTask(ok.newTaskId));
    return { original, revised, revisionId: ok.revision.revisionId };
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from artifact_revisions`.execute(owner.kysely);
    await sql`delete from artifacts`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  // ── "revision lineage visible" ────────────────────────────────────────────────────────────────────────────
  test('the ORIGINAL shows the revisions asked of it, and no ancestor of its own', async () => {
    const { original, revisionId } = await revisedPair();
    const r = await readArtifactLineage(product, { ...base(), artifactId: original });
    expect(r.status).toBe('ok');
    const ok = r as Extract<typeof r, { status: 'ok' }>;

    expect(ok.artifact.artifactId).toBe(original);
    expect(ok.revisedFrom).toBeNull(); // it is nobody's revision
    expect(ok.revisions.map((v) => v.revisionId)).toEqual([revisionId]);
    expect(ok.revisions[0]?.guidance).toBe('Shorten it.');
  });

  test('the REVISED artifact names what it was a revision OF - the derived link, walked', async () => {
    // The G1 payoff. Nothing on `artifacts` says "I am a revision of X"; the chain artifact -> run -> task ->
    // revision is walked instead, so the answer cannot drift from the request that caused it.
    const { original, revised } = await revisedPair();
    const r = await readArtifactLineage(product, { ...base(), artifactId: revised });
    const ok = r as Extract<typeof r, { status: 'ok' }>;

    expect(ok.artifact.artifactId).toBe(revised);
    expect(ok.revisedFrom?.originalArtifactId).toBe(original);
    expect(ok.revisedFrom?.guidance).toBe('Shorten it.');
    expect(ok.revisions).toEqual([]); // nothing has been asked of the revision yet
  });

  // ── "both versions retained" ──────────────────────────────────────────────────────────────────────────────
  test('BOTH VERSIONS REMAIN READABLE - the revision never replaced the original', async () => {
    const { original, revised } = await revisedPair();
    expect(original).not.toBe(revised);
    for (const id of [original, revised]) {
      const r = await readArtifactLineage(product, { ...base(), artifactId: id });
      expect(r.status).toBe('ok');
      expect((r as Extract<typeof r, { status: 'ok' }>).artifact.artifactId).toBe(id);
    }
  });

  test('a CHAIN of revisions reads correctly at every link', async () => {
    // Revising a revision is ordinary. Each link must know its own ancestor and its own descendants, or the
    // "versions" list a founder sees is wrong from the second revision onward.
    const { original, revised } = await revisedPair();
    const second = await requestRevision(product, { ...base(), artifactId: revised, guidance: 'Shorter still.', idempotencyKey: 'k-second' });
    const okSecond = second as Extract<typeof second, { status: 'ok' }>;
    const third = await seedArtifact(await runOnTask(okSecond.newTaskId));

    const middleR = await readArtifactLineage(product, { ...base(), artifactId: revised });
    const middle = middleR as Extract<typeof middleR, { status: 'ok' }>;
    expect(middle.revisedFrom?.originalArtifactId).toBe(original); // looks back
    expect(middle.revisions.map((v) => v.revisionId)).toEqual([okSecond.revision.revisionId]); // and forward

    const lastR = await readArtifactLineage(product, { ...base(), artifactId: third });
    const last = lastR as Extract<typeof lastR, { status: 'ok' }>;
    expect(last.revisedFrom?.originalArtifactId).toBe(revised);
  });

  test('an artifact with NO revisions is honest about it - empty, not absent', async () => {
    const plain = await seedArtifact(await runningRun());
    const plainR = await readArtifactLineage(product, { ...base(), artifactId: plain });
    const r = plainR as Extract<typeof plainR, { status: 'ok' }>;
    expect(r.revisedFrom).toBeNull();
    expect(r.revisions).toEqual([]);
  });

  // ── tenancy ───────────────────────────────────────────────────────────────────────────────────────────────
  test('a VIEWER may read lineage - documents are a member read (API-CONTRACTS "Member (read)")', async () => {
    const { original } = await revisedPair();
    const r = await readArtifactLineage(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, artifactId: original });
    expect(r.status).toBe('ok');
  });

  test('another COMPANY sees it as ABSENT, never as a refusal that confirms it exists', async () => {
    const { original } = await revisedPair();
    expect(await readArtifactLineage(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, artifactId: original })).toEqual({ status: 'artifact_not_found' });
  });
});
