// ACBP-P5-011 / CDR-060 — real-PostgreSQL proof of `artifacts` under the RESTRICTED role. Setup/seed on the superuser
// (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
//
// The property this ticket is judged on is TRUST-CRITICAL #2 — prefix isolation — so the tests that matter most are
// the ones proving a tenant boundary holds where RLS alone cannot reach it: the referential-integrity check (which
// ALWAYS bypasses RLS) and the object key itself (which is just a string, and would happily name another company's
// object if nothing forbade it).
//
// Proves: dual-keyed SELECT/INSERT (fail-closed without the company key; cross-company read impossible; cross-tenant
// insert refused); the TENANT-PINNED run FK; the company-prefix CHECK on `object_key`; append-only privileges (no
// UPDATE, no DELETE, not even column-level); the 8 MiB cap, sha256 shape, format, provenance and title CHECKs;
// content-addressed idempotence keyed on the RUN (same run + same bytes collapses, a DIFFERENT run keeps its own
// honest provenance, a different company is a separate keyspace); FK cascade; catalog (FORCE RLS, grants, 0043
// applied). Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, closeDatabase, migrateToLatest, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `art_${'test'}_pw_1970`;

const ALL = ['artifacts', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'credit_transactions', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/**
 * A well-formed sha256 SHAPE, distinct for every distinct seed.
 *
 * Hex-encoding the seed rather than filtering it: a "replace anything non-hex" version collapses `ovr` and `zro` onto
 * the same digest, and two tests that believe they are using different content while sharing one would make the
 * content-addressing index prove nothing.
 */
const hash = (seed: string): string => {
  let hex = '';
  for (const ch of seed) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  return (hex + '0'.repeat(64)).slice(0, 64);
};
const keyFor = (companyId: string, h: string): string => `company/${companyId.toLowerCase()}/artifacts/${h}/content.md`;

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-art-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-art-test' }));
}

describe.skipIf(!hasTestDatabase)('artifacts (real PostgreSQL, restricted role) — ACBP-P5-011/CDR-060', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let runA = '';
  let runA2 = '';
  let runB = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });

  /**
   * EACH refusal gets its OWN transaction. The first `42501` aborts the transaction, and every later statement in it
   * returns `25P02` (in_failed_sql_transaction) — which would make a batch of nine refusals prove exactly one thing.
   * This is the P5-005 hosted-CI lesson, kept.
   */
  const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
    p.then(() => 'no-error').catch((e: unknown) => {
      for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
        const node = cur as { code?: unknown; cause?: unknown };
        if (typeof node.code === 'string' && /^[0-9A-Z]{5}$/.test(node.code)) return node.code;
        cur = node.cause;
      }
      return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
    });

  interface ArtifactOverrides {
    readonly account?: string;
    readonly company?: string;
    readonly key?: string;
    readonly contentHash?: string;
    readonly format?: string;
    readonly size?: number;
    readonly run?: string;
    readonly workerId?: string;
    readonly workerVersion?: number;
    readonly modelVersion?: string;
    readonly title?: string;
  }

  /** Insert an artifact as the app role. Every field is overridable so a negative test can break exactly one thing. */
  function insertArtifact(a: string, c: string, over: ArtifactOverrides = {}): Promise<{ id: string }[]> {
    const h = over.contentHash ?? hash('a1');
    const v = {
      account: over.account ?? a,
      company: over.company ?? c,
      key: over.key ?? keyFor(over.company ?? c, h),
      format: over.format ?? 'markdown',
      size: over.size ?? 1_000,
      run: over.run ?? runA,
      workerId: over.workerId ?? 'research',
      workerVersion: over.workerVersion ?? 1,
      modelVersion: over.modelVersion ?? 'fake@1',
      title: over.title ?? 'Market research',
    };
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`insert into artifacts (account_id, company_id, object_key, content_hash, format, size_bytes, run_id, worker_id, worker_version, model_version, title)
        values (${v.account}::uuid, ${v.company}::uuid, ${v.key}, ${h}, ${v.format}, ${v.size}, ${v.run}::uuid, ${v.workerId}, ${v.workerVersion}, ${v.modelVersion}, ${v.title}) returning id`.execute(k);
      return r.rows;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    expect((await migrateToLatest(su)).error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    userU = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_art', 'user_art_u', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    const userV = (await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_art', 'user_art_v', now()) returning id`.execute(su.kysely)).rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    const taskA = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, 'running', 'produce research', ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    const taskB = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${accountB}::uuid, ${companyB1}::uuid, 'running', 'produce research', ${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    runA = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${accountA}::uuid, ${companyA1}::uuid, ${taskA}::uuid, 1) returning id`.execute(su.kysely)).rows[0]!.id;
    // A SECOND attempt of the same task in the same company — the fixture the content-addressing test needs. Without
    // it the "different run, identical bytes" case cannot be expressed, and the two-column uniqueness bug this table
    // deliberately avoids would pass unnoticed. (Fixtures that agree with the bug: the pattern this repo keeps hitting.)
    runA2 = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${accountA}::uuid, ${companyA1}::uuid, ${taskA}::uuid, 2) returning id`.execute(su.kysely)).rows[0]!.id;
    runB = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${accountB}::uuid, ${companyB1}::uuid, ${taskB}::uuid, 1) returning id`.execute(su.kysely)).rows[0]!.id;
  });

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (su) {
      try {
        await sql`alter role acbp_app nologin`.execute(su.kysely);
      } catch {
        /* best effort */
      }
      for (const t of ALL) await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(su);
    }
  });

  beforeEach(async () => {
    await sql`delete from artifacts`.execute(su.kysely);
  });

  describe('tenant isolation', () => {
    test('dual-keyed: an artifact is visible only under its own account+company, and fails CLOSED without the company key', async () => {
      await insertArtifact(accountA, companyA1);
      expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(1);
      expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(0);
      expect(await asApp({ 'app.current_account': accountA }, (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(0);
      expect(await asApp({}, (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(0);
    });

    test('a cross-tenant INSERT is refused by the RLS WITH CHECK, not merely hidden afterwards', async () => {
      // Writing B's row while scoped to A. `42501` is the RLS policy refusing it — an insufficient-privilege error,
      // not a constraint violation, which is how we know the POLICY is what stopped it.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { account: accountB, company: companyB1, run: runB }))).toBe('42501');
    });

    test('TRUST-CRITICAL #2: an object key carrying ANOTHER company prefix is refused by the row itself', async () => {
      // RLS cannot see inside a string. Without this CHECK, a company could hold a perfectly policy-legal row whose
      // key addresses another tenant's object — and every read path built on that row would follow it there.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { key: keyFor(companyB1, hash('a1')) }))).toBe('23514');
      // A prefix that merely STARTS with the id is not the same as the id: the trailing `/` is a path boundary.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { key: `company/${companyA1}-evil/artifacts/x/content.md` }))).toBe('23514');
      // No prefix at all.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { key: 'artifacts/loose/content.md' }))).toBe('23514');
      // TRAVERSAL AFTER a correct prefix. Found by review pass 1: this key satisfies a prefix test perfectly, so the
      // first version of the constraint would have accepted a row addressing another tenant's object while the
      // comment above it claimed tampered values fail. LIKE does not understand paths.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { key: `company/${companyA1}/../${companyB1}/artifacts/x/content.md` }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { key: `company/${companyA1}/artifacts/../../x/content.md` }))).toBe('23514');
    });

    test('the run FK is TENANT-PINNED: provenance cannot cite a run in another company', async () => {
      // Referential integrity ALWAYS bypasses RLS, so a single-column `run_id` FK would accept this row and no policy
      // would ever look at it. The composite `(run_id, company_id)` is what makes the boundary structural.
      // `23503` — foreign key violation — is the exact refusal, and it must be the FK rather than a policy.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { run: runB }))).toBe('23503');
    });
  });

  describe('append-only privileges', () => {
    test('no UPDATE and no DELETE — not even one column, so provenance can never be rewritten', async () => {
      const [row] = await insertArtifact(accountA, companyA1);
      const id = row!.id;
      // One statement per transaction: the first 42501 poisons the transaction, and `25P02` afterwards would prove
      // nothing about the grants.
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update artifacts set title = 'rewritten' where id = ${id}::uuid`.execute(k)))).toBe('42501');
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update artifacts set worker_id = 'someone_else' where id = ${id}::uuid`.execute(k)))).toBe('42501');
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update artifacts set run_id = ${runA2}::uuid where id = ${id}::uuid`.execute(k)))).toBe('42501');
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update artifacts set object_key = 'company/x/y' where id = ${id}::uuid`.execute(k)))).toBe('42501');
      expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`delete from artifacts where id = ${id}::uuid`.execute(k)))).toBe('42501');
    });
  });

  describe('the row cannot hold what the contract would have refused', () => {
    test('the 8 MiB cap (IOQ-11) is enforced at its exact boundary, and a zero-byte artifact is refused', async () => {
      // A cap that refuses its own boundary value is a different cap than the one CDR-060 §3 documents.
      expect(await insertArtifact(accountA, companyA1, { size: 8 * 1024 * 1024, contentHash: hash('cap') })).toHaveLength(1);
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { size: 8 * 1024 * 1024 + 1, contentHash: hash('ovr') }))).toBe('23514');
      // Zero bytes is the hollow success in miniature: a row telling a founder their research is saved, pointing at
      // nothing.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { size: 0, contentHash: hash('zro') }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { size: -1, contentHash: hash('neg') }))).toBe('23514');
    });

    test('the content hash must be 64 lowercase hex — a truncated or uppercase digest is not a digest', async () => {
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { contentHash: 'A'.repeat(64) }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { contentHash: 'a'.repeat(63) }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { contentHash: 'not-a-hash' }))).toBe('23514');
    });

    test('the format is an open one or nothing at all', async () => {
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { format: 'pdf' }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { format: 'MARKDOWN' }))).toBe('23514');
      for (const [i, f] of ['markdown', 'json', 'text'].entries()) {
        expect(await insertArtifact(accountA, companyA1, { format: f, contentHash: hash(`f${i}`) })).toHaveLength(1);
      }
    });

    test('provenance cannot be blank — "unknown provenance" is not a state this table can represent', async () => {
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { workerId: '   ' }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { modelVersion: '' }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { workerVersion: 0 }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { title: '  ' }))).toBe('23514');
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { title: 'x'.repeat(501) }))).toBe('23514');
    });
  });

  describe('content-addressed idempotence, keyed on the RUN', () => {
    test('the SAME run re-writing the SAME bytes collapses to one artifact', async () => {
      const h = hash('idem');
      expect(await insertArtifact(accountA, companyA1, { contentHash: h })).toHaveLength(1);
      // `23505` — the unique index firing is what makes a retry safe rather than duplicating work.
      expect(await sqlStateOf(insertArtifact(accountA, companyA1, { contentHash: h }))).toBe('23505');
      expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(1);
    });

    test('a DIFFERENT run producing identical bytes gets its OWN row — provenance is not inherited', async () => {
      // The test that would fail under the obvious `(company_id, content_hash)` key. If the second run silently
      // reused the first run's row, the artifact would claim attempt 1 produced what attempt 2 produced, and P5-012's
      // revision workflow would read that as truth.
      const h = hash('same');
      await insertArtifact(accountA, companyA1, { contentHash: h, run: runA });
      await insertArtifact(accountA, companyA1, { contentHash: h, run: runA2 });
      const rows = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('artifacts').selectAll().execute());
      expect(rows).toHaveLength(2);
      expect([...rows.map((r) => r.run_id)].sort()).toEqual([runA, runA2].sort());
      // Same bytes, same company ⇒ same object. Two honest rows, one stored object.
      expect(new Set(rows.map((r) => r.object_key)).size).toBe(1);
    });

    test('identical bytes in a DIFFERENT company are a DIFFERENT object — content addressing never crosses a tenant', async () => {
      const h = hash('cross');
      await insertArtifact(accountA, companyA1, { contentHash: h, run: runA });
      await insertArtifact(accountB, companyB1, { contentHash: h, run: runB });
      const a = await asApp(scope(accountA, companyA1), (k) => k.selectFrom('artifacts').selectAll().execute());
      const b = await asApp(scope(accountB, companyB1), (k) => k.selectFrom('artifacts').selectAll().execute());
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      // A globally content-addressed store would make these ONE object, and company A's read would be a read of
      // company B's write. Deduplication is not worth a tenant boundary.
      expect(a[0]!.object_key).not.toEqual(b[0]!.object_key);
    });
  });

  describe('catalog', () => {
    test('0043 is applied, RLS is ENABLED and FORCED, and the app role holds SELECT + INSERT and nothing else', async () => {
      const applied = await sql<{ name: string }>`select name from kysely_migration where name = '0043_artifacts'`.execute(su.kysely);
      expect(applied.rows).toHaveLength(1);

      const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>`
        select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.artifacts'::regclass
      `.execute(su.kysely);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

      const grants = await sql<{ privilege_type: string }>`
        select distinct privilege_type from information_schema.role_table_grants
        where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'artifacts'
      `.execute(su.kysely);
      expect([...grants.rows.map((g) => g.privilege_type)].sort()).toEqual(['INSERT', 'SELECT']);

      // And NO column-level grant either — the table-level check above would still pass if UPDATE had been handed out
      // one column at a time, which is exactly how `provisioning_steps` legitimately works.
      const columns = await sql<{ column_name: string }>`
        select column_name from information_schema.column_privileges
        where grantee = 'acbp_app' and table_schema = 'public' and table_name = 'artifacts' and privilege_type = 'UPDATE'
      `.execute(su.kysely);
      expect(columns.rows).toEqual([]);
    });

    test('deleting the company cascades its artifacts — an artifact never outlives the tenant that owns it', async () => {
      // A THROWAWAY company, seeded here and destroyed here. Deleting the shared `companyA1` would leave every later
      // test in this file depending on a re-seed running first, which is the kind of order coupling that makes a
      // suite fail for reasons that have nothing to do with the code under test.
      const companyA2 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
      const task = (await sql<{ id: string }>`insert into tasks (account_id, company_id, state, title, created_by_user_id) values (${accountA}::uuid, ${companyA2}::uuid, 'running', 'produce research', ${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
      const run = (await sql<{ id: string }>`insert into task_runs (account_id, company_id, task_id, attempt) values (${accountA}::uuid, ${companyA2}::uuid, ${task}::uuid, 1) returning id`.execute(su.kysely)).rows[0]!.id;

      await insertArtifact(accountA, companyA2, { contentHash: hash('casc'), run });
      expect(await asApp(scope(accountA, companyA2), (k) => k.selectFrom('artifacts').selectAll().execute())).toHaveLength(1);

      await sql`delete from companies where id = ${companyA2}::uuid`.execute(su.kysely);
      const left = await sql<{ n: string }>`select count(*)::text as n from artifacts`.execute(su.kysely);
      expect(left.rows[0]!.n).toBe('0');
    });
  });
});
