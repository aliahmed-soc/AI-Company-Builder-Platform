// ACBP-P5-011 / CDR-060 — `persistArtifact` against a REAL database and a storage adapter that can LIE.
//
// The claim under test is TASK-005's: *"persistence failure ⇒ failed, never hollow success"*. Two of the three ways
// that can go wrong are invisible to a test whose storage always works, so the fixture can report success and store
// nothing (`dropNextPut`) or store part of what it reports (`truncateNextPut`).
//
// EVERY no-hollow-success test asserts BOTH halves: the call refuses, AND no row exists afterwards. Asserting only
// the refusal would pass against an implementation that refuses and writes the row anyway — which is the bug.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { InMemoryObjectStorage } from '@acbp/adapters';
import { companyPrefix } from '@acbp/contracts';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { persistArtifact, getArtifact, listRunArtifacts, type PersistArtifactParams } from './persist.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const CONTENT = '# Market research\n\nEvidence-backed findings.';
const CONTENT_BYTES = new TextEncoder().encode(CONTENT).byteLength;

describe.skipIf(!hasTestDatabase)('persistArtifact (real PostgreSQL + a storage adapter that can lie) — ACBP-P5-011/CDR-060', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let storage: InMemoryObjectStorage;
  let runA = '';
  let runA2 = '';
  let runB = '';

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

    // Runs are seeded as the OWNER role: `task_runs` is the coordinator's to write, and this suite is about what
    // happens AFTER a run exists, not about how it got there.
    const taskA = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'running', 'produce research', ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    const taskB = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${w.accountB}::uuid, ${w.companyB1}::uuid, 'running', 'produce research', ${w.bOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    runA = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${taskA}::uuid, 1) returning id`.execute(owner.kysely)).rows[0]!.id;
    // A SECOND attempt of the same task: without it, "a different run producing identical bytes keeps its own
    // provenance" cannot be expressed, and the uniqueness bug this design avoids would pass unnoticed.
    runA2 = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${taskA}::uuid, 2) returning id`.execute(owner.kysely)).rows[0]!.id;
    runB = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountB}::uuid, ${w.companyB1}::uuid, ${taskB}::uuid, 1) returning id`.execute(owner.kysely)).rows[0]!.id;
  }, 60_000);

  function persist(over: Partial<PersistArtifactParams> = {}) {
    return persistArtifact(product, storage, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId: runA, workerId: 'research', workerVersion: 1, modelVersion: 'fake@1', title: 'Market research', format: 'markdown', content: CONTENT, ...over });
  }

  async function artifactRowCount(): Promise<number> {
    const r = await sql<{ n: string }>`select count(*)::text as n from artifacts`.execute(owner.kysely);
    return Number(r.rows[0]!.n);
  }

  describe('the happy path', () => {
    test('writes the object, then the row, and the row describes what was written', async () => {
      const result = await persist();
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      expect(result.deduplicated).toBe(false);
      expect(result.artifact.sizeBytes).toBe(CONTENT_BYTES);
      expect(result.artifact.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.artifact.runId).toBe(runA);
      expect(result.artifact.workerId).toBe('research');
      expect(result.artifact.modelVersion).toBe('fake@1');

      // The object is really there, under this company's prefix and nobody else's (trust-critical #2).
      expect(storage.keys()).toEqual([result.artifact.objectKey]);
      expect(result.artifact.objectKey.startsWith(companyPrefix(w.companyA1))).toBe(true);
      expect(result.artifact.objectKey.startsWith(companyPrefix(w.companyB1))).toBe(false);
    });

    test('the same run re-writing the same bytes is idempotent, and says so', async () => {
      const first = await persist();
      const second = await persist();
      expect(first.status).toBe('ok');
      expect(second).toMatchObject({ status: 'ok', deduplicated: true });
      if (first.status === 'ok' && second.status === 'ok') expect(second.artifact.id).toBe(first.artifact.id);
      expect(await artifactRowCount()).toBe(1);
    });

    test('a DIFFERENT run producing identical bytes gets its OWN row — provenance is never inherited', async () => {
      await persist();
      expect(await persist({ runId: runA2 })).toMatchObject({ status: 'ok', deduplicated: false });
      expect(await artifactRowCount()).toBe(2);
      // Two honest rows, one stored object: identical bytes in one company are one object by construction.
      expect(storage.keys()).toHaveLength(1);
    });
  });

  describe('NO HOLLOW SUCCESS (TASK-005) — the row never outruns the object', () => {
    test('a storage write that THROWS refuses, and writes no row', async () => {
      storage.failNextPut('provider unavailable');
      expect(await persist()).toMatchObject({ status: 'storage_failed' });
      expect(await artifactRowCount()).toBe(0);
    });

    test('a storage write that REPORTS SUCCESS while storing nothing refuses, and writes no row', async () => {
      // The failure mode that survives a naive implementation: `put` resolved, so a caller trusting its return value
      // records the artifact and a founder is told their research is saved. Only the read-back catches it.
      storage.dropNextPut();
      expect(await persist()).toMatchObject({ status: 'storage_unverified', reason: 'object_missing' });
      expect(await artifactRowCount()).toBe(0);
    });

    test('a TRUNCATED write refuses, and writes no row — half a document is not a document', async () => {
      storage.truncateNextPut(5);
      expect(await persist()).toMatchObject({ status: 'storage_unverified', reason: 'size_mismatch' });
      expect(await artifactRowCount()).toBe(0);
    });

    test('after a refusal the same run can RETRY and ends with exactly one artifact', async () => {
      // The recovery half of `FAILURE-AND-RECOVERY` row 7 — content-addressed writes are safe to retry. A refusal
      // that left the run unable to retry would trade one failure for a worse one.
      storage.dropNextPut();
      expect(await persist()).toMatchObject({ status: 'storage_unverified' });
      expect(await persist()).toMatchObject({ status: 'ok', deduplicated: false });
      expect(await artifactRowCount()).toBe(1);
    });
  });

  describe('refusals that never reach storage at all', () => {
    test('content over the 8 MiB cap is refused, and NOTHING is written — not even the object', async () => {
      expect(await persist({ content: 'x'.repeat(8 * 1024 * 1024 + 1) })).toMatchObject({ status: 'refused', reason: 'too_large' });
      expect(storage.keys()).toEqual([]);
      expect(await artifactRowCount()).toBe(0);
    });

    test('empty content is refused — a zero-byte artifact is the hollow success wearing a row', async () => {
      expect(await persist({ content: '' })).toMatchObject({ status: 'refused', reason: 'invalid_size' });
      expect(storage.keys()).toEqual([]);
    });

    test('blank provenance is refused before anything is stored', async () => {
      expect(await persist({ workerId: '   ' })).toMatchObject({ status: 'refused', reason: 'incomplete_provenance' });
      expect(await persist({ modelVersion: '' })).toMatchObject({ status: 'refused', reason: 'incomplete_provenance' });
      expect(storage.keys()).toEqual([]);
      expect(await artifactRowCount()).toBe(0);
    });
  });

  describe('tenancy', () => {
    test('citing a run in ANOTHER company refuses, writes no row, AND leaves no orphaned object', async () => {
      // Review pass 1 changed this from a raw throw to a typed refusal. The composite FK would have refused the row
      // regardless — referential integrity always bypasses RLS, so the FK is the structural guarantee — but it
      // refuses at the INSERT, by which point the bytes are already written. The pre-check moves the refusal in
      // front of the object write, so the third assertion below is the one that would have failed before.
      expect(await persist({ runId: runB })).toMatchObject({ status: 'run_not_found' });
      expect(await artifactRowCount()).toBe(0);
      expect(storage.keys()).toEqual([]);
    });

    test('an entirely unknown run refuses the same way — no object, no row', async () => {
      expect(await persist({ runId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' })).toMatchObject({ status: 'run_not_found' });
      expect(storage.keys()).toEqual([]);
      expect(await artifactRowCount()).toBe(0);
    });

    test("a member of another company cannot write into this company's prefix, and no bytes are left behind", async () => {
      const result = await persistArtifact(product, storage, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, runId: runA, workerId: 'research', workerVersion: 1, modelVersion: 'fake@1', title: 'x', format: 'markdown', content: CONTENT });
      expect(result).toMatchObject({ status: 'forbidden' });
      // AUTHORIZED BEFORE THE WRITE. If the check came after the put, an unauthorized caller could still place bytes
      // in another tenant's prefix and only be stopped at the row — bytes that the row-level refusal never cleans up.
      expect(storage.keys()).toEqual([]);
      expect(await artifactRowCount()).toBe(0);
    });

    test('a VIEWER cannot persist an artifact — writing is `run:execute`, which is owner-only', async () => {
      expect(await persist({ userId: w.aViewer })).toMatchObject({ status: 'forbidden' });
      expect(storage.keys()).toEqual([]);
      expect(await artifactRowCount()).toBe(0);
    });

    test('reads are company-scoped', async () => {
      const written = await persist();
      if (written.status !== 'ok') throw new Error('setup failed');
      expect(await getArtifact(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, artifactId: written.artifact.id })).toMatchObject({ id: written.artifact.id });
      // Not "forbidden" — company B genuinely cannot see it, which is what RLS is for.
      expect(await getArtifact(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, artifactId: written.artifact.id })).toBe('not_found');
      expect(await listRunArtifacts(product, { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, runId: runA })).toHaveLength(1);
      expect(await listRunArtifacts(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, runId: runA })).toHaveLength(0);
      // A VIEWER may read — `task:read` is owner + viewer.
      expect(await listRunArtifacts(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, runId: runA })).toHaveLength(1);
    });
  });
});
