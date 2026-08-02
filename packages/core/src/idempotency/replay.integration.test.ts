// @acbp/core — the replay suite (ACBP-P6-011; CDR-074 §0/§1/§2; TASK-009, NFR-006; ADR-008/ADR-013;
// trust-critical #11 and #12; launch gate 5). Real PostgreSQL, restricted role, nothing mocked.
//
// WHAT MAKES THIS SUITE DIFFERENT FROM EVERY OTHER TEST OF SUPPRESSION. Canon says a suppressed duplicate is
// "invisible (correct)" to the user (FAILURE-AND-RECOVERY row 11). That is right as a product statement and
// treacherous as a verification standard: "nothing happened twice" is ALSO what a system with no duplicate
// suppression looks like on a day when nothing was delivered twice. A suite that only checked "one row exists"
// would pass just as happily against a build with every guard removed, as long as it never actually re-delivered.
//
// So every case here DELIVERS THE DUPLICATE FOR REAL and then asserts two independent things (CDR-074 §0):
//   1. the effect happened EXACTLY ONCE -- one row, one mutation, one count; and
//   2. the system KNEW it was suppressing -- an `idempotency.suppressed` incident was recorded.
// Assertion 2 is the one that cannot be faked by a system that simply never duplicated anything, and it is why
// `recordSuppression` exists at all.
//
// Skips when ACBP_TEST_DATABASE_URL is unset -- a skipped run is "discovered but not executed", never green, so
// hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { toModelId, type ModelGatewayRequest, type VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import { FakeModelProvider, type FakeProviderBehavior } from '@acbp/adapters';
import { createTestLogger, SUPPRESSION_EVENT, type LogRecord } from '@acbp/observability';
import type { DatabaseClient } from '@acbp/database';
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
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { enqueueJob } from '../jobs/index.js';
import { createIdentityWebhookService } from '../identity/webhook-service.js';
import { createModelGateway, type ResolvedProvider } from '../index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const INSTANCE = 'inst_replay_synthetic';

const hex = (c: string) => c.repeat(64);

function resolved(name: string): ResolvedProvider {
  const behavior: FakeProviderBehavior = { kind: 'respond', output: 'result', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };
  return { name, modelId: toModelId(`${name}-model`), modelVersion: 'v1', provider: new FakeModelProvider({ behavior }) };
}

/** The suppression incidents in a captured log, for a given surface. */
const suppressions = (records: readonly LogRecord[], surface: string) =>
  records.filter((r) => r.event === SUPPRESSION_EVENT && (r.metadata as { surface?: string } | undefined)?.surface === surface);

describe.skipIf(!hasTestDatabase)('replay + duplicate delivery across jobs, events and usage (real PostgreSQL) — ACBP-P6-011/CDR-074', () => {
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
    // (owner, product) — that order, and both parameters are `DatabaseClient`, so swapping them typechecks
    // cleanly and fails only at runtime as an RLS violation inside the harness.
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  }, 60_000);

  // ── jobs: the same key enqueued twice is ONE job (trust-critical #11) ────────────────────────────────────
  describe('jobs', () => {
    const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
    const jobRows = () => owner.kysely.selectFrom('jobs').selectAll().execute();

    test('a re-delivered enqueue creates no second job, and the suppression is recorded', async () => {
      const t = createTestLogger();
      const first = await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'replay-job-1' }, { logger: t.logger });
      const second = await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'replay-job-1' }, { logger: t.logger });

      expect(first.status).toBe('ok');
      expect(second.status).toBe('ok');
      if (first.status !== 'ok' || second.status !== 'ok') throw new Error('unreachable');

      // 1. The effect happened once — and it is the SAME job, not merely the same count.
      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.job.id).toBe(first.job.id);
      expect(await jobRows()).toHaveLength(1);

      // 2. The system knew. Exactly one incident: the FIRST enqueue must not report one, or the count would rise
      // on ordinary traffic and stop meaning anything.
      expect(suppressions(t.records, 'job_enqueue')).toHaveLength(1);
      expect(suppressions(t.records, 'job_enqueue')[0]?.metadata).toEqual({ surface: 'job_enqueue', accountId: w.accountA, companyId: w.companyA1 });
    });

    test('two keyless enqueues are two jobs and no suppression at all', async () => {
      // The dispatcher's "a blank key is no key" rule, at the job store. Two callers who both omitted a key have
      // not delivered the same work twice, and collapsing them would DROP a job someone is waiting on.
      const t = createTestLogger();
      await enqueueJob(product, { ...base(), kind: 'understanding.generate' }, { logger: t.logger });
      await enqueueJob(product, { ...base(), kind: 'understanding.generate' }, { logger: t.logger });

      expect(await jobRows()).toHaveLength(2);
      expect(suppressions(t.records, 'job_enqueue')).toHaveLength(0);
    });

    test('the same key in a DIFFERENT company is a different job', async () => {
      // The index is per company, so a key minted in one company must not suppress another's work.
      const t = createTestLogger();
      await enqueueJob(product, { ...base(), kind: 'understanding.generate', idempotencyKey: 'shared-key' }, { logger: t.logger });
      await enqueueJob(
        product,
        { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2, kind: 'understanding.generate', idempotencyKey: 'shared-key' },
        { logger: t.logger },
      );

      expect(await jobRows()).toHaveLength(2);
      expect(suppressions(t.records, 'job_enqueue')).toHaveLength(0);
    });
  });

  // ── events: a re-delivered webhook mutates the user once (trust-critical #11) ────────────────────────────
  describe('identity events', () => {
    const event = (userId: string, email: string): VerifiedIdentityWebhookEvent => ({
      provider: 'clerk',
      providerInstanceId: INSTANCE,
      eventId: `evt_${userId}`,
      occurredAt: '2026-03-01T10:00:00.000Z',
      payloadSha256: hex('a'),
      type: 'user.created',
      providerUserId: userId,
      orderingTimestamp: '2026-03-01T10:00:00.000Z',
      user: { providerUserId: userId, primaryEmail: email, emailVerified: false, providerUpdatedAt: '2026-03-01T10:00:00.000Z', providerCreatedAt: '2025-12-01T00:00:00.000Z' },
    });
    const receipts = () => owner.kysely.selectFrom('identity_webhook_receipts').selectAll().execute();

    /**
     * The REAL production entry point, with only the signature verifier faked.
     *
     * Driven through `createIdentityWebhookService` rather than `processVerifiedIdentityEvent` because review
     * found the two disagreed: the processor recorded the incident, the service never passed it a logger, and
     * the seam type could not carry one. A test that called the processor directly was green while the only
     * surface that suppresses anything in production recorded nothing. The verifier is the one thing faked —
     * it owns signature checking, which needs a real signing secret and is not what this asserts.
     */
    const service = (logger: ReturnType<typeof createTestLogger>['logger'], verified: VerifiedIdentityWebhookEvent) =>
      createIdentityWebhookService({
        client: owner,
        logger,
        verifier: { verify: () => Promise.resolve({ status: 'verified', event: verified }) },
      });
    const RAW_REQUEST = { rawBody: new Uint8Array([1, 2, 3]), headers: { 'svix-id': 'msg_replay' } };

    test('a provider re-delivery through the webhook SERVICE applies once and records the suppression', async () => {
      const t = createTestLogger();
      const e = event('u_replay_1', 'replay-1@synthetic.test');
      const svc = service(t.logger, e);

      const firstHandled = await svc.handle(RAW_REQUEST);
      const secondHandled = await svc.handle(RAW_REQUEST);
      const first = { outcome: firstHandled.kind === 'processed' ? firstHandled.outcome : firstHandled.kind };
      const second = { outcome: secondHandled.kind === 'processed' ? secondHandled.outcome : secondHandled.kind };

      // 1. Applied once. `duplicate` is a distinct outcome from `applied` — this is the assertion that a second
      // user mutation did NOT run, which a row count alone cannot show for an idempotent upsert.
      expect(first.outcome).toBe('applied');
      expect(second.outcome).toBe('duplicate');
      expect(await receipts()).toHaveLength(1);

      // 2. The system knew — and identity is global, so both tenant fields are null by design, not by omission.
      expect(suppressions(t.records, 'identity_event')).toHaveLength(1);
      expect(suppressions(t.records, 'identity_event')[0]?.metadata).toEqual({ surface: 'identity_event', accountId: null, companyId: null });
    });

    test('a DIFFERENT payload under the same event id is a security conflict, not a suppression', async () => {
      // The distinction that matters most on this surface: same id + same hash is a re-delivery; same id +
      // different hash is someone replaying an event id with new content. Counting the second as a suppression
      // would file an attack under "the mechanism is working".
      const t = createTestLogger();
      const e = event('u_replay_2', 'replay-2@synthetic.test');
      await service(t.logger, e).handle(RAW_REQUEST);
      const tampered = await service(t.logger, { ...e, payloadSha256: hex('b') }).handle(RAW_REQUEST);

      expect(tampered.kind === 'processed' ? tampered.outcome : tampered.kind).toBe('security_conflict');
      expect(suppressions(t.records, 'identity_event')).toHaveLength(0);
    });
  });

  // ── usage: a re-delivered usage write does not double count (trust-critical #12) ─────────────────────────
  describe('usage events', () => {
    const usageRows = (companyId: string) => owner.kysely.selectFrom('usage_events').selectAll().where('company_id', '=', companyId).execute();
    const estimateCost = ({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }): number => inputTokens * 5 + outputTokens * 7;
    const request = (accountId: string, companyId: string, over: Partial<ModelGatewayRequest> = {}): ModelGatewayRequest => ({
      taskClass: 'extraction',
      templateRef: 'tmpl@1',
      contextParts: [{ role: 'user', content: 'go' }],
      timeoutClass: 'interactive',
      companyId,
      accountId,
      correlationId: 'corr-replay',
      ...over,
    });

    test('a re-delivered metered call leaves ONE usage row and still returns the output', async () => {
      const t = createTestLogger();
      const gw = createModelGateway(product, { primary: resolved('primary'), estimateCost, logger: t.logger });

      const first = await gw(request(w.accountA, w.companyA1, { idempotencyKey: 'replay-call-1' }));
      const second = await gw(request(w.accountA, w.companyA1, { idempotencyKey: 'replay-call-1' }));

      // 1. Billed once. The ledger is the truth CDR-073's rollup sums, and reconciliation could not have caught a
      // second row here — it recomputes FROM the ledger and would agree with itself.
      expect(await usageRows(w.companyA1)).toHaveLength(1);

      // THE OUTPUT IS STILL RETURNED, and this is the point of `suppressed` being a success rather than a throw.
      // Metering is fail-closed: had the duplicate surfaced as a write failure, this second call would have
      // withheld an output the customer has already been charged for — the feature causing the exact harm it
      // exists to prevent.
      expect(first.outcome).toBe('ok');
      expect(second.outcome).toBe('ok');
      expect(second.validatedOutput).toBe('result');

      // 2. The system knew.
      expect(suppressions(t.records, 'usage_event')).toHaveLength(1);
      expect(suppressions(t.records, 'usage_event')[0]?.metadata).toEqual({ surface: 'usage_event', accountId: w.accountA, companyId: w.companyA1 });
    });

    test('two keyless metered calls both count — the mechanism never suppresses by accident', async () => {
      // This is the case that would be an UNDER-count if the key were derived from the call's attributes instead
      // of supplied per delivery: these two calls are byte-identical in provider, model, tokens and cost, and
      // they are two real calls that must both be billed.
      const t = createTestLogger();
      const gw = createModelGateway(product, { primary: resolved('primary'), estimateCost, logger: t.logger });

      await gw(request(w.accountA, w.companyA1));
      await gw(request(w.accountA, w.companyA1));

      expect(await usageRows(w.companyA1)).toHaveLength(2);
      expect(suppressions(t.records, 'usage_event')).toHaveLength(0);
    });

    test('the same key in a DIFFERENT company still records its usage', async () => {
      // A unique index is enforced regardless of RLS, so an account-wide key space would let one company's key
      // suppress another company's BILLING row — a cross-tenant effect that trips no policy.
      const t = createTestLogger();
      const gw = createModelGateway(product, { primary: resolved('primary'), estimateCost, logger: t.logger });

      await gw(request(w.accountA, w.companyA1, { idempotencyKey: 'cross-company-key' }));
      await gw(request(w.accountA, w.companyA2, { idempotencyKey: 'cross-company-key' }));

      expect(await usageRows(w.companyA1)).toHaveLength(1);
      expect(await usageRows(w.companyA2)).toHaveLength(1);
      expect(suppressions(t.records, 'usage_event')).toHaveLength(0);
    });
  });

  // ── the incident record itself ───────────────────────────────────────────────────────────────────────────
  test('a suppression incident never carries the idempotency key', async () => {
    // The key is caller-authored and unbounded: a caller is free to mint one containing an email or a fragment of
    // the payload it de-duplicates. Asserted end-to-end here, not just at the unit boundary, because this is the
    // path on which a real key actually exists.
    const t = createTestLogger();
    const key = 'invoice-for-someone@synthetic.test-9';
    const b = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1, kind: 'understanding.generate' as const };
    await enqueueJob(product, { ...b, idempotencyKey: key }, { logger: t.logger });
    await enqueueJob(product, { ...b, idempotencyKey: key }, { logger: t.logger });

    expect(suppressions(t.records, 'job_enqueue')).toHaveLength(1);
    expect(JSON.stringify(t.records)).not.toContain('synthetic.test');
    expect(JSON.stringify(t.records)).not.toContain(key);
  });
});
