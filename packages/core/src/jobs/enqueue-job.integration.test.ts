// ACBP-P5-001a / CDR-049 — real-PostgreSQL proof of the durable job store and its tenancy guarantee, through the
// RESTRICTED role under FORCE RLS.
//
// The acceptance clause is "context-stripped job refused" (trust-critical #3), and CDR-049 §3-G3 specifies THREE
// deliberately redundant layers. A test that only exercises the use case would prove one of them; these prove all
// three, each reached the only way it can be:
//   1. `NOT NULL` — reached by writing directly to the repository with a field omitted (bypassing the use case);
//   2. dual-keyed RLS `WITH CHECK` — reached by writing a well-formed but FOREIGN pair of ids while holding a valid
//      session for a different company (which `NOT NULL` cannot see, because both fields are populated);
//   3. the typed use-case refusal — reached through `enqueueJob` itself.
// Also proves: tenancy and payload are IMMUTABLE to the app role; there is no DELETE; per-company idempotency;
// cross-company isolation; audit-or-nothing. Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is
// "discovered but not executed", never green, so hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { JobRepository, type DatabaseClient } from '@acbp/database';
import { JOB_STATES } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { enqueueJob } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** PostgreSQL SQLSTATEs. Pinned exactly, because sanitized errors never carry a constraint name to match on. */
const NOT_NULL_VIOLATION = '23502';
const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

/**
 * The platform code of a failure, walking the cause chain. Cross-boundary errors are bounded and sanitized, so the
 * driver error is nested rather than thrown directly — asserting on the message would be asserting on the sanitizer.
 */
function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('durable job store + tenant stamping (real PostgreSQL, restricted role) — ACBP-P5-001a/CDR-049', () => {
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

  // ── the happy path ────────────────────────────────────────────────────────────────────────────────────────
  test('an owner enqueues a job that is STAMPED with the caller\'s account and company', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' } }));
    expect(r.deduplicated).toBe(false);
    expect(r.job.state).toBe('queued');

    const rows = await jobRows();
    expect(rows).toHaveLength(1);
    // Stamped from the SERVER-RESOLVED scope, never from anything the caller could restate.
    expect(rows[0]?.account_id).toBe(w.accountA);
    expect(rows[0]?.company_id).toBe(w.companyA1);
    expect(rows[0]?.created_by_user_id).toBe(w.aOwner);
    expect(rows[0]?.attempts).toBe(0);
  });

  test('enqueue is audited in the same transaction, and the audit payload carries no payload data', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'strategy.generate', payload: { secretish: 'do-not-log-me' } }));
    const events = await auditFor('job.enqueued');
    expect(events).toHaveLength(1);
    expect(events[0]?.subject_id).toBe(r.job.id);
    expect(events[0]?.payload).toEqual({ kind: 'strategy.generate', deduplicated: false });
    expect(JSON.stringify(events[0]?.payload)).not.toContain('do-not-log-me');
  });

  test('audit-or-nothing: when the audit write fails, NO job row survives (ADR-015)', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('audit unavailable'));
    await expect(
      enqueueJob(product, { ...base(), kind: 'understanding.generate' }, { auditWriter: boom }),
    ).rejects.toThrow();
    expect(await jobRows()).toHaveLength(0);
  });

  // ── LAYER 3: the typed use-case refusal (CDR-049 §3-G3.3) ─────────────────────────────────────────────────
  test('LAYER 3 — a context-stripped enqueue is REFUSED with a typed reason and writes nothing', async () => {
    // The literal acceptance clause. `companyId` is typed `string`, so this is the shape a real caller reaches it
    // with: a value that got lost between a parsed request and this call.
    const r = await enqueueJob(product, { ...base(), companyId: undefined as unknown as string, kind: 'understanding.generate' });
    expect(r).toEqual({ status: 'refused', reason: 'missing_company' });
    expect(await jobRows()).toHaveLength(0);
    expect(await auditFor('job.enqueued')).toHaveLength(0);
  });

  test('LAYER 3 — a sentinel company id ("system") is refused as invalid, not treated as a platform scope', async () => {
    const r = await enqueueJob(product, { ...base(), companyId: 'system', kind: 'understanding.generate' });
    expect(r).toEqual({ status: 'refused', reason: 'invalid_company' });
    expect(await jobRows()).toHaveLength(0);
  });

  test('LAYER 3 — the tenancy refusal is REACHABLE: it is not swallowed by scope resolution as `forbidden`', async () => {
    // The regression this pins is the review-pass-1 defect. `runInCompanyScope` denies a blank company id itself, so
    // with the tenancy check inside the scope every one of these came back `forbidden` — which is exactly what an
    // authorization failure looks like, making the acceptance clause's refusal invisible.
    //
    // Note these run with a LEGITIMATE owner: nothing about the caller is wrong, only the context. If any of these
    // reports `forbidden`, the platform can no longer tell "a job lost its tenant context" from "someone was not
    // allowed to enqueue", and the alarm this ticket exists to enable is dead.
    for (const [companyId, reason] of [
      [undefined, 'missing_company'],
      ['', 'missing_company'],
      ['   ', 'missing_company'],
      ['null', 'invalid_company'],
      ['0', 'invalid_company'],
    ] as const) {
      const r = await enqueueJob(product, { ...base(), companyId: companyId as unknown as string, kind: 'understanding.generate' });
      expect(r).toEqual({ status: 'refused', reason });
    }
    expect(await jobRows()).toHaveLength(0);
  });

  test('LAYER 3 — an unregistered kind is refused rather than enqueued as unknown work', async () => {
    const r = await enqueueJob(product, { ...base(), kind: 'shell.exec' });
    expect(r).toEqual({ status: 'refused', reason: 'invalid_kind' });
    expect(await jobRows()).toHaveLength(0);
  });

  test('LAYER 3 — authorization is decided BEFORE validation, so a non-owner learns nothing about their fields', async () => {
    // A viewer supplying a malformed request gets `forbidden`, not `refused: invalid_kind`. A refusal reason is a
    // small oracle and should only be available to someone entitled to the operation at all.
    //
    // TENANCY is the deliberate exception (see the reachability test above): it reports on the shape of ids the
    // caller supplied and discloses no platform state, so it may — and must — be answered before authorization.
    const r = await enqueueJob(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, kind: 'shell.exec' });
    expect(r).toEqual({ status: 'forbidden' });
  });

  test('`job:enqueue` is owner-only — a viewer of the same company cannot schedule background work', async () => {
    const r = await enqueueJob(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1, kind: 'understanding.generate' });
    expect(r).toEqual({ status: 'forbidden' });
    expect(await jobRows()).toHaveLength(0);
  });

  test('a non-member of the company is forbidden, and the job never exists', async () => {
    const r = await enqueueJob(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1, kind: 'understanding.generate' });
    expect(r).toEqual({ status: 'forbidden' });
    expect(await jobRows()).toHaveLength(0);
  });

  // ── LAYER 1: NOT NULL, reached BELOW the use case (CDR-049 §3-G3.1) ───────────────────────────────────────
  test('LAYER 1 — a job row with no company_id cannot physically exist, even from code that bypasses the use case', async () => {
    // Deliberately NOT through `enqueueJob`: layer 1 exists precisely for code that forgets the field, and code that
    // forgets the field does not go through the layer that would have caught it.
    // The assertion wraps the WHOLE `asRestricted` call, not the inner statement: a failed statement aborts its
    // transaction, so catching it inside would leave the harness committing an aborted transaction and the real
    // failure would surface as a confusing second error.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`insert into jobs (account_id, kind, created_by_user_id) values (${w.accountA}::uuid, 'understanding.generate', ${w.aOwner}::uuid)`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === NOT_NULL_VIOLATION);
    expect(await jobRows()).toHaveLength(0);
  });

  test('LAYER 1 — the same holds for account_id', async () => {
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`insert into jobs (company_id, kind, created_by_user_id) values (${w.companyA1}::uuid, 'understanding.generate', ${w.aOwner}::uuid)`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === NOT_NULL_VIOLATION);
    expect(await jobRows()).toHaveLength(0);
  });

  // ── LAYER 2: dual-keyed RLS WITH CHECK (CDR-049 §3-G3.2) ──────────────────────────────────────────────────
  test('LAYER 2 — a well-formed but FOREIGN company id is refused by RLS, which NOT NULL cannot see', async () => {
    // Both columns are populated, so layer 1 is satisfied. This is the attack layer 1 is blind to: a caller with a
    // legitimate session for company A1 writing a job that belongs to company B1.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        new JobRepository(db).insert({ accountId: w.accountB, companyId: w.companyB1, kind: 'understanding.generate', payload: {}, createdByUserId: w.aOwner }),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect(await jobRows()).toHaveLength(0);
  });

  test('LAYER 2 — a MIXED pair (own account, foreign company) is refused; both keys are checked, not either', async () => {
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        new JobRepository(db).insert({ accountId: w.accountA, companyId: w.companyB1, kind: 'understanding.generate', payload: {}, createdByUserId: w.aOwner }),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect(await jobRows()).toHaveLength(0);
  });

  // ── immutability of what a job IS ─────────────────────────────────────────────────────────────────────────
  test('tenancy is IMMUTABLE to the app role — a job cannot be re-pointed at another tenant after enqueue', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    // No column UPDATE grant on company_id: refused as a PRIVILEGE failure, before any policy is consulted.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update jobs set company_id = ${w.companyB1}::uuid where id = ${r.job.id}::uuid`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect((await jobRows())[0]?.company_id).toBe(w.companyA1);
  });

  test('the payload is IMMUTABLE — the work cannot be swapped between enqueue and execution', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', payload: { documentId: 'doc-1' } }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update jobs set payload = '{"documentId":"doc-evil"}'::jsonb where id = ${r.job.id}::uuid`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect((await jobRows())[0]?.payload).toEqual({ documentId: 'doc-1' });
  });

  test('there is NO DELETE — job history is the run trail and cannot be erased by the code that failed', async () => {
    await enqueueJob(product, { ...base(), kind: 'understanding.generate' });
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`delete from jobs`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    expect(await jobRows()).toHaveLength(1);
  });

  test('the lifecycle columns ARE updatable — the runner can advance state and count attempts', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      await sql`update jobs set state = 'running', attempts = attempts + 1, updated_at = now() where id = ${r.job.id}::uuid`.execute(db);
    });
    const row = (await jobRows())[0];
    expect(row?.state).toBe('running');
    expect(row?.attempts).toBe(1);
  });

  test('the state set is CLOSED — an invented state is rejected by the CHECK, including through the update grant', async () => {
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update jobs set state = 'done' where id = ${r.job.id}::uuid`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    expect((await jobRows())[0]?.state).toBe('queued');
  });

  test('the contract\'s JOB_STATES and the database CHECK agree — EVERY declared state is accepted', async () => {
    // The cross-check that keeps the two from drifting. `dead_letter` is in here even though only P5-001c reaches it:
    // the migration declares it up front (§4-G6) so b/c extend behaviour rather than reshape the table, and this is
    // what proves the contract's list is the same list rather than a stale copy of it.
    const r = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    for (const state of JOB_STATES) {
      await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update jobs set state = ${state} where id = ${r.job.id}::uuid`.execute(db));
      expect((await jobRows())[0]?.state).toBe(state);
    }
  });

  // ── idempotency (TASK-009 / NFR-006) ──────────────────────────────────────────────────────────────────────
  test('the same idempotency key enqueued twice is ONE job, and the second call says so', async () => {
    const first = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'doc-1-v3' }));
    const second = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'doc-1-v3' }));
    expect(second.job.id).toBe(first.job.id);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(await jobRows()).toHaveLength(1);
    // The deduplicated attempt is still audited: an enqueue that collapsed into an existing job is exactly what a
    // run trail would otherwise be missing, since the caller was told `ok`.
    const events = await auditFor('job.enqueued');
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e.payload as { deduplicated: boolean }).deduplicated).sort()).toEqual([false, true]);
  });

  test('idempotency is PER COMPANY — two tenants may use the same key without colliding or seeing each other', async () => {
    const a = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'shared-key' }));
    const b = ok(await enqueueJob(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, kind: 'understanding.generate', idempotencyKey: 'shared-key' }));
    expect(b.job.id).not.toBe(a.job.id);
    expect(b.deduplicated).toBe(false);
    expect(await jobRows()).toHaveLength(2);
  });

  test('a NULL idempotency key does not deduplicate — the unique index is partial', async () => {
    const first = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    const second = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    expect(second.job.id).not.toBe(first.job.id);
    expect(await jobRows()).toHaveLength(2);
  });

  test('the per-company uniqueness is enforced by the DATABASE, not only by the read-back', async () => {
    // Pinned to the exact SQLSTATE rather than to the repository's conflict handling: the `ON CONFLICT` clause names
    // one index, and this is what proves that index is the one actually protecting the invariant.
    await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'k1' });
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`insert into jobs (account_id, company_id, kind, idempotency_key, created_by_user_id)
            values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'strategy.generate', 'k1', ${w.aOwner}::uuid)`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
    expect(await jobRows()).toHaveLength(1);
  });

  // ── cross-company isolation of the read path ──────────────────────────────────────────────────────────────
  test('a job is invisible from another company\'s scope — including by its idempotency key', async () => {
    const a = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'a-only' }));
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      const jobs = new JobRepository(db);
      expect(await jobs.findById(a.job.id)).toBeUndefined();
      expect(await jobs.findByIdempotencyKey('a-only')).toBeUndefined();
    });
  });

  test('a sibling company of the SAME account cannot see the job either — company is a real boundary, not a label', async () => {
    const a = ok(await enqueueJob(product, { ...base(), kind: 'understanding.generate' }));
    await asRestricted(product, { account: w.accountA, company: w.companyA2 }, async (db) => {
      expect(await new JobRepository(db).findById(a.job.id)).toBeUndefined();
    });
  });
});
