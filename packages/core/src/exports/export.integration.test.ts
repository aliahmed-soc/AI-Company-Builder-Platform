// ACBP-P7-001 / CDR-078 — real-PostgreSQL proof of exportCompanyData through the RESTRICTED role.
//
// The three acceptance criteria are proven here directly: "archive matches in-product data" (the archive is read
// back and compared against the database, per collection), "zero secrets" (a synthetic high-entropy token planted
// in a text column and in a JSON leaf appears in no object), and "cross-tenant denied" (B's rows never appear in
// A's archive, and B's owner cannot export A). Plus canon's failure behaviour — partial export ENUMERATES what is
// missing — and the classification coverage guard, which is anchored on `information_schema` rather than on the
// `DatabaseSchema` interface the export reads through, so a wrong entry in one cannot excuse itself in the other.
//
// Skips when ACBP_TEST_DATABASE_URL is unset. Secrets are SYNTHETIC high-entropy tokens, never real credentials.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { InMemoryObjectStorage } from '@acbp/adapters';
import { EXPORT_COLLECTIONS, exportCoverage, companyPrefix, toObjectKey, manifestIsFaithful } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createMemoryItem } from '../memory/index.js';
import { exportCompanyData } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
// Synthetic high-entropy tokens — never a real credential. The blocklist catches them on entropy, so no
// provider-shaped fixture (and therefore no secret-scanner allowlist entry) is needed.
const SECRET_IN_TEXT = 'aB3dEfGh1jKlMnOp2qRsTuVwXyZ3456789012345678';
const SECRET_IN_JSON = 'zQ9wErTy7uIoPaSdFgHjKlZxCvBnM123456789098765';
const NOW = new Date('2026-08-05T12:00:00.000Z');

describe.skipIf(!hasTestDatabase)('export of owned data (real PostgreSQL, restricted role) — ACBP-P7-001/CDR-078', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let storage: InMemoryObjectStorage;
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
    storage = new InMemoryObjectStorage();
  });

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const run = (over: Parameters<typeof exportCompanyData>[3] = {}) => exportCompanyData(product, storage, base(), { now: NOW, ...over });

  /** Read one archive object back as parsed JSON. Nothing is asserted from what the export RETURNED. */
  async function readObject(path: string): Promise<{ collection: string; rowCount: number; rows: Record<string, unknown>[] }> {
    const got = await storage.get(toObjectKey(path));
    const bytes = got.body instanceof Uint8Array ? got.body : new Uint8Array();
    return JSON.parse(new TextDecoder().decode(bytes)) as { collection: string; rowCount: number; rows: Record<string, unknown>[] };
  }

  /** Every byte the archive holds, concatenated — the only honest way to ask "is the secret ANYWHERE in it". */
  async function allArchiveText(): Promise<string> {
    const parts: string[] = [];
    for (const key of storage.keys()) {
      const got = await storage.get(toObjectKey(key));
      parts.push(new TextDecoder().decode(got.body as Uint8Array));
    }
    return parts.join('\n');
  }

  const exportAudits = async () => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'artifact.exported').execute();

  test('ARCHIVE MATCHES IN-PRODUCT DATA: every exported row is in the archive, and the manifest counts it', async () => {
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'We sell single-origin coffee in Cairo.', sourceType: 'interview_answer', sourceRef: 'q:1' });
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'Our customers are independent cafés.', sourceType: 'interview_answer', sourceRef: 'q:2' });

    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // The comparison anchor is the DATABASE, read separately — not the numbers the export reported about itself.
    const inProduct = await owner.kysely.selectFrom('memory_items').selectAll().where('company_id', '=', w.companyA1).execute();
    expect(inProduct).toHaveLength(2);

    const item = result.manifest.items.find((i) => i.itemId === 'memory_items');
    expect(item?.rowCount).toBe(inProduct.length);

    const archived = await readObject(item?.path ?? '');
    expect(archived.rows).toHaveLength(inProduct.length);
    expect(archived.rows.map((r) => r['id']).sort()).toEqual(inProduct.map((r) => r.id).sort());
    expect(JSON.stringify(archived.rows)).toContain('single-origin coffee');
  });

  test('EVERY declared collection is written, and each object lives under this company’s prefix', async () => {
    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    // A collection declared but never written would be an archive quietly missing a category of the founder's work.
    expect(result.manifest.items.map((i) => i.itemId)).toEqual(EXPORT_COLLECTIONS.map((c) => c.table));
    // Invariant 19 pathing (ADR-016): the archive cannot be addressed from outside the company's own prefix.
    const prefix = companyPrefix(w.companyA1);
    for (const key of storage.keys()) expect(key.startsWith(prefix)).toBe(true);
    expect(storage.keys()).toContain(result.manifestKey);
  });

  test('ZERO SECRETS: a token planted in a text column and in a JSON leaf reaches no object in the archive', async () => {
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: `Our API key is ${SECRET_IN_TEXT}.`, sourceType: 'interview_answer', sourceRef: 'q:ops' });
    // `policies.rules` is a jsonb ARRAY, so this secret sits at `rules[0].note` — two levels down. The recursive
    // walk (CDR-078 §6.2) is the only thing that reaches it; a sanitizer that looked at top-level columns would
    // ship it, and every other test here would still be green.
    await owner.kysely
      .insertInto('policies')
      .values({
        account_id: w.accountA,
        company_id: w.companyA1,
        version: 1,
        baseline: 'require_approval',
        rules: JSON.stringify([{ id: 'r-1', note: `contact key ${SECRET_IN_JSON}` }]),
        autonomy_level: 2,
        created_by_user_id: w.aOwner,
      })
      .execute();

    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const text = await allArchiveText();
    expect(text).not.toContain(SECRET_IN_TEXT);
    expect(text).not.toContain(SECRET_IN_JSON);
    expect(text).toContain('[REDACTED_SECRET]');
    // The archive DIFFERS from the product now, and says so. `complete` alone cannot express that.
    expect(result.manifest.redactionCount).toBeGreaterThan(0);
    expect(result.manifest.complete).toBe(true);
    expect(manifestIsFaithful(result.manifest)).toBe(false);
  });

  test('CROSS-TENANT DENIED: B’s data is absent from A’s archive, and B’s owner cannot export A', async () => {
    await createMemoryItem(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, type: 'user_fact', content: 'Beta One runs a bakery supply chain.', sourceType: 'interview_answer', sourceRef: 'q:1' });
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'Alpha One roasts coffee.', sourceType: 'interview_answer', sourceRef: 'q:1' });

    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const text = await allArchiveText();
    expect(text).toContain('Alpha One roasts coffee');
    expect(text).not.toContain('bakery supply chain');
    expect(text).not.toContain(w.companyB1);

    // And the request cannot reach across: B's owner naming A's ids is refused without confirming A exists.
    const crossed = await exportCompanyData(product, storage, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 }, { now: NOW });
    expect(crossed).toEqual({ status: 'forbidden' });
  });

  test('OWNER ONLY: a viewer who may read the data in-product may not take an archive of it', async () => {
    const asViewer = await exportCompanyData(product, storage, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 }, { now: NOW });
    expect(asViewer).toEqual({ status: 'forbidden' });
    // Nothing was written on the refused path — a forbidden export must not leave an archive behind.
    expect(storage.keys()).toEqual([]);
    expect(await exportAudits()).toHaveLength(0);
  });

  test('the manifest is stamped from the RESOLVED scope, never from the request', async () => {
    // Invariant 19 / CDR-078 §6-G5. The ids are equal here only because this call path made them equal; the
    // assertion is that the manifest carries what the SERVER verified.
    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.manifest.accountId).toBe(w.accountA);
    expect(result.manifest.companyId).toBe(w.companyA1);
    expect(result.manifest.generatedAt).toBe(NOW.toISOString());
  });

  test('PARTIAL EXPORT ENUMERATES MISSING: a truncated collection ships what it can and names itself', async () => {
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'First fact.', sourceType: 'interview_answer', sourceRef: 'q:1' });
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'Second fact.', sourceType: 'interview_answer', sourceRef: 'q:2' });

    const result = await run({ maxRowsPerCollection: 1 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const omission = result.manifest.omissions.find((o) => o.itemType === 'memory_items');
    expect(omission?.reason).toBe('truncated');
    expect(result.manifest.complete).toBe(false);
    // What it COULD include is still included — a partial answer, not no answer (CDR-078 §3-G4).
    const item = result.manifest.items.find((i) => i.itemId === 'memory_items');
    expect(item?.rowCount).toBe(1);
    expect((await readObject(item?.path ?? '')).rows).toHaveLength(1);
  });

  test('the export is AUDITED with counts and digests, and no content', async () => {
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: `Key ${SECRET_IN_TEXT} and a plan.`, sourceType: 'interview_answer', sourceRef: 'q:1' });
    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;

    const audits = await exportAudits();
    expect(audits).toHaveLength(1);
    const row = audits[0]!;
    expect(row.subject_id).toBe(result.exportId);
    expect(row.subject_type).toBe('export');
    expect(row.company_id).toBe(w.companyA1);
    const payload = row.payload as Record<string, unknown>;
    expect(payload['collection_count']).toBe(EXPORT_COLLECTIONS.length);
    expect(payload['item_count']).toBe(result.manifest.itemCount);
    expect(payload['redaction_count']).toBeGreaterThan(0);
    expect(payload['faithful']).toBe(false);
    expect(payload['complete']).toBe(true);
    expect(String(payload['manifest_digest'])).toMatch(/^[0-9a-f]{64}$/);
    // The audit trail is permanent; the founder's data must not be in it, redacted or otherwise.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(SECRET_IN_TEXT);
    expect(serialized).not.toContain('and a plan');
  });

  test('refuses the whole export when storage reports success for bytes that never landed', async () => {
    // TASK-005's quiet failure half. A manifest listing files that are not there is a document that agrees with
    // itself and disagrees with reality — and the audit event must not exist to vouch for it.
    //
    // THE ASSERTION IS ON THE OUTCOME, NOT THE MESSAGE. An earlier version matched `/did not land/` and failed in
    // CI: the throw happens inside the company scope, so `withAccountTransaction` sanitises it into a bounded
    // `PlatformError` before any caller sees it — the charter's rule working exactly as intended. The raw reason
    // still reaches the LOG via the cause chain, which is where an operator needs it. What matters here is that
    // the export refuses and leaves no record vouching for an archive that is not there.
    storage.dropNextPut();
    await expect(run()).rejects.toThrow();
    expect(await exportAudits()).toHaveLength(0);
  });

  test('RE-RUNNABLE: a second export writes a fresh prefix and reproduces every collection digest', async () => {
    await createMemoryItem(product, { ...base(), type: 'user_fact', content: 'Stable content.', sourceType: 'interview_answer', sourceRef: 'q:1' });
    const first = await run();
    const second = await run();
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (first.status !== 'ok' || second.status !== 'ok') return;

    expect(second.exportId).not.toBe(first.exportId);
    // Identical digests are what make the per-item sha256 meaningful: without a total ORDER BY these would differ
    // run to run, and a founder checking an archive against its inventory could not tell reorder from corruption.
    const digests = (r: typeof first) => (r.status === 'ok' ? r.manifest.items.map((i) => `${i.itemId}:${i.sha256}`) : []);
    expect(digests(second)).toEqual(digests(first));
    // The first archive is untouched — a re-run corrupts no earlier state (CDR-078 §3-G9).
    expect(storage.keys()).toContain(first.manifestKey);
  });

  test('THE CLASSIFICATION COVERS THE LIVE SCHEMA: no company-scoped table is unruled, and no ruling is stale', async () => {
    // CDR-078 §6-G2, and the single most valuable test in this file. A future migration adding a company-scoped
    // table fails HERE — before an archive silently stops matching the product. Anchored on `information_schema`,
    // deliberately a different source from the `DatabaseSchema` interface the export itself reads through.
    const rows = await sql<{ table_name: string }>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'company_id'
      order by table_name
    `.execute(owner.kysely);
    const live = rows.rows.map((r) => r.table_name);
    expect(live.length).toBeGreaterThan(0); // the query itself must not be the thing that is empty
    expect(exportCoverage(live)).toEqual({ unclassified: [], stale: [] });
  });

  test('an EXCLUDED table’s contents never appear in the archive, even when they exist', async () => {
    // The exclusions are rulings (CDR-078 §6.3), and a ruling nothing enforces is a comment. `audit_events` has
    // its own export surface; `company_memberships` names other people. Both are populated by the fixture.
    const result = await run();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.manifest.items.map((i) => i.itemId)).not.toContain('audit_events');
    expect(result.manifest.items.map((i) => i.itemId)).not.toContain('company_memberships');
    for (const key of storage.keys()) {
      expect(key).not.toContain('audit_events.json');
      expect(key).not.toContain('memberships.json');
    }
    // And the viewer seeded on company A — a real second person — is not named anywhere in the archive.
    expect(await allArchiveText()).not.toContain(w.aViewer);
  });
});
