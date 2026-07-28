// ACBP-P5-014 / CDR-058 — real-PostgreSQL proof of preflight, reservation and settlement, through the RESTRICTED role.
//
// THE AT-025 RACE CARRIES THIS TICKET: two runs against one remaining credit, exactly one wins, and the balance still
// equals the ledger sum afterwards. That test is deterministic rather than timing-dependent — it holds a real lock and
// THROWS if nothing ever blocks on it, so it can never quietly degrade into proving the ordinary sequential path.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { CreditRepository, TaskRepository, TaskRunRepository, closeDatabase, type DatabaseClient } from '@acbp/database';
import { CREDITS_PER_MANUAL_RUN } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { preflightRun, reserveCredit, settleRun, readCreditLedger } from './credit-service.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('credit service (real PostgreSQL, restricted role) — ACBP-P5-014/CDR-058', () => {
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
  const rows = async () => owner.kysely.selectFrom('credit_transactions').selectAll().execute();
  const auditRows = async () => owner.kysely.selectFrom('audit_events').selectAll().orderBy('event_id').execute();

  /** Mint as the OWNER role — the product role has no grant path, which is the point (CDR-058 §4). */
  async function grant(credits: number, accountId = w.accountA): Promise<void> {
    await sql`insert into credit_transactions (account_id, kind, credits) values (${accountId}, 'grant', ${credits})`.execute(owner.kysely);
  }

  /**
   * End a run for real, as the OWNER role.
   *
   * settleRun reads the run's own state now (it used to trust a caller-supplied outcome, which meant a succeeded
   * run could be settled as cancelled and the work came out free). So a settlement test has to actually END the run —
   * asserting "a SUCCEEDED run consumes" against a run still sitting in unning would assert nothing.
   */
  async function endRun(runId: string, state: 'succeeded' | 'failed' | 'cancelled'): Promise<void> {
    const row = await new TaskRunRepository(owner.kysely).transition({
      runId,
      expectedState: 'running',
      nextState: state,
      ...(state === 'failed' ? { failureCategory: 'provider_error' } : {}),
      endedAt: new Date(),
    });
    expect(row?.state).toBe(state);
  }

  /** A task carried to a RUNNING run — what a reservation attaches to. */
  async function runningRun(): Promise<string> {
    const t = await createTask(product, { ...base(), title: 'Research the market', description: null, milestoneId: null });
    const taskId = (t as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    const moved = await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    expect(moved).toBe(1);
    const r = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; run: { id: string } }).run.id;
  }

  /**
   * Block until some backend is waiting on a lock held by `pid`.
   *
   * This is what makes the race DETERMINISTIC, and it THROWS if nothing ever blocks — so a future change that quietly
   * removed the lock would fail this test loudly rather than turning it into a sequential one that still passes.
   */
  async function waitForBlockedBy(pid: number, atLeast = 1): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const r = await sql<{ n: number }>`
        select count(*)::int as n from pg_locks l where not l.granted and ${pid}::int = any (pg_blocking_pids(l.pid))
      `.execute(owner.kysely);
      if ((r.rows[0]?.n ?? 0) >= atLeast) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${atLeast} backend(s) ever blocked on the account lock — the AT-025 race was not reproduced`);
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from credit_transactions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  // ── PREFLIGHT (TASK-004) ──────────────────────────────────────────────────────────────────────────────────
  test('preflight reports the balance, the cost and the side-effect class, and changes nothing', async () => {
    await grant(3);
    const r = await preflightRun(product, { ...base() });
    expect(r).toMatchObject({ status: 'ok', balance: 3, cost: CREDITS_PER_MANUAL_RUN, affordable: true, sideEffectClass: 'internal_only' });
    // READ-ONLY: a preflight that wrote would charge for looking.
    expect(await rows()).toHaveLength(1);
  });

  test('preflight on an empty account is honest rather than an error — zero credits, not affordable', async () => {
    expect(await preflightRun(product, { ...base() })).toMatchObject({ status: 'ok', balance: 0, affordable: false });
  });

  // ── RESERVATION ───────────────────────────────────────────────────────────────────────────────────────────
  test('a reservation spends exactly one credit and is attributed to the run and the company', async () => {
    await grant(3);
    const runId = await runningRun();
    const r = await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    expect(r).toMatchObject({ status: 'ok', balanceAfter: 2 });
    const entry = (await rows()).find((x) => x.kind === 'reservation');
    expect(entry).toMatchObject({ credits: -1, run_id: runId, company_id: w.companyA1, account_id: w.accountA, idempotency_key: 'k1' });
    expect((await auditRows()).find((a) => a.name === 'credit.reserved')?.payload).toMatchObject({ credits: 1, balance_after: 2 });
  });

  test('an account with NO credits is refused honestly — the balance and the cost are both reported', async () => {
    const runId = await runningRun();
    expect(await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' })).toEqual({ status: 'insufficient_credits', balance: 0, cost: 1 });
    expect(await rows()).toHaveLength(0);
    expect((await auditRows()).map((a) => a.name)).not.toContain('credit.reserved');
  });

  test('the LAST credit is spendable — exactly enough is enough', async () => {
    await grant(1);
    expect((await reserveCredit(product, { ...base(), taskRunId: await runningRun(), idempotencyKey: 'k1' })).status).toBe('ok');
  });

  test('RETRYING with the same key does not charge twice (BILL-002)', async () => {
    await grant(3);
    const runId = await runningRun();
    const first = await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    const again = await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    expect(again.status).toBe('run_already_reserved');
    expect((again as { entry: { id: string } }).entry.id).toBe((first as { entry: { id: string } }).entry.id);
    expect((await rows()).filter((x) => x.kind === 'reservation')).toHaveLength(1);
  });

  test('TWO DIFFERENT RUNS sharing one idempotency key: the INDEX refuses the second — the only path that reaches ON CONFLICT', async () => {
    // THE TEST THAT WOULD HAVE CAUGHT D1, AND THE ONE THAT FAILS IF THE INDEX IS DROPPED.
    //
    // Every other idempotency test in this file is short-circuited by `findReservationForRun`, which returns
    // `run_already_reserved` before the INSERT is attempted. So the partial unique index — the actual BILL-002 guard
    // — was never reached by any test, and its `ON CONFLICT` target was wrong from the day it was written. The guard
    // existed, the suite looked complete, and no reservation could ever have succeeded at runtime.
    //
    // Two DIFFERENT runs sharing ONE key is the only shape that gets past the run-level check and reaches the index.
    // Drop `credit_transactions_reservation_key_uq` and this test fails with two reservation rows instead of one.
    await grant(3);
    const runA = await runningRun();
    const runB = await runningRun();
    expect(runA).not.toBe(runB);

    expect((await reserveCredit(product, { ...base(), taskRunId: runA, idempotencyKey: 'shared-key' })).status).toBe('ok');
    // The insert is a no-op, so the caller is told the key is spent rather than handed a second charge.
    expect((await reserveCredit(product, { ...base(), taskRunId: runB, idempotencyKey: 'shared-key' })).status).not.toBe('ok');

    // THE ASSERTIONS THAT BREAK WITHOUT THE INDEX: exactly one reservation, and exactly one credit spent.
    const reservations = (await rows()).filter((x) => x.kind === 'reservation');
    expect(reservations).toHaveLength(1);
    expect(reservations[0]?.idempotency_key).toBe('shared-key');
    expect((await rows()).reduce((sum, r) => sum + Number(r.credits), 0)).toBe(2); // 3 granted - 1 reserved
  });

  test('a DIFFERENT key on the same run is still refused — the run, not the key, is what may be charged once', async () => {
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    expect((await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k2' })).status).toBe('run_already_reserved');
    expect((await rows()).filter((x) => x.kind === 'reservation')).toHaveLength(1);
  });

  test('a blank idempotency key is refused, not treated as a key', async () => {
    // The P5-003b lesson: an empty string treated as a real key makes unrelated calls collide.
    await grant(3);
    expect((await reserveCredit(product, { ...base(), taskRunId: await runningRun(), idempotencyKey: '   ' })).status).toBe('invalid');
  });

  test('a run from another company cannot be reserved against — it reads as absent', async () => {
    await grant(3);
    const runId = await runningRun();
    const intruder = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    expect(await reserveCredit(product, { ...intruder, taskRunId: runId, idempotencyKey: 'k1' })).toEqual({ status: 'run_not_found' });
  });

  // ── THE AT-025 RACE ───────────────────────────────────────────────────────────────────────────────────────
  test('TWO CONCURRENT RUNS, ONE CREDIT: exactly one wins, and the balance never goes negative', async () => {
    // BILL-002's acceptance, and the reason this ticket is trust-critical. The lock is taken BEFORE the balance is
    // derived, so the second caller cannot read the credit the first is about to spend. Deriving first would let both
    // read "1 left", both find it sufficient, and the account fall to -1.
    await grant(1);
    const runA = await runningRun();
    const runB = await runningRun();

    // DETERMINISTIC, not hopeful. A gate connection holds the account lock; both reservations are launched and BOTH
    // queue behind it; only once both are demonstrably blocked does the gate release. That guarantees the two
    // transactions were in flight simultaneously — which is the only condition under which the race exists at all.
    // Separate clients, because two calls through one pool could otherwise serialize at the pool and prove nothing.
    const gate = createRestrictedProductClient();
    const clientA = createRestrictedProductClient();
    const clientB = createRestrictedProductClient();
    try {
      let bothQueued = false;
      const gateHeld = asRestricted(gate, { account: w.accountA, company: w.companyA1 }, async (db) => {
        await sql`select id from accounts where id = ${w.accountA} for update`.execute(db);
        const r = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        await waitForBlockedBy(r.rows[0]?.pid ?? 0, 2);
        bothQueued = true;
        // Returning here commits the gate transaction and releases the lock; the two contenders then proceed one
        // after the other, each deriving a balance the other cannot be midway through changing.
      });

      const racing = Promise.all([
        reserveCredit(clientA, { ...base(), taskRunId: runA, idempotencyKey: 'race-a' }),
        reserveCredit(clientB, { ...base(), taskRunId: runB, idempotencyKey: 'race-b' }),
      ]);
      await gateHeld;
      expect(bothQueued).toBe(true); // both really were contending — the test cannot degrade into a sequential one.

      const [first, second] = await racing;
      expect([first.status, second.status].sort()).toEqual(['insufficient_credits', 'ok']);
    } finally {
      await closeDatabase(clientB);
      await closeDatabase(clientA);
      await closeDatabase(gate);
    }

    // THE INVARIANT, checked independently of who won: one reservation exists, and the balance is the ledger sum.
    const ledger = await rows();
    expect(ledger.filter((x) => x.kind === 'reservation')).toHaveLength(1);
    const sum = ledger.reduce((acc, x) => acc + x.credits, 0);
    expect(sum).toBe(0);
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      expect(await new CreditRepository(db).deriveBalance(w.accountA)).toBe(sum);
    });
  });

  test('the reservation is SERIALIZED by a real lock — a held account lock blocks it', async () => {
    // Proves the mechanism, not just the outcome. If someone removed `lockAccountForSpend`, the race test above could
    // still pass by luck on a fast machine; this one cannot, because it asserts that blocking actually happens.
    await grant(5);
    const runId = await runningRun();
    const holder = createRestrictedProductClient();
    try {
      let released = false;
      const holding = asRestricted(holder, { account: w.accountA, company: w.companyA1 }, async (db) => {
        await sql`select id from accounts where id = ${w.accountA} for update`.execute(db);
        const r = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        await waitForBlockedBy(r.rows[0]?.pid ?? 0);
        released = true;
      });
      const reserving = reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
      await holding;
      expect(released).toBe(true); // something DID block on the account lock — the serialization point is real.
      expect((await reserving).status).toBe('ok');
    } finally {
      await closeDatabase(holder);
    }
  });

  // ── SETTLEMENT (USAGE-AND-BILLING §4) ─────────────────────────────────────────────────────────────────────
  test('a SUCCEEDED run consumes: the credit is gone and the ledger says why', async () => {
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    await endRun(runId, 'succeeded');
    const settled = await settleRun(product, { ...base(), taskRunId: runId });
    expect(settled).toMatchObject({ status: 'ok', settlement: 'consume', balanceAfter: 1 });
    expect((await rows()).map((x) => x.kind).sort()).toEqual(['consumption', 'grant', 'reservation']);
    expect((await auditRows()).find((a) => a.name === 'credit.settled')?.payload).toMatchObject({ settlement: 'consume', balance_after: 1 });
  });

  test('a FAILED run RELEASES — the founder ends up exactly where they started', async () => {
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    await endRun(runId, 'failed');
    expect(await settleRun(product, { ...base(), taskRunId: runId })).toMatchObject({ status: 'ok', settlement: 'release', balanceAfter: 3 });
  });

  test('a CANCELLED run releases too (MVP-generous, and canon says so)', async () => {
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    await endRun(runId, 'cancelled');
    expect(await settleRun(product, { ...base(), taskRunId: runId })).toMatchObject({ status: 'ok', settlement: 'release', balanceAfter: 3 });
  });

  test('a RUNNING run cannot be settled — the reservation stays held', async () => {
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    // The run is genuinely still running — the state in the DATABASE is what refuses, not a string we passed in.
    expect(await settleRun(product, { ...base(), taskRunId: runId })).toEqual({ status: 'not_settleable', outcome: 'running' });
    expect((await rows()).filter((x) => x.kind === 'consumption' || x.kind === 'release')).toHaveLength(0);
  });

  test('SETTLING TWICE is impossible — a run cannot be consumed and then also released', async () => {
    // Without the settlement index this would mint a credit out of an ordinary retry: consume once, release once,
    // net zero spend for real work delivered.
    await grant(3);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    await endRun(runId, 'succeeded');
    await settleRun(product, { ...base(), taskRunId: runId });
    const again = await settleRun(product, { ...base(), taskRunId: runId });
    expect(again.status).toBe('already_settled');
    expect((await rows()).filter((x) => x.kind === 'release')).toHaveLength(0);
    const sum = (await rows()).reduce((acc, x) => acc + x.credits, 0);
    expect(sum).toBe(2);
  });

  test('settling a run that never reserved is refused rather than inventing a settlement', async () => {
    await grant(3);
    const runId = await runningRun();
    await endRun(runId, 'succeeded');
    expect(await settleRun(product, { ...base(), taskRunId: runId })).toEqual({ status: 'no_reservation' });
  });

  // ── THE READ (CDR-058 §2 — the A/C widening) ──────────────────────────────────────────────────────────────
  test('the ledger read is ACCOUNT-OWNER only, and it spans the account\'s companies', async () => {
    await grant(10);
    const runId = await runningRun();
    await reserveCredit(product, { ...base(), taskRunId: runId, idempotencyKey: 'k1' });
    const r = await readCreditLedger(product, { userId: w.aOwner, accountId: w.accountA });
    expect(r).toMatchObject({ status: 'ok', balance: 9 });
    expect((r as { entries: readonly unknown[] }).entries).toHaveLength(2);
  });

  test('AN ACCOUNT VIEWER WHO IS A COMPANY OWNER IS STILL DENIED — the HIGH finding, made testable', async () => {
    // Review pass 1's HIGH. The first version ran the read in a COMPANY scope, so it checked the caller's
    // company-membership role: this exact user — account `viewer`, company `owner` — would have been handed the
    // whole account's ledger, every company's spending. The seeded world cannot express the divergence (every user's
    // company role equals their account role), which is why the original viewer test passed for the wrong reason.
    // So the divergence is built here, deliberately, as the owner role.
    await grant(10);
    await sql`update company_memberships set role = 'owner' where company_id = ${w.companyA1} and member_user_id = ${w.aViewer}`.execute(owner.kysely);
    const asCompanyOwner = await sql<{ role: string }>`
      select role from company_memberships where company_id = ${w.companyA1} and member_user_id = ${w.aViewer}
    `.execute(owner.kysely);
    expect(asCompanyOwner.rows[0]?.role).toBe('owner'); // the divergence really exists...

    // ...and the account role is what decides.
    expect(await readCreditLedger(product, { userId: w.aViewer, accountId: w.accountA })).toEqual({ status: 'forbidden' });
  });

  test('a VIEWER cannot read the ledger — it would disclose the account\'s other companies\' spending', async () => {
    // The one place the A/C scoping widens what a row can show. RLS cannot prevent it (the predicate is the account,
    // by design), so `billing:read` is the control and it is owner-only.
    await grant(10);
    expect(await readCreditLedger(product, { userId: w.aViewer, accountId: w.accountA })).toEqual({ status: 'forbidden' });
  });

  test('another account sees none of it', async () => {
    await grant(10);
    const other = await readCreditLedger(product, { userId: w.bOwner, accountId: w.accountB });
    expect(other).toMatchObject({ status: 'ok', balance: 0 });
    expect((other as { entries: readonly unknown[] }).entries).toEqual([]);
  });
});
