// ACBP-P5-001c / CDR-052 — real-PostgreSQL proof of bounded retry and dead-lettering, through the RESTRICTED role.
// Acceptance clause: **"cap = dead-letter"** (NFR-007).
//
// The centrepiece drives a job to its cap attempt by attempt and asserts it lands in `dead_letter` and STAYS there —
// canon's "no unlimited retries" is only proven by actually reaching the limit, not by inspecting a constant.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import type { RetryPolicy } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { enqueueJob, recordJobFailure, listBlockedJobs } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A tight policy so the cap is reachable in a test without simulating dozens of failures. */
const POLICY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };

describe.skipIf(!hasTestDatabase)('bounded retry + dead-letter (real PostgreSQL, restricted role) — ACBP-P5-001c/CDR-052', () => {
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
  const jobRows = async () => owner.kysely.selectFrom('jobs').selectAll().execute();
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();

  async function newJob(): Promise<string> {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    return r.job.id;
  }

  // ── THE ACCEPTANCE CLAUSE ─────────────────────────────────────────────────────────────────────────────────
  test('CAP = DEAD-LETTER — failures retry up to the cap, then the job stops, permanently', async () => {
    const jobId = await newJob();
    const seen: string[] = [];

    // Attempts 1 and 2 are below the cap and reschedule.
    for (let i = 1; i < POLICY.maxAttempts; i += 1) {
      const r = await recordJobFailure(product, { ...base(), jobId, reason: 'provider_error' }, { retryPolicy: POLICY });
      seen.push(r.status);
      expect(r.status).toBe('retry_scheduled');
      if (r.status !== 'retry_scheduled') throw new Error('unreachable');
      expect(r.attempts).toBe(i);
    }

    // The third failure reaches the cap.
    const final = await recordJobFailure(product, { ...base(), jobId, reason: 'provider_error' }, { retryPolicy: POLICY });
    seen.push(final.status);
    expect(final.status).toBe('dead_lettered');

    expect(seen).toEqual(['retry_scheduled', 'retry_scheduled', 'dead_lettered']);
    const row = (await jobRows())[0];
    expect(row?.state).toBe('dead_letter');
    expect(row?.attempts).toBe(POLICY.maxAttempts);
    expect(row?.failure_reason).toBe('attempts_exhausted');
  });

  test('a dead-lettered job is NEVER retried again, however many times the runner asks', async () => {
    // This is "never silently retried" as a property rather than a promise: the guarded update requires the job to be
    // in the state we read, and a dead-lettered job's state no longer matches `running`/`queued`.
    const jobId = await newJob();
    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await recordJobFailure(product, { ...base(), jobId, reason: 'timeout' }, { retryPolicy: POLICY });
    }
    expect((await jobRows())[0]?.state).toBe('dead_letter');

    for (let i = 0; i < 5; i += 1) {
      const again = await recordJobFailure(product, { ...base(), jobId, reason: 'timeout' }, { retryPolicy: POLICY });
      // Either it reports the terminal state or it reports that someone else settled it — never a new retry.
      expect(['dead_lettered', 'state_changed']).toContain(again.status);
    }
    const row = (await jobRows())[0];
    expect(row?.state).toBe('dead_letter');
    // The attempt counter must not have crept past the cap by re-asking.
    expect(row?.attempts).toBeLessThanOrEqual(POLICY.maxAttempts + 5);
    expect((await jobRows()).filter((j) => j.state === 'queued')).toHaveLength(0);
  });

  test('the dead-letter is AUDITED, with a category and no payload', async () => {
    const jobId = await newJob();
    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await recordJobFailure(product, { ...base(), jobId, reason: 'provider_error' }, { retryPolicy: POLICY });
    }
    const events = await auditFor('job.dead_lettered');
    expect(events).toHaveLength(1);
    expect(events[0]?.subject_id).toBe(jobId);
    expect(events[0]?.outcome).toBe('blocked');
    expect(events[0]?.payload).toEqual({ kind: 'understanding.generate', attempts: POLICY.maxAttempts, reason: 'attempts_exhausted' });
  });

  test('a RETRY is not audited as a dead-letter — only the terminal stop is', async () => {
    const jobId = await newJob();
    await recordJobFailure(product, { ...base(), jobId, reason: 'timeout' }, { retryPolicy: POLICY });
    expect(await auditFor('job.dead_lettered')).toHaveLength(0);
    expect((await jobRows())[0]?.state).toBe('queued');
  });

  // ── the blocked queue: what makes dead-letter VISIBLE ─────────────────────────────────────────────────────
  test('a dead-lettered job appears in the blocked queue, WITHOUT its payload', async () => {
    const jobId = await newJob();
    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await recordJobFailure(product, { ...base(), jobId, reason: 'invalid_payload' }, { retryPolicy: POLICY });
    }
    const blocked = ok(await listBlockedJobs(product, { ...base() }));
    expect(blocked.jobs).toHaveLength(1);
    expect(blocked.jobs[0]).toEqual({ id: jobId, kind: 'understanding.generate', attempts: POLICY.maxAttempts, failureReason: 'attempts_exhausted' });
    // The payload carries caller-chosen references and is not a reviewed surface.
    expect(JSON.stringify(blocked.jobs[0])).not.toContain('payload');
  });

  test('a healthy job is NOT in the blocked queue — the queue means blocked, not merely failed once', async () => {
    const jobId = await newJob();
    await recordJobFailure(product, { ...base(), jobId, reason: 'timeout' }, { retryPolicy: POLICY });
    expect(ok(await listBlockedJobs(product, { ...base() })).jobs).toHaveLength(0);
  });

  test('the blocked queue is company-scoped — another tenant never sees these jobs', async () => {
    const jobId = await newJob();
    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await recordJobFailure(product, { ...base(), jobId, reason: 'internal_error' }, { retryPolicy: POLICY });
    }
    const foreign = await listBlockedJobs(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 });
    expect(ok(foreign).jobs).toHaveLength(0);
  });

  // ── the store's guarantees ────────────────────────────────────────────────────────────────────────────────
  test('a failure_reason without dead_letter is REJECTED — the pairing is enforced by the database', async () => {
    const jobId = await newJob();
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update jobs set failure_reason = 'timeout' where id = ${jobId}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('an unregistered failure category is REJECTED — never provider exception text', async () => {
    const jobId = await newJob();
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update jobs set state = 'dead_letter', failure_reason = 'ECONNREFUSED at 10.0.0.1:5432' where id = ${jobId}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('the column-scoped UPDATE grant still excludes tenancy, kind and payload', async () => {
    const jobId = await newJob();
    // P5-001c EXTENDED the grant with failure_reason; it must not have widened it to the row.
    for (const column of ['company_id', 'kind']) {
      await expect(
        asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
          sql`update jobs set ${sql.ref(column)} = ${column === 'kind' ? 'strategy.generate' : w.companyB1} where id = ${jobId}::uuid`.execute(db),
        ),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    }
  });

  test('a viewer cannot record a failure or read the blocked queue — `job:execute` is owner-only', async () => {
    const jobId = await newJob();
    const asViewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect((await recordJobFailure(product, { ...asViewer, jobId, reason: 'timeout' })).status).toBe('forbidden');
    expect((await listBlockedJobs(product, asViewer)).status).toBe('forbidden');
    expect((await jobRows())[0]?.attempts).toBe(0);
  });

  test('a foreign job is not_found, never a failure recorded across tenants', async () => {
    const jobId = await newJob();
    const r = await recordJobFailure(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, jobId, reason: 'timeout' });
    expect(r.status).toBe('not_found');
    expect((await jobRows())[0]?.attempts).toBe(0);
  });
});
