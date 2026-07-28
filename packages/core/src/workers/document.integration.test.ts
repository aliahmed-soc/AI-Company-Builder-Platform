// ACBP-P5-008 / CDR-063 — the document worker end to end, against a REAL database.
//
// The claim under test is WORK-004's failure clause: **"quality-check fail = draft marked needs-revision"**. This is
// the only worker of the three that PERSISTS on failure, so the assertions run the other way round from P5-006 and
// P5-007: the failing case must produce an artifact, and that artifact must say so in its own bytes.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { InMemoryObjectStorage } from '@acbp/adapters';
import type { DatabaseClient } from '@acbp/database';
import type { ModelGatewayRequest, ModelGatewayResult } from '@acbp/contracts';
import { DOCUMENT_TYPES, parseDocumentOutput } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { runDocumentWorker } from './document.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const BRIEF = 'Write the business plan for the gym platform.';
const CONTEXT = '- [fact] Three gyms in Manchester.';
const REFS = ['understanding:v3', 'decision:d-77'];

const section = (heading: string, body: string) => ({ heading, body });
const doc = (over: Record<string, unknown> = {}) => ({
  documentType: 'business_plan_generation',
  title: 'Business plan',
  contextRefs: REFS,
  sections: [section('Summary', 'A real summary with content.'), section('Market', 'A real market description.')],
  ...over,
});

function gatewayReturning(output: unknown, outcome: ModelGatewayResult['outcome'] = 'ok') {
  const calls: ModelGatewayRequest[] = [];
  const fn = (req: ModelGatewayRequest): Promise<ModelGatewayResult> => {
    calls.push(req);
    if (outcome !== 'ok') return Promise.resolve({ outcome, provider: 'fake', model: 'fake', modelVersion: 'fake@1', fallbackUsed: false, latencyMs: 1 } as ModelGatewayResult);
    const parsed = parseDocumentOutput(output);
    return Promise.resolve({ outcome: 'ok', validatedOutput: parsed.ok ? parsed.document : output, provider: 'fake', model: 'fake', modelVersion: 'fake@1', fallbackUsed: false, latencyMs: 1 } as ModelGatewayResult);
  };
  return { fn, calls };
}

describe.skipIf(!hasTestDatabase)('the document worker (real PostgreSQL) — ACBP-P5-008/CDR-063', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let storage: InMemoryObjectStorage;
  let runId = '';

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
    const task = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, task_type, created_by_user_id) values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'running', 'write the plan', 'business_plan_generation', ${w.aOwner}::uuid) returning id`.execute(owner.kysely)).rows[0]!.id;
    runId = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${task}::uuid, 1) returning id`.execute(owner.kysely)).rows[0]!.id;
  }, 60_000);

  const params = (over: Record<string, unknown> = {}) => ({
    userId: w.aOwner,
    accountId: w.accountA,
    companyId: w.companyA1,
    runId,
    documentType: 'business_plan_generation' as const,
    brief: BRIEF,
    context: CONTEXT,
    workerVersion: 1,
    modelVersion: 'fake@1',
    ...over,
  });

  async function artifactCount(): Promise<number> {
    const r = await sql<{ n: string }>`select count(*)::text as n from artifacts`.execute(owner.kysely);
    return Number(r.rows[0]!.n);
  }

  async function storedMarkdown(objectKey: string): Promise<string> {
    const stored = await storage.get(objectKey as never);
    return new TextDecoder().decode(stored.body as Uint8Array);
  }

  describe('a complete document', () => {
    test('persists, reports `complete`, and carries NO warning', async () => {
      const gateway = gatewayReturning(doc());
      const result = await runDocumentWorker(product, params(), { gateway: gateway.fn, storage });

      expect(result).toMatchObject({ status: 'ok', documentStatus: 'complete', failingSections: [] });
      if (result.status !== 'ok') return;
      expect(result.artifact.workerId).toBe('document');
      expect(await artifactCount()).toBe(1);

      const markdown = await storedMarkdown(result.artifact.objectKey);
      expect(markdown).not.toContain('NEEDS REVISION');
      expect(markdown).toContain('## Summary');
      for (const ref of REFS) expect(markdown).toContain(ref);
    });

    test('all THREE document types produce an artifact with provenance — the acceptance names three', async () => {
      for (const documentType of DOCUMENT_TYPES) {
        await sql`delete from artifacts`.execute(owner.kysely);
        const gateway = gatewayReturning(doc({ documentType }));
        const result = await runDocumentWorker(product, params({ documentType }), { gateway: gateway.fn, storage });
        expect(result, documentType).toMatchObject({ status: 'ok', documentStatus: 'complete' });
        expect(await artifactCount(), documentType).toBe(1);
        if (result.status !== 'ok') continue;
        expect(await storedMarkdown(result.artifact.objectKey), documentType).toContain(REFS[0] as string);
      }
    });
  });

  describe('WORK-004 — a failing quality check KEEPS the draft and labels it', () => {
    test('a placeholder section still persists, reports needs_revision, and names the section', async () => {
      const gateway = gatewayReturning(doc({ sections: [section('Summary', 'Real content.'), section('Market', 'TBD')] }));
      const result = await runDocumentWorker(product, params(), { gateway: gateway.fn, storage });

      // NOT a failure: the founder gets an editable draft rather than nothing.
      expect(result).toMatchObject({ status: 'ok', documentStatus: 'needs_revision', failingSections: ['Market'] });
      expect(await artifactCount()).toBe(1);
    });

    test('the warning is IN THE DOCUMENT, above the content — not just in the return value', async () => {
      // The whole ticket. A status that lives only in a return value or a column is the hollow success again: the
      // founder opens the artifact, sees no warning, and treats a draft as finished.
      const gateway = gatewayReturning(doc({ sections: [section('Summary', 'Real content.'), section('Market', '   ')] }));
      const result = await runDocumentWorker(product, params(), { gateway: gateway.fn, storage });
      if (result.status !== 'ok') throw new Error('expected an artifact');

      const markdown = await storedMarkdown(result.artifact.objectKey);
      expect(markdown).toContain('NEEDS REVISION');
      expect(markdown).toContain('Market');
      expect(markdown.indexOf('NEEDS REVISION')).toBeLessThan(markdown.indexOf('## Summary'));
      // And the empty section is visibly empty rather than silently absent.
      expect(markdown).toContain('_(empty — needs writing)_');
    });

    test('EVERY failing section is named in the document, not just the first', async () => {
      const gateway = gatewayReturning(doc({ sections: [section('A', 'TBD'), section('B', 'Real.'), section('C', '')] }));
      const result = await runDocumentWorker(product, params(), { gateway: gateway.fn, storage });
      expect(result).toMatchObject({ status: 'ok', documentStatus: 'needs_revision', failingSections: ['A', 'C'] });
      if (result.status !== 'ok') return;
      const markdown = await storedMarkdown(result.artifact.objectKey);
      expect(markdown).toContain('A, C');
    });
  });

  describe('what is still refused outright', () => {
    test('a document with NO provenance is refused — a build with no inputs is not a draft', async () => {
      const gateway = gatewayReturning(doc({ contextRefs: [] }));
      expect(await runDocumentWorker(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'no_provenance' });
      expect(await artifactCount()).toBe(0);
    });

    test('a document with no sections is refused', async () => {
      const gateway = gatewayReturning(doc({ sections: [] }));
      expect(await runDocumentWorker(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'unusable_output', reason: 'no_sections' });
      expect(await artifactCount()).toBe(0);
    });

    test('a blank brief is refused before the model is called', async () => {
      const gateway = gatewayReturning(doc());
      expect(await runDocumentWorker(product, params({ brief: '  ' }), { gateway: gateway.fn, storage })).toMatchObject({ status: 'blank_brief' });
      expect(gateway.calls).toHaveLength(0);
    });

    test('a gateway failure persists nothing', async () => {
      const gateway = gatewayReturning(null, 'error');
      expect(await runDocumentWorker(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'generation_failed' });
      expect(await artifactCount()).toBe(0);
    });
  });

  describe('tenancy and storage', () => {
    test("another company's owner cannot write a document into this company", async () => {
      const gateway = gatewayReturning(doc());
      expect(await runDocumentWorker(product, params({ userId: w.bOwner }), { gateway: gateway.fn, storage })).toMatchObject({ status: 'persist_failed', reason: 'forbidden' });
      expect(await artifactCount()).toBe(0);
      expect(storage.keys()).toEqual([]);
    });

    test('a storage write that lies about succeeding fails the run — including for a needs_revision draft', async () => {
      // The labelled-draft path goes through the same no-hollow-success rule as everything else: a draft that was
      // never stored must not be reported as stored just because it was only a draft.
      storage.dropNextPut();
      const gateway = gatewayReturning(doc({ sections: [section('Summary', 'TBD')] }));
      expect(await runDocumentWorker(product, params(), { gateway: gateway.fn, storage })).toMatchObject({ status: 'persist_failed' });
      expect(await artifactCount()).toBe(0);
    });

    test('this worker never fetches external content — internal tools only', async () => {
      const gateway = gatewayReturning(doc());
      await runDocumentWorker(product, params(), { gateway: gateway.fn, storage });
      const prompt = gateway.calls[0]?.contextParts.map((p) => p.content).join('\n') ?? '';
      expect(prompt).toContain(CONTEXT);
      expect(prompt).not.toContain('untrusted source material');
    });
  });
});
