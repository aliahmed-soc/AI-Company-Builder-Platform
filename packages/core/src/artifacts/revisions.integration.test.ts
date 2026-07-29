// ACBP-P5-012 — real-PostgreSQL proof of the artifact_revisions table, through the RESTRICTED role (CDR-064).
//
// What this slice has to prove is structural, not behavioural: the row is append-only, dual-keyed, tenant-pinned at
// BOTH ends, idempotent per key, and the original artifact is untouchable. The use case is slice 3.
//
// Skips when ACBP_TEST_DATABASE_URL is unset - a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { ArtifactRevisionRepository, TaskRepository, type DatabaseClient } from '@acbp/database';
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
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const RLS_VIOLATION = '42501';
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';

/** The platform sanitises database errors, so the SQLSTATE is reached by walking the cause chain. */
function sqlState(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur !== null && cur !== undefined; i += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('artifact revisions (real PostgreSQL, restricted role) — ACBP-P5-012/CDR-064', () => {
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

  const rows = async () => owner.kysely.selectFrom('artifact_revisions').selectAll().execute();

  /** A task in `draft` - what a revision request creates (J-13: "new linked task created"). */
  async function newTask(companyId = w.companyA1, userId = w.aOwner, accountId = w.accountA): Promise<string> {
    const params = { userId, accountId, companyId };
    const t = await createTask(product, { ...params, title: 'Revise the market research', description: null, milestoneId: null });
    expect(t.status).toBe('ok');
    return (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
  }

  /** Carry an EXISTING task to a running run - the re-execution half of J-13. */
  async function runOnTask(taskId: string, companyId = w.companyA1, userId = w.aOwner, accountId = w.accountA): Promise<string> {
    const params = { userId, accountId, companyId };
    expect((await planTask(product, { ...params, taskId })).status).toBe('ok');
    const moved = await asRestricted(product, { account: accountId, company: companyId }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    expect(moved).toBe(1);
    const r = await startRun(product, { ...params, taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; run: { id: string } }).run.id;
  }

  /** A task carried to a RUNNING run — what an artifact attaches to. */
  async function runningRun(companyId = w.companyA1, userId = w.aOwner, accountId = w.accountA): Promise<string> {
    const params = { userId, accountId, companyId };
    const t = await createTask(product, { ...params, title: 'Research the market', description: null, milestoneId: null });
    const taskId = (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...params, taskId })).status).toBe('ok');
    const moved = await asRestricted(product, { account: accountId, company: companyId }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    expect(moved).toBe(1);
    const r = await startRun(product, { ...params, taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; run: { id: string } }).run.id;
  }

  /**
   * An artifact, written as the OWNER role — the product role's own persist path is P5-011's, not this ticket's.
   *
   * Each gets a DISTINCT content hash: `artifacts_company_content_run_uq` is `(company_id, content_hash, run_id)`,
   * and two fixtures colliding on it would fail for a reason that has nothing to do with what is under test.
   */
  let artifactSeq = 0;
  async function seedArtifact(runId: string, companyId = w.companyA1, accountId = w.accountA): Promise<string> {
    artifactSeq += 1;
    const hash = artifactSeq.toString(16).padStart(64, 'a');
    const r = await sql<{ id: string }>`
      insert into artifacts (account_id, company_id, object_key, content_hash, format, size_bytes, run_id, worker_id, worker_version, model_version, title)
      values (${accountId}, ${companyId}, ${'company/' + companyId.toLowerCase() + '/' + hash}, ${hash}, 'markdown', 128, ${runId}, 'research', 1, 'fake-1', 'Market research')
      returning id
    `.execute(owner.kysely);
    return r.rows[0]?.id ?? '';
  }

  async function insertRevision(originalId: string, newTaskId: string, over: Partial<{ key: string; guidance: string; companyId: string; accountId: string }> = {}) {
    return asRestricted(product, { account: over.accountId ?? w.accountA, company: over.companyId ?? w.companyA1 }, (db) =>
      new ArtifactRevisionRepository(db).insert({
        accountId: over.accountId ?? w.accountA,
        companyId: over.companyId ?? w.companyA1,
        originalArtifactId: originalId,
        newTaskId,
        guidance: over.guidance ?? 'Shorten the summary to one page.',
        idempotencyKey: over.key ?? 'rev-1',
        requestedByUserId: w.aOwner,
      }),
    );
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from artifact_revisions`.execute(owner.kysely);
    await sql`delete from artifacts`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  // ── the happy path ────────────────────────────────────────────────────────────────────────────────────────
  test('the restricted role can record a revision request, and it carries BOTH ends of the lineage', async () => {
    const originalRun = await runningRun();
    const original = await seedArtifact(originalRun);
    const revisionTask = await newTask();

    const row = await insertRevision(original, revisionTask);
    expect(row?.original_artifact_id).toBe(original);
    expect(row?.new_task_id).toBe(revisionTask);
    expect(row?.guidance).toBe('Shorten the summary to one page.');
  });

  test('THE ORIGINAL IS UNTOUCHED - byte for byte - after a revision is requested', async () => {
    // "Original never overwritten" is the backlog's failure behaviour, and it is structural: `artifacts` has no
    // UPDATE grant at all. This asserts the OUTCOME rather than the grant, so it would catch a future migration
    // that added one and a use case that used it.
    const originalRun = await runningRun();
    const original = await seedArtifact(originalRun);
    const before = await owner.kysely.selectFrom('artifacts').selectAll().where('id', '=', original).executeTakeFirst();

    await insertRevision(original, await newTask());

    const after = await owner.kysely.selectFrom('artifacts').selectAll().where('id', '=', original).executeTakeFirst();
    expect(after).toEqual(before);
  });

  // ── append-only ───────────────────────────────────────────────────────────────────────────────────────────
  test('the restricted role can INSERT and SELECT, and can NEITHER update NOR delete a revision', async () => {
    const original = await seedArtifact(await runningRun());
    const row = await insertRevision(original, await newTask());
    const id = row?.id ?? '';

    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      await expect(sql`update artifact_revisions set guidance = 'rewritten' where id = ${id}::uuid`.execute(db)).rejects.toBeDefined();
    });
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      await expect(sql`delete from artifact_revisions where id = ${id}::uuid`.execute(db)).rejects.toBeDefined();
    });
    // Still exactly as written: neither refusal was a silent no-op.
    expect((await rows())[0]?.guidance).toBe('Shorten the summary to one page.');
  });

  test('the app role holds NO column-level UPDATE grant on artifact_revisions - not even one', async () => {
    // A table-level revoke with a column-level grant left behind would let a later writer rewrite the reason a run
    // exists. Asserted against the catalog, because that is the only place the answer is not a matter of opinion.
    const r = await sql<{ column_name: string }>`
      select column_name from information_schema.column_privileges
      where table_name = 'artifact_revisions' and grantee = 'acbp_app' and privilege_type = 'UPDATE'
    `.execute(owner.kysely);
    expect(r.rows).toEqual([]);
  });

  // ── idempotency (CDR-064 G3) ──────────────────────────────────────────────────────────────────────────────
  test('ONE REQUEST PER KEY: the same key returns undefined the second time, and writes nothing', async () => {
    const original = await seedArtifact(await runningRun());
    const first = await insertRevision(original, await newTask(), { key: 'same-key' });
    expect(first).toBeDefined();

    const second = await insertRevision(original, await newTask(), { key: 'same-key' });
    expect(second).toBeUndefined(); // ON CONFLICT DO NOTHING - a retry, not a fault
    expect(await rows()).toHaveLength(1);
  });

  test('a DIFFERENT key on the same artifact is allowed - two genuine revision requests are not one', async () => {
    // Rejected alternative in CDR-064 G3: keying on (artifact, guidance). A founder who reads the first result and
    // asks again for the same thing is making a second real request, and collapsing it would refuse them silently.
    const original = await seedArtifact(await runningRun());
    expect(await insertRevision(original, await newTask(), { key: 'k1' })).toBeDefined();
    expect(await insertRevision(original, await newTask(), { key: 'k2' })).toBeDefined();
    expect(await rows()).toHaveLength(2);
  });

  test('the SAME key in a DIFFERENT company is allowed - the key is company-scoped, not global', async () => {
    const originalA = await seedArtifact(await runningRun());
    expect(await insertRevision(originalA, await newTask(), { key: 'shared' })).toBeDefined();

    const runB = await runningRun(w.companyB1, w.bOwner, w.accountB);
    const originalB = await seedArtifact(runB, w.companyB1, w.accountB);
    const revisionTaskB = await newTask(w.companyB1, w.bOwner, w.accountB);
    const rowB = await asRestricted(product, { account: w.accountB, company: w.companyB1 }, (db) =>
      new ArtifactRevisionRepository(db).insert({
        accountId: w.accountB,
        companyId: w.companyB1,
        originalArtifactId: originalB,
        newTaskId: revisionTaskB,
        guidance: 'Different company, same key.',
        idempotencyKey: 'shared',
        requestedByUserId: w.bOwner,
      }),
    );
    expect(rowB).toBeDefined();
    expect(await rows()).toHaveLength(2);
  });

  test('ONE REVISION PER TASK - a task cannot be claimed as the revision of two different artifacts', async () => {
    // Without this the lineage is ambiguous: an artifact produced by a run of that task would have two possible ancestors,
    // and the derived link (CDR-064 G1) would have to pick one arbitrarily.
    const first = await seedArtifact(await runningRun());
    const second = await seedArtifact(await runningRun());
    const sharedTask = await newTask();
    expect(await insertRevision(first, sharedTask, { key: 'k1' })).toBeDefined();
    await expect(insertRevision(second, sharedTask, { key: 'k2' })).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
  });

  // ── the guidance guard ────────────────────────────────────────────────────────────────────────────────────
  test('BLANK guidance is refused by the DATABASE, not only by the contract', async () => {
    const original = await seedArtifact(await runningRun());
    const task = await newTask();
    for (const blank of ['', '   ']) {
      await expect(insertRevision(original, task, { guidance: blank })).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    }
  });

  test('the guidance bound is measured in CHARACTERS, so emoji prose is not penalised', async () => {
    // `char_length`, not `octet_length`: a byte limit would refuse a shorter piece of Arabic or emoji prose than of
    // English, which is a silent penalty on non-Latin scripts rather than a real limit. A 2000-emoji guidance is
    // ~8000 bytes and must still be accepted, because the contract accepts it.
    const original = await seedArtifact(await runningRun());
    const wide = '\u{1F600}'.repeat(REVISION_GUIDANCE_MAX);
    expect(await insertRevision(original, await newTask(), { guidance: wide, key: 'wide' })).toBeDefined();
    await expect(insertRevision(original, await newTask(), { guidance: 'x'.repeat(REVISION_GUIDANCE_MAX + 1), key: 'long' })).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === CHECK_VIOLATION,
    );
  });

  // ── tenant pinning, both ends ─────────────────────────────────────────────────────────────────────────────
  test('TENANT-PINNED: a revision cannot cite an artifact from another company', async () => {
    // RI checks always bypass RLS, so a single-column FK would let the lineage cross a tenant boundary and never be
    // policy-checked. The whole value of this row is the link; a link that can leave the tenant is worse than none.
    const runB = await runningRun(w.companyB1, w.bOwner, w.accountB);
    const foreignArtifact = await seedArtifact(runB, w.companyB1, w.accountB);
    await expect(insertRevision(foreignArtifact, await newTask())).rejects.toSatisfy((e: unknown) => sqlState(e) === FK_VIOLATION);
  });

  test('TENANT-PINNED: a revision cannot cite a TASK from another company', async () => {
    const original = await seedArtifact(await runningRun());
    const foreignTask = await newTask(w.companyB1, w.bOwner, w.accountB);
    await expect(insertRevision(original, foreignTask)).rejects.toSatisfy((e: unknown) => sqlState(e) === FK_VIOLATION);
  });

  // ── RLS ───────────────────────────────────────────────────────────────────────────────────────────────────
  test('another COMPANY sees none of it, and cannot write into it', async () => {
    const original = await seedArtifact(await runningRun());
    await insertRevision(original, await newTask());

    await asRestricted(product, { account: w.accountA, company: w.companyA2 }, async (db) => {
      expect(await new ArtifactRevisionRepository(db).listForArtifact(original, 50)).toEqual([]);
    });
    // WELL-FORMED IN EVERY OTHER RESPECT, so RLS is the only thing left that can refuse it — the D11 lesson. A row
    // reusing an artifact id as the task id would die on the composite FK instead, and the test could not tell the
    // difference between "the tenant boundary held" and "the fixture was malformed".
    const taskInA1 = await newTask();
    await asRestricted(product, { account: w.accountA, company: w.companyA2 }, async (db) => {
      await expect(
        sql`insert into artifact_revisions (account_id, company_id, original_artifact_id, new_task_id, guidance, idempotency_key, requested_by_user_id)
            values (${w.accountA}, ${w.companyA1}, ${original}::uuid, ${taskInA1}::uuid, 'Cross-company write.', 'k-cross', ${w.aOwner})`.execute(db),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === RLS_VIOLATION);
    });
  });

  test('FAIL CLOSED without the company key: account scope alone sees nothing and cannot insert', async () => {
    const original = await seedArtifact(await runningRun());
    await insertRevision(original, await newTask());
    await asRestricted(product, { account: w.accountA }, async (db) => {
      expect(await new ArtifactRevisionRepository(db).listForArtifact(original, 50)).toEqual([]);
    });
  });

  // ── the lineage lookup (CDR-064 G1) ───────────────────────────────────────────────────────────────────────
  test('LINEAGE IS DERIVED end to end: artifact -> run -> task -> the revision it answers', async () => {
    // THE WHOLE POINT OF G1. Nothing on `artifacts` says "I am a revision of X". The chain is walked instead, so it
    // cannot drift, and a revision run that wrote three artifacts gives all three the same honest ancestor for free.
    const original = await seedArtifact(await runningRun());
    const revisionTask = await newTask();
    await insertRevision(original, revisionTask);

    // J-13's "re-execution": the NEW task runs, and its output is the new version.
    const revisionRun = await runOnTask(revisionTask);
    const produced = await seedArtifact(revisionRun);

    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      const producedRow = await db.selectFrom('artifacts').selectAll().where('id', '=', produced).executeTakeFirstOrThrow();
      const runRow = await db.selectFrom('task_runs').select('task_id').where('id', '=', producedRow.run_id).executeTakeFirstOrThrow();
      const ancestor = await new ArtifactRevisionRepository(db).findByTask(runRow.task_id);
      expect(ancestor?.original_artifact_id).toBe(original);
    });

    // BOTH VERSIONS RETAINED (the backlog's acceptance criterion): two artifacts, neither overwriting the other.
    const all = await owner.kysely.selectFrom('artifacts').select('id').execute();
    expect(all.map((a) => a.id).sort()).toEqual([original, produced].sort());
  });

  test('an artifact with NO revision has no ancestor - the lookup is honest about absence', async () => {
    const run = await runningRun();
    const artifact = await seedArtifact(run);
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      const runRow = await db.selectFrom('task_runs').select('task_id').where('id', '=', run).executeTakeFirstOrThrow();
      expect(await new ArtifactRevisionRepository(db).findByTask(runRow.task_id)).toBeUndefined();
      expect(await new ArtifactRevisionRepository(db).countForArtifact(artifact)).toBe(0);
    });
  });
});
