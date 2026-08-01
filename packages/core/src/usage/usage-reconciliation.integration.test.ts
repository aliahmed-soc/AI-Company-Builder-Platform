// ACBP-P6-009 / CDR-073 — rollup reconciliation on real PostgreSQL (launch gate 7).
//
// The backlog's failure mode, verbatim: **"Drift detected = rebuild + alert."**
//
// THE HARD PART IS MAKING DRIFT REAL. A reconciliation suite that never actually corrupts the projection proves
// only that "no drift" reports no drift, which is also what a completely broken check reports. So every drift case
// below CORRUPTS THE STORED ROW DIRECTLY as the superuser — writing a figure the ledger does not support — and
// then asserts the check notices, reports the right per-lane number, and repairs it.
//
// The control that makes those positives meaningful is `no drift reports no drift and rebuilds nothing`: without
// it, a check that alerted unconditionally would pass every other test here.
//
// Runs as `acbp_app` under FORCE RLS through the real use case. Skips without ACBP_TEST_DATABASE_URL — a skipped
// run is never green; hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, type DatabaseClient } from '@acbp/database';
import { rebuildAccountUsageRollup, reconcileAccountUsageRollup, readAccountUsageRollup } from './usage-rollup-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

const PERIOD = '2026-08-01';
const IN_PERIOD = '2026-08-14T10:00:00.000Z';
/** A tolerance the OWNER has not set. Chosen per-test to exercise the boundary; no default exists in the code. */
const ZERO_TOLERANCE = { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };

/** The stored `usage.rollup_reconciled` payload, as the audit trail actually holds it. */
interface ReconciledPayload {
  readonly period_start: string;
  // ALL FOUR DRIFT LANES ARE DECLARED AND ASSERTED. An earlier version declared only `input_tokens_drift`, so
  // three of the four could have been transposed, zeroed or dropped and nothing would have noticed — in the one
  // payload CDR-073 §1-G15 exists to make answer "did the number move, and by how much".
  readonly event_count_drift: number;
  readonly input_tokens_drift: number;
  readonly output_tokens_drift: number;
  readonly estimated_cost_micros_drift: number;
  readonly rebuild_applied: boolean;
  readonly stored_existed: boolean;
  /** Comma-joined lane names; empty string means no lane exceeded the tolerance. */
  readonly lanes_exceeding_threshold: string;
}

describe.skipIf(!hasTestDatabase)('rollup reconciliation (real PostgreSQL) — ACBP-P6-009/CDR-073, launch gate 7', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let seq = 0;

  let accountOwner = '';
  let accountViewer = '';
  /** ACCOUNT viewer, COMPANY owner — the user whose two roles disagree, so the account check is provably the one. */
  let companyOwnerAccountViewer = '';
  let outsider = '';
  let accountA = '';
  let companyA1 = '';

  async function seedUser(): Promise<string> {
    seq += 1;
    const r = await sql<{ id: string }>`
      insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at)
      values ('clerk', 'ins_recon', ${`reconuser_${seq}`}, now()) returning id
    `.execute(seed.kysely);
    return r.rows[0]!.id;
  }
  async function seedAccount(ownerUserId: string, viewers: readonly string[] = []): Promise<string> {
    const a = await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${ownerUserId}::uuid) returning id`.execute(seed.kysely);
    const id = a.rows[0]!.id;
    await sql`insert into memberships (account_id, member_user_id, role, status, accepted_at) values (${id}::uuid, ${ownerUserId}::uuid, 'owner', 'active', now())`.execute(seed.kysely);
    for (const v of viewers) {
      await sql`insert into memberships (account_id, member_user_id, role, status, accepted_at) values (${id}::uuid, ${v}::uuid, 'viewer', 'active', now())`.execute(seed.kysely);
    }
    return id;
  }
  async function seedCompany(account: string, members: readonly string[]): Promise<string> {
    const c = await sql<{ id: string }>`insert into companies (account_id, creation_mode, status) values (${account}::uuid, 'own_idea', 'active') returning id`.execute(seed.kysely);
    const id = c.rows[0]!.id;
    for (const u of members) {
      await sql`insert into company_memberships (account_id, company_id, member_user_id, role, status) values (${account}::uuid, ${id}::uuid, ${u}::uuid, 'owner', 'active')`.execute(seed.kysely);
    }
    return id;
  }
  async function seedEvent(f: { input: number; output: number; cost: number }, at = IN_PERIOD): Promise<string> {
    const r = await sql<{ id: string }>`
      insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
      values (${accountA}::uuid, ${companyA1}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok', ${f.input}, ${f.output}, ${f.cost}, false, 7, ${at}::timestamptz)
      returning id
    `.execute(seed.kysely);
    return r.rows[0]!.id;
  }

  /**
   * Corrupt the stored projection as the superuser, bypassing every use case.
   *
   * THROWS if no row was updated. A silent no-op here would leave the "drift" tests asserting against an
   * uncorrupted projection — they would pass by agreeing that nothing was wrong, which is precisely the class of
   * vacuous positive this ticket is written against.
   */
  async function corruptStoredRollup(figures: Partial<{ event_count: number; input_tokens: number; output_tokens: number; estimated_cost_micros: number }>): Promise<void> {
    const entries = Object.entries(figures);
    if (entries.length === 0) throw new Error('corruptStoredRollup called with no figures — the test would assert nothing');
    for (const [col, value] of entries) {
      const r = await sql.raw(`update account_usage_rollups set ${col} = ${Number(value)} where account_id = '${accountA}' and period_start = '${PERIOD}'`).execute(seed.kysely);
      if (Number(r.numAffectedRows ?? 0n) !== 1) {
        throw new Error(`corruptStoredRollup updated ${String(r.numAffectedRows)} rows for ${col} — the projection under test does not exist`);
      }
    }
  }

  const reconcile = (userId: string, threshold: unknown = ZERO_TOLERANCE, period: unknown = PERIOD) =>
    reconcileAccountUsageRollup(app, { userId, accountId: accountA, periodStart: period, threshold });

  const rebuild = (userId: string) => rebuildAccountUsageRollup(app, { userId, accountId: accountA, periodStart: PERIOD });

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  }, 120_000);

  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ALL) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });

  beforeEach(async () => {
    for (const t of ['usage_corrections', 'account_usage_rollups', 'usage_events', 'audit_events', 'company_memberships', 'company_profiles', 'companies', 'memberships', 'accounts', 'users'] as const) {
      await sql.raw(`delete from ${t}`).execute(seed.kysely);
    }
    accountOwner = await seedUser();
    accountViewer = await seedUser();
    companyOwnerAccountViewer = await seedUser();
    outsider = await seedUser();
    accountA = await seedAccount(accountOwner, [accountViewer, companyOwnerAccountViewer]);
    // `companyOwnerAccountViewer` is an OWNER here and a VIEWER on the account above — deliberately divergent.
    companyA1 = await seedCompany(accountA, [accountOwner, companyOwnerAccountViewer]);
  });

  // ── the control ───────────────────────────────────────────────────────────────────────────────────────────

  test('NO DRIFT reports no drift, alerts nothing, and rebuilds nothing (the control)', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    const before = await sql<{ computed_at: Date }>`select computed_at from account_usage_rollups`.execute(seed.kysely);

    const r = await reconcile(accountOwner);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.drift).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    expect(r.lanesExceedingThreshold).toEqual([]);
    expect(r.rebuildApplied).toBe(false);
    expect(r.storedExisted).toBe(true);
    expect(r.computed).toEqual(r.stored);

    // Not rewritten: `computed_at` is unchanged, so "rebuilt nothing" is a fact about the row, not just a flag.
    const after = await sql<{ computed_at: Date }>`select computed_at from account_usage_rollups`.execute(seed.kysely);
    expect(after.rows[0]!.computed_at).toEqual(before.rows[0]!.computed_at);
  });

  // ── drift detection, repair, and the alert ────────────────────────────────────────────────────────────────

  test('a CORRUPTED projection is detected per lane, repaired, and reported SIGNED', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    // The projection now claims 80 input tokens (20 SHORT of the ledger's 100) and 1200 micros (200 OVER).
    await corruptStoredRollup({ input_tokens: 80, estimated_cost_micros: 1200 });

    const r = await reconcile(accountOwner);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.stored.inputTokens).toBe(80);
    expect(r.computed.inputTokens).toBe(100);
    // SIGNED: the projection is 20 tokens SHORT and 200 micros OVER. Collapsing these to magnitudes would throw
    // away the half of the signal that says which bug to look for.
    expect(r.drift).toEqual({ eventCount: 0, inputTokens: 20, outputTokens: 0, estimatedCostMicros: -200 });
    expect(r.rebuildApplied).toBe(true);

    // REPAIRED — and the repair is verified by reading the row back, not by trusting the flag.
    const stored = await sql<{ input_tokens: string; estimated_cost_micros: string }>`
      select input_tokens, estimated_cost_micros from account_usage_rollups
    `.execute(seed.kysely);
    expect(Number(stored.rows[0]!.input_tokens)).toBe(100);
    expect(Number(stored.rows[0]!.estimated_cost_micros)).toBe(1000);

    // ...and reconciling again is now clean, which is what "repaired" has to mean.
    const again = await reconcile(accountOwner);
    if (again.status !== 'ok') throw new Error('expected ok');
    expect(again.drift).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    expect(again.rebuildApplied).toBe(false);
  });

  test('a MISSING projection is drift, not absence — it is reported and created', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    // Never rebuilt: there is no row at all.
    const r = await reconcile(accountOwner);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.storedExisted).toBe(false);
    expect(r.stored).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    expect(r.drift.inputTokens).toBe(100);
    expect(r.rebuildApplied).toBe(true);

    const n = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('1');
  });

  test('a missing projection over ZERO usage is still created — "never computed" is not "computed and zero"', async () => {
    // No events at all. The drift is zero in every lane, so a check that keyed the repair on drift alone would
    // leave the account with NO projection and report everything fine — and the next reader could not tell
    // whether the period had been computed.
    const r = await reconcile(accountOwner);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.storedExisted).toBe(false);
    expect(r.drift).toEqual({ eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    expect(r.rebuildApplied).toBe(true);

    const read = await readAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    expect(read.status).toBe('ok');
  });

  test('REPAIR AND ALERT ARE SEPARATE TRIGGERS — a sub-threshold drift is still repaired', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    await corruptStoredRollup({ input_tokens: 95 });

    // A generous tolerance: 5 tokens is well within it, so nothing ALERTS.
    const r = await reconcile(accountOwner, { eventCount: 0, inputTokens: 50, outputTokens: 50, estimatedCostMicros: 500 });
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.drift.inputTokens).toBe(5);
    expect(r.lanesExceedingThreshold).toEqual([]);
    // ...and yet it IS repaired. Leaving a known-wrong number in place because it is small is how §0's silent
    // wrongness accumulates, one rounding at a time.
    expect(r.rebuildApplied).toBe(true);
    const stored = await sql<{ input_tokens: string }>`select input_tokens from account_usage_rollups`.execute(seed.kysely);
    expect(Number(stored.rows[0]!.input_tokens)).toBe(100);
  });

  // NAMING, NOT ALERTING. What is proven here is that the exceeding lanes are correctly COMPUTED and reported;
  // no alert channel exists yet and none is invoked. Surfacing is P6-010's (CDR-073 §4), so "drift beyond
  // threshold alerts" is met here only up to the point where this ticket's responsibility ends.
  test('a drift BEYOND the tolerance is reported, naming every exceeding lane', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    await corruptStoredRollup({ input_tokens: 40, output_tokens: 49, estimated_cost_micros: 200 });

    const r = await reconcile(accountOwner, { eventCount: 0, inputTokens: 10, outputTokens: 10, estimatedCostMicros: 100 });
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    // inputTokens drifts 60 (> 10) and cost drifts 800 (> 100); outputTokens drifts only 1 (within 10).
    expect(r.lanesExceedingThreshold).toEqual(['inputTokens', 'estimatedCostMicros']);
    // The sub-threshold lane still DRIFTED, and the repair is unconditional on the alert.
    expect(r.drift.outputTokens).toBe(1);
    expect(r.rebuildApplied).toBe(true);
  });

  test('the eventCount lane alone can drift, be alerted on, and be repaired', async () => {
    // `event_count` was the one lane no corruption case exercised, so its drift/alert/repair path had no
    // positive test at all — the lane whose value most directly reads as "how much work did this account do".
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    await seedEvent({ input: 0, output: 0, cost: 0 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    await corruptStoredRollup({ event_count: 1 });

    const r = await reconcile(accountOwner);
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    expect(r.stored.eventCount).toBe(1);
    expect(r.computed.eventCount).toBe(2);
    expect(r.drift).toEqual({ eventCount: 1, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 });
    expect(r.lanesExceedingThreshold).toEqual(['eventCount']);
    expect(r.rebuildApplied).toBe(true);

    const stored = await sql<{ event_count: string }>`select event_count from account_usage_rollups`.execute(seed.kysely);
    expect(Number(stored.rows[0]!.event_count)).toBe(2);
  });

  // ── the audit record ──────────────────────────────────────────────────────────────────────────────────────

  test('reconciliation is AUDITED with the per-lane drift and whether it rebuilt', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    // ALL FOUR LANES CORRUPTED BY DISTINCT AMOUNTS, including `event_count`, which no earlier case touched at
    // all. Distinct drifts are what make a transposed payload field detectable: equal ones would agree.
    await corruptStoredRollup({ event_count: 0, input_tokens: 80, output_tokens: 47, estimated_cost_micros: 1200 });
    expect((await reconcile(accountOwner)).status).toBe('ok');

    const events = await sql<{ subject_type: string; subject_id: string; payload: ReconciledPayload }>`
      select subject_type, subject_id, payload from audit_events where name = 'usage.rollup_reconciled'
    `.execute(seed.kysely);
    expect(events.rows).toHaveLength(1);
    const e = events.rows[0]!;
    expect(e.subject_type).toBe('account');
    expect(e.subject_id).toBe(accountA);
    expect(e.payload.period_start).toBe(PERIOD);
    // THE NUMBER MOVED, AND BY HOW MUCH, IN EVERY LANE. An event recording only that reconciliation RAN cannot
    // answer this, which is the nominal-versus-substantive defect this payload exists to avoid. Each expected
    // value is distinct, so a transposition between any two lanes fails here.
    expect(e.payload.event_count_drift).toBe(1); // computed 1, stored 0
    expect(e.payload.input_tokens_drift).toBe(20); // computed 100, stored 80
    expect(e.payload.output_tokens_drift).toBe(3); // computed 50, stored 47
    expect(e.payload.estimated_cost_micros_drift).toBe(-200); // computed 1000, stored 1200 — OVER, hence negative
    expect(e.payload.rebuild_applied).toBe(true);
    expect(e.payload.stored_existed).toBe(true);
    // Zero tolerance, so every drifting lane alerts, in the closed lane order.
    expect(e.payload.lanes_exceeding_threshold).toBe('eventCount,inputTokens,outputTokens,estimatedCostMicros');
  });

  test('a CLEAN reconciliation is audited too — "checked and found nothing" is itself the evidence', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    expect((await reconcile(accountOwner)).status).toBe('ok');

    const events = await sql<{ payload: ReconciledPayload }>`
      select payload from audit_events where name = 'usage.rollup_reconciled'
    `.execute(seed.kysely);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload.rebuild_applied).toBe(false);
    expect(events.rows[0]!.payload.event_count_drift).toBe(0);
    expect(events.rows[0]!.payload.input_tokens_drift).toBe(0);
    expect(events.rows[0]!.payload.output_tokens_drift).toBe(0);
    expect(events.rows[0]!.payload.estimated_cost_micros_drift).toBe(0);
    // Empty string means "no lane exceeded" — the field is always present, so empty is a real answer.
    expect(events.rows[0]!.payload.lanes_exceeding_threshold).toBe('');
  });

  // ── the threshold is the owner's, and a bad one is refused ────────────────────────────────────────────────

  test('a NaN tolerance is REFUSED, not silently accepted — it would disable alerting entirely', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    await corruptStoredRollup({ input_tokens: 0 });

    // `Math.abs(100) > NaN` is false, so an unrefused NaN would report this enormous drift as within tolerance.
    const r = await reconcile(accountOwner, { eventCount: NaN, inputTokens: NaN, outputTokens: NaN, estimatedCostMicros: NaN });
    expect(r.status).toBe('invalid_threshold');

    // Refused BEFORE any scope or write: the corrupted projection is untouched, so a refusal cannot be mistaken
    // for a completed reconciliation.
    const stored = await sql<{ input_tokens: string }>`select input_tokens from account_usage_rollups`.execute(seed.kysely);
    expect(Number(stored.rows[0]!.input_tokens)).toBe(0);
    const n = await sql<{ n: string }>`select count(*)::text as n from audit_events where name = 'usage.rollup_reconciled'`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a malformed, partial or negative tolerance is refused', async () => {
    // ⚠️ `undefined` IS DELIBERATELY ABSENT FROM THIS LIST, and the reason is worth keeping. The `reconcile`
    // helper above gives `threshold` a DEFAULT parameter, and a JavaScript default fires precisely when the
    // argument is `undefined` — so passing it here substitutes the valid ZERO_TOLERANCE and the call succeeds.
    // The test asserting otherwise failed in CI for exactly that reason: it was measuring the helper, not the
    // guard. A missing threshold IS refused, and is proven where no default can mask it —
    // `usage-input-validation.test.ts`, which calls the use case directly and needs no database.
    for (const bad of [
      null,
      42,
      'zero',
      {},
      { eventCount: 0, inputTokens: 0, outputTokens: 0 }, // a lane missing entirely
      { eventCount: 0, inputTokens: -1, outputTokens: 0, estimatedCostMicros: 0 }, // negative
      { eventCount: 0, inputTokens: 1.5, outputTokens: 0, estimatedCostMicros: 0 }, // fractional
      { eventCount: 0, inputTokens: Infinity, outputTokens: 0, estimatedCostMicros: 0 },
      { eventCount: 0, inputTokens: '10', outputTokens: 0, estimatedCostMicros: 0 }, // a string that coerces
    ]) {
      const r = await reconcile(accountOwner, bad);
      expect(r.status, `threshold ${JSON.stringify(bad)} must be refused`).toBe('invalid_threshold');
    }
  });

  test('a malformed period is refused before any scope or write', async () => {
    for (const bad of ['2026-08-17', 'not-a-date', '', '2026-13-01']) {
      expect((await reconcile(accountOwner, ZERO_TOLERANCE, bad)).status).toBe('invalid_period');
    }
    const n = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a caller with NO account membership is denied, and nothing is written', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    const r = await reconcile(outsider);
    expect(r.status).toBe('denied');
    const n = await sql<{ n: string }>`select count(*)::text as n from account_usage_rollups`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  // ── the read (usage:read) ─────────────────────────────────────────────────────────────────────────────────

  test('the read returns the stored figures as NUMBERS, marshalled through the bigint seam', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');

    const r = await readAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    if (r.status !== 'ok') throw new Error(`expected ok, got ${r.status}`);
    // Real numbers, not the strings node-postgres returns for bigint (§1-G14). `toBe` on a number would pass for
    // a string under `toEqual` loose matching in some shapes, so the type is asserted directly.
    expect(typeof r.figures.inputTokens).toBe('number');
    expect(r.figures).toEqual({ eventCount: 1, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 1000 });
    expect(r.computedAt).toBeInstanceOf(Date);
  });

  test('the read distinguishes NEVER COMPUTED from computed-and-zero', async () => {
    const missing = await readAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    expect(missing.status).toBe('not_computed');

    expect((await rebuild(accountOwner)).status).toBe('ok');
    const zero = await readAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    if (zero.status !== 'ok') throw new Error('expected ok');
    expect(zero.figures.eventCount).toBe(0);
  });

  test('AN ACCOUNT VIEWER WHO IS A COMPANY OWNER IS STILL REFUSED BY ALL THREE — the ACCOUNT role decides', async () => {
    // ⚠️ THE FIXTURE IS THE TEST, as in the corrections suite. A viewer with no company membership would be
    // refused by a build that resolved the role from `company_memberships` — the `readCreditLedger` pass-1 HIGH
    // this service cites — because they would resolve to `role = null` anyway. Only a caller whose account and
    // company roles DISAGREE can distinguish the two.
    const companyRole = await sql<{ role: string }>`
      select role from company_memberships where member_user_id = ${companyOwnerAccountViewer}::uuid and company_id = ${companyA1}::uuid
    `.execute(seed.kysely);
    expect(companyRole.rows).toHaveLength(1);
    expect(companyRole.rows[0]!.role).toBe('owner');

    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');

    // ALL THREE, not just the read. `rebuild` and `reconcile` RETURN the same account figures the read does, so
    // gating only the read would let a viewer take the identical numbers by another door — and, in their case,
    // write the projection and stamp an audit event while doing it.
    expect((await readAccountUsageRollup(app, { userId: companyOwnerAccountViewer, accountId: accountA, periodStart: PERIOD })).status).toBe('forbidden');
    expect((await rebuildAccountUsageRollup(app, { userId: companyOwnerAccountViewer, accountId: accountA, periodStart: PERIOD })).status).toBe('forbidden');
    expect((await reconcile(companyOwnerAccountViewer)).status).toBe('forbidden');
  });

  test('a refused viewer writes NOTHING — no projection change and no audit event', async () => {
    await seedEvent({ input: 100, output: 50, cost: 1000 });
    expect((await rebuild(accountOwner)).status).toBe('ok');
    await corruptStoredRollup({ input_tokens: 7 });

    expect((await rebuildAccountUsageRollup(app, { userId: accountViewer, accountId: accountA, periodStart: PERIOD })).status).toBe('forbidden');
    expect((await reconcile(accountViewer)).status).toBe('forbidden');

    // The corrupted figure is UNTOUCHED: the refusal happened before any repair, so a viewer cannot even force a
    // rebuild they are not allowed to see the result of.
    const stored = await sql<{ input_tokens: string }>`select input_tokens from account_usage_rollups`.execute(seed.kysely);
    expect(Number(stored.rows[0]!.input_tokens)).toBe(7);
    const n = await sql<{ n: string }>`select count(*)::text as n from audit_events where name = 'usage.rollup_reconciled'`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');

    // CONTROL: the owner CAN do both, so these refusals are the role check and not a broken fixture.
    expect((await reconcile(accountOwner)).status).toBe('ok');
  });

  test('a plain account viewer is refused by the read too', async () => {
    expect((await readAccountUsageRollup(app, { userId: accountViewer, accountId: accountA, periodStart: PERIOD })).status).toBe('forbidden');
  });

  test('a non-member cannot read it either', async () => {
    const r = await readAccountUsageRollup(app, { userId: outsider, accountId: accountA, periodStart: PERIOD });
    expect(r.status).toBe('denied');
  });
});
