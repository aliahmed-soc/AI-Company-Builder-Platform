// ACBP-P6-009 / CDR-073 — compensating usage corrections on real PostgreSQL (trust-critical #13).
//
// Canon, verbatim: **"Usage corrections create compensating records (never edits)."**
//
// TWO HALVES, AND THE SECOND IS THE ONE THAT USUALLY GOES UNPROVEN. "Creates a compensating record" is easy to
// assert. "NEVER EDITS" is a claim about what CANNOT happen, and a suite that only records corrections would pass
// identically on a build where `usage_events` were freely updatable. So the negatives here go at the PRIVILEGES:
// the app role is shown to have no UPDATE and no DELETE on either ledger, attempted directly, as the role the
// application actually runs as.
//
// Runs as `acbp_app` under FORCE RLS through the real use case. Skips without ACBP_TEST_DATABASE_URL — a skipped
// run is never green; hosted CI on the exact SHA is the evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, type DatabaseClient } from '@acbp/database';
import { recordUsageCorrection } from './usage-correction-service.js';
import { rebuildAccountUsageRollup } from './usage-rollup-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

const PERIOD = '2026-08-01';
const IN_PERIOD = '2026-08-14T10:00:00.000Z';

describe.skipIf(!hasTestDatabase)('usage corrections (real PostgreSQL) — ACBP-P6-009/CDR-073, trust-critical #13', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let seq = 0;

  let accountOwner = '';
  let accountViewer = '';
  let outsider = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyB1 = '';
  let eventA1 = '';
  let eventB1 = '';

  async function seedUser(): Promise<string> {
    seq += 1;
    const r = await sql<{ id: string }>`
      insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at)
      values ('clerk', 'ins_corr', ${`corruser_${seq}`}, now()) returning id
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
  async function seedEvent(account: string, company: string, f: { input: number; output: number; cost: number }, at = IN_PERIOD): Promise<string> {
    const r = await sql<{ id: string }>`
      insert into usage_events (account_id, company_id, provider, model, task_class, outcome, input_tokens, output_tokens, estimated_cost_micros, fallback_used, latency_ms, created_at)
      values (${account}::uuid, ${company}::uuid, 'synthetic', 'model-x@1', 'generation', 'ok', ${f.input}, ${f.output}, ${f.cost}, false, 7, ${at}::timestamptz)
      returning id
    `.execute(seed.kysely);
    return r.rows[0]!.id;
  }

  const correct = (userId: string, over: Partial<Parameters<typeof recordUsageCorrection>[1]> = {}) =>
    recordUsageCorrection(app, {
      userId,
      accountId: accountA,
      companyId: companyA1,
      correctsUsageEventId: eventA1,
      eventCountDelta: 0,
      inputTokensDelta: -10,
      outputTokensDelta: 0,
      estimatedCostMicrosDelta: -100,
      reason: 'duplicate provider charge',
      ...over,
    });

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
    outsider = await seedUser();
    accountA = await seedAccount(accountOwner, [accountViewer]);
    accountB = await seedAccount(outsider);
    companyA1 = await seedCompany(accountA, [accountOwner]);
    companyB1 = await seedCompany(accountB, [outsider]);
    eventA1 = await seedEvent(accountA, companyA1, { input: 100, output: 50, cost: 1000 });
    eventB1 = await seedEvent(accountB, companyB1, { input: 100, output: 50, cost: 1000 });
  });

  // ── the compensating record itself ────────────────────────────────────────────────────────────────────────

  test('a correction is a NEW ROW referencing the original — and the original is UNCHANGED', async () => {
    const before = await sql<{ input_tokens: number; estimated_cost_micros: number }>`
      select input_tokens, estimated_cost_micros from usage_events where id = ${eventA1}::uuid
    `.execute(seed.kysely);

    const result = await correct(accountOwner);
    expect(result.status).toBe('ok');

    const row = await sql<{ corrects_usage_event_id: string; input_tokens_delta: number; estimated_cost_micros_delta: number; reason: string; created_by_user_id: string }>`
      select corrects_usage_event_id, input_tokens_delta, estimated_cost_micros_delta, reason, created_by_user_id from usage_corrections
    `.execute(seed.kysely);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.corrects_usage_event_id).toBe(eventA1);
    expect(row.rows[0]!.input_tokens_delta).toBe(-10);
    expect(row.rows[0]!.estimated_cost_micros_delta).toBe(-100);
    expect(row.rows[0]!.reason).toBe('duplicate provider charge');
    // ATTRIBUTION: who adjusted the figure is the question the audit trail exists to answer.
    expect(row.rows[0]!.created_by_user_id).toBe(accountOwner);

    // THE ORIGINAL IS BYTE-FOR-BYTE UNTOUCHED. This is the "never edits" half, at the row level.
    const after = await sql<{ input_tokens: number; estimated_cost_micros: number }>`
      select input_tokens, estimated_cost_micros from usage_events where id = ${eventA1}::uuid
    `.execute(seed.kysely);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  test('the correction REDUCES the rebuilt rollup by exactly its deltas', async () => {
    const before = await rebuildAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    if (before.status !== 'ok') throw new Error(`expected ok, got ${before.status}`);
    expect(before.figures).toEqual({ eventCount: 1, inputTokens: 100, outputTokens: 50, estimatedCostMicros: 1000 });

    expect((await correct(accountOwner)).status).toBe('ok');

    const after = await rebuildAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    if (after.status !== 'ok') throw new Error(`expected ok, got ${after.status}`);
    expect(after.figures).toEqual({ eventCount: 1, inputTokens: 90, outputTokens: 50, estimatedCostMicros: 900 });
  });

  test('a correction lands in the CORRECTED EVENT\'S period, not the period it was made in (§1-G10c)', async () => {
    // A JULY event. The correction row is created NOW (August, per the test clock) and must still reduce JULY.
    const julyEvent = await seedEvent(accountA, companyA1, { input: 500, output: 0, cost: 5000 }, '2026-07-10T09:00:00.000Z');
    const r = await correct(accountOwner, { correctsUsageEventId: julyEvent, inputTokensDelta: -500, estimatedCostMicrosDelta: -5000 });
    expect(r.status).toBe('ok');

    const july = await rebuildAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: '2026-07-01' });
    if (july.status !== 'ok') throw new Error('expected ok');
    expect(july.figures.inputTokens).toBe(0);
    expect(july.figures.estimatedCostMicros).toBe(0);

    // AUGUST IS UNTOUCHED. Bucketing by the correction's own timestamp would have taken 500 tokens off the wrong
    // month, leaving July permanently wrong in a way a rebuild would faithfully reproduce.
    const august = await rebuildAccountUsageRollup(app, { userId: accountOwner, accountId: accountA, periodStart: PERIOD });
    if (august.status !== 'ok') throw new Error('expected ok');
    expect(august.figures.inputTokens).toBe(100);
  });

  test('the correction is AUDITED as usage.corrected, subject = the CORRECTION row, carrying the deltas', async () => {
    const result = await correct(accountOwner);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);

    interface CorrectedPayload {
      readonly corrects_usage_event_id: string;
      readonly input_tokens_delta: number;
      readonly estimated_cost_micros_delta: number;
      readonly has_reason: boolean;
    }
    const events = await sql<{ name: string; subject_type: string; subject_id: string; payload: CorrectedPayload; actor_id: string }>`
      select name, subject_type, subject_id, payload, actor_id from audit_events where name = 'usage.corrected'
    `.execute(seed.kysely);
    expect(events.rows).toHaveLength(1);
    const e = events.rows[0]!;
    expect(e.subject_type).toBe('usage_correction');
    // THE SUBJECT IS THE CORRECTION, NOT THE EVENT IT COMPENSATES (§1-G15) — the corrected event did not change,
    // so filing the adjustment under it would point a reader at the one row that carries no adjustment.
    expect(e.subject_id).toBe(result.correctionId);
    expect(e.subject_id).not.toBe(eventA1);
    expect(e.actor_id).toBe(accountOwner);
    expect(e.payload.corrects_usage_event_id).toBe(eventA1);
    // The AMOUNTS are in the payload: an audit line saying only that a correction happened cannot answer how
    // much came off, which is the question this event exists for.
    expect(e.payload.input_tokens_delta).toBe(-10);
    expect(e.payload.estimated_cost_micros_delta).toBe(-100);
    expect(e.payload.has_reason).toBe(true);
    // The owner's free text is NOT copied into the payload — it lives on the subject row.
    expect(JSON.stringify(e.payload)).not.toContain('duplicate provider charge');
  });

  // ── "never edits", proven at the PRIVILEGES ───────────────────────────────────────────────────────────────

  test('NEVER EDITS: the app role has no UPDATE and no DELETE on either ledger', async () => {
    // Attempted as the role the application actually runs as. A build that relaxed these grants to "make
    // corrections easier" would turn this red — which a test that only records corrections never would.
    await sql`select set_config('app.current_account', ${accountA}, true)`.execute(app.kysely);
    await sql`select set_config('app.current_company', ${companyA1}, true)`.execute(app.kysely);

    await expect(sql`update usage_events set input_tokens = 1 where id = ${eventA1}::uuid`.execute(app.kysely)).rejects.toThrow();
    await expect(sql`delete from usage_events where id = ${eventA1}::uuid`.execute(app.kysely)).rejects.toThrow();

    expect((await correct(accountOwner)).status).toBe('ok');
    await expect(sql`update usage_corrections set input_tokens_delta = 0`.execute(app.kysely)).rejects.toThrow();
    await expect(sql`delete from usage_corrections`.execute(app.kysely)).rejects.toThrow();

    // ...and the correction is still there after all four attempts.
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('1');
  });

  test('AT MOST ONE correction per event — a second is refused, and the first is untouched (§1-G10b)', async () => {
    expect((await correct(accountOwner)).status).toBe('ok');
    const second = await correct(accountOwner, { inputTokensDelta: -1, estimatedCostMicrosDelta: -1, reason: 'second attempt' });
    expect(second.status).toBe('already_corrected');

    const rows = await sql<{ input_tokens_delta: number; reason: string }>`select input_tokens_delta, reason from usage_corrections`.execute(seed.kysely);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.input_tokens_delta).toBe(-10);
    expect(rows.rows[0]!.reason).toBe('duplicate provider charge');
  });

  test('a correction cannot subtract MORE than the event ever recorded (§1-G10)', async () => {
    const result = await correct(accountOwner, { inputTokensDelta: -101, estimatedCostMicrosDelta: 0 });
    expect(result.status).toBe('exceeds_original');
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a POSITIVE delta is refused — usage can only ever be reduced (§1-G10a)', async () => {
    // The one direction that must stay structurally impossible: inflating recorded usage without a real metered
    // event behind it. Refused before the database by the service, and by a CHECK if it ever got there.
    const result = await correct(accountOwner, { inputTokensDelta: 5 });
    expect(result.status).toBe('invalid_delta');
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('an ALL-ZERO correction is refused — it would consume the event\'s one correction slot for nothing', async () => {
    const result = await correct(accountOwner, { eventCountDelta: 0, inputTokensDelta: 0, outputTokensDelta: 0, estimatedCostMicrosDelta: 0 });
    expect(result.status).toBe('invalid_delta');
    // ...and the slot is still available, which is the part that matters.
    expect((await correct(accountOwner)).status).toBe('ok');
  });

  test('a non-integer or NaN delta never reaches the database', async () => {
    for (const bad of [-1.5, NaN, Infinity, -Infinity, '−10', null, undefined]) {
      const result = await correct(accountOwner, { inputTokensDelta: bad as never });
      expect(result.status, `delta ${String(bad)} must be refused`).toBe('invalid_delta');
    }
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a blank, missing or over-long reason is refused', async () => {
    for (const bad of ['', '   ', null, undefined, 42, 'x'.repeat(501)]) {
      const result = await correct(accountOwner, { reason: bad as never });
      expect(result.status, `reason ${JSON.stringify(bad)} must be refused`).toBe('invalid_reason');
    }
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  // ── authorization and tenancy ─────────────────────────────────────────────────────────────────────────────

  test('an account VIEWER is forbidden — correcting usage is owner-only', async () => {
    const result = await correct(accountViewer);
    expect(result.status).toBe('forbidden');
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a caller with NO membership in the account is denied, and writes nothing', async () => {
    const result = await correct(outsider);
    expect(result.status).toBe('denied');
    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('an owner CANNOT correct another account\'s usage event, by either handle', async () => {
    // By the other account's COMPANY: `elevateToCompanyScope` verifies the company belongs to the caller's
    // account and fails closed.
    const byCompany = await correct(accountOwner, { companyId: companyB1, correctsUsageEventId: eventB1 });
    expect(byCompany.status).toBe('company_not_found');

    // By the other account's EVENT id inside their OWN company: RLS confines the lookup, so the foreign event
    // reads as ABSENT rather than as a refusal that would confirm it exists.
    const byEvent = await correct(accountOwner, { correctsUsageEventId: eventB1 });
    expect(byEvent.status).toBe('usage_event_not_found');

    const n = await sql<{ n: string }>`select count(*)::text as n from usage_corrections`.execute(seed.kysely);
    expect(n.rows[0]!.n).toBe('0');
  });

  test('a refused correction leaves NO audit event — the row and its record commit together', async () => {
    expect((await correct(accountViewer)).status).toBe('forbidden');
    expect((await correct(accountOwner, { inputTokensDelta: -101, estimatedCostMicrosDelta: 0 })).status).toBe('exceeds_original');
    const events = await sql<{ n: string }>`select count(*)::text as n from audit_events where name = 'usage.corrected'`.execute(seed.kysely);
    expect(events.rows[0]!.n).toBe('0');
  });
});
