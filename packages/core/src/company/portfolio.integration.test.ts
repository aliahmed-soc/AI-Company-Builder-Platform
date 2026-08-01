// ACBP-P1-011 / CDR-017 — real-PostgreSQL tests for the membership-filtered company portfolio + sequential
// name enrichment (Slices 2-3). Trust-critical: proves the portfolio contains ONLY active-membership companies
// (account membership alone grants no row), that names are enriched per-candidate under FRESH CompanyScopes with
// no cross-company bleed, that a membership going STALE between enumeration and enrichment DROPS the row (never a
// stale/substituted row), keyset pagination + account+actor-bound cursor, and strict limit/cursor rejection.
// Runs as the restricted `acbp_app` role under FORCE RLS. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { closeDatabase, migrateToLatest, type DatabaseClient, type NewUser, type PortfolioCandidateRow } from '@acbp/database';
import { encodePortfolioCursor } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from './company-service.js';
import { getCompanyPortfolio, enrichCandidatesSequentially } from './portfolio-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_pf', provider_user_id: `pfuser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('company portfolio + enrichment (real PostgreSQL, restricted role) — ACBP-P1-011/CDR-017', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let viewerId: string;
  let outsiderId: string;
  let accountId: string;

  const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

  beforeAll(async () => {
    seed = createSeedClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(seed);
    expect(r.error).toBeUndefined();
    await enableAppLogin(seed);
    app = createAppClient();
  });
  afterAll(async () => {
    if (app) await closeDatabase(app);
    if (seed) {
      await disableAppLogin(seed);
      for (const t of ALL) await seed.kysely.schema.dropTable(t).ifExists().cascade().execute();
      await closeDatabase(seed);
    }
  });
  beforeEach(async () => {
    for (const t of ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'usage_corrections', 'account_usage_rollups', 'usage_events', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'users'] as const) {
      await seed.kysely.deleteFrom(t).execute();
    }
    ownerId = await seedUser(seed, 'owner@example.com');
    viewerId = await seedUser(seed, 'viewer@example.com');
    outsiderId = await seedUser(seed, 'outsider@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
    // An active ACCOUNT viewer membership — proves account membership alone yields NO portfolio rows.
    await seed.kysely.insertInto('memberships').values({ account_id: accountId, member_user_id: viewerId, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` }).execute();
  });

  /** Create a company (owner becomes its company owner) and pin created_at exactly for deterministic order.
   *  provisioningRunner: null — portfolio semantics are under test, not provisioning; companies stay onboarding. */
  async function createCompanyAt(name: string, createdAtIso: string): Promise<string> {
    const r = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name }, { provisioningRunner: null });
    if (r.status !== 'ok') throw new Error(`create failed: ${r.status}`);
    await seed.kysely.updateTable('companies').set({ created_at: sql<Date>`${createdAtIso}::timestamptz` }).where('id', '=', r.companyId).execute();
    return r.companyId;
  }
  /** Build the raw enumeration candidate for a company (exact created_at_us) — the input to enrichment. */
  async function candidateOf(companyId: string, role: string, status = 'onboarding'): Promise<PortfolioCandidateRow> {
    const row = await sql<{ us: string }>`select (extract(epoch from created_at) * 1000000)::bigint::text as us from companies where id = ${companyId}::uuid`.execute(seed.kysely);
    return { company_id: companyId, status, role, created_at_us: row.rows[0]!.us };
  }

  test('lists only active-membership companies, newest-first, with enriched names/roles/status/createdAt', async () => {
    const early = await createCompanyAt('Alpha', '2026-01-01T00:00:00.000000Z');
    const late = await createCompanyAt('Beta', '2026-03-01T00:00:00.500000Z');

    const res = await getCompanyPortfolio(app, { userId: ownerId, accountId });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.page.items.map((i) => i.companyId)).toEqual([late, early]); // created_at DESC
    expect(res.page.items.map((i) => i.name)).toEqual(['Beta', 'Alpha']);
    expect(res.page.items.every((i) => i.role === 'owner')).toBe(true);
    expect(res.page.items.every((i) => i.status === 'onboarding')).toBe(true); // fresh companies are onboarding (P1-012)
    expect(res.page.items[0]?.createdAt).toBe('2026-03-01T00:00:00.500000Z'); // exact microsecond
    expect(res.page.items[1]?.createdAt).toBe('2026-01-01T00:00:00.000000Z');
    expect(res.page.nextCursor).toBeNull();
  });

  test('account membership alone yields NO rows; a non-account-member is forbidden', async () => {
    await createCompanyAt('Owned', '2026-01-01T00:00:00.000000Z');
    // viewer is an active ACCOUNT member but has NO company membership → ok with an empty portfolio.
    const asViewer = await getCompanyPortfolio(app, { userId: viewerId, accountId });
    expect(asViewer).toEqual({ status: 'ok', page: { items: [], nextCursor: null } });
    // outsider is not an account member at all → coarse forbidden (no enumeration).
    const asOutsider = await getCompanyPortfolio(app, { userId: outsiderId, accountId });
    expect(asOutsider.status).toBe('forbidden');
  });

  test('keyset pagination: limit + cursor walk the portfolio with no overlap or gap', async () => {
    const c1 = await createCompanyAt('One', '2026-01-01T00:00:00.000000Z');
    const c2 = await createCompanyAt('Two', '2026-02-01T00:00:00.000000Z');
    const c3 = await createCompanyAt('Three', '2026-03-01T00:00:00.000000Z');

    const p1 = await getCompanyPortfolio(app, { userId: ownerId, accountId, limit: 2 });
    expect(p1.status).toBe('ok');
    if (p1.status !== 'ok') return;
    expect(p1.page.items.map((i) => i.companyId)).toEqual([c3, c2]);
    expect(p1.page.nextCursor).not.toBeNull();

    const p2 = await getCompanyPortfolio(app, { userId: ownerId, accountId, limit: 2, cursor: p1.page.nextCursor });
    expect(p2.status).toBe('ok');
    if (p2.status !== 'ok') return;
    expect(p2.page.items.map((i) => i.companyId)).toEqual([c1]);
    expect(p2.page.nextCursor).toBeNull();
  });

  test('strict limit + cursor rejection (REJECT, not clamp; foreign cursor rejected)', async () => {
    await createCompanyAt('X', '2026-01-01T00:00:00.000000Z');
    for (const bad of [0, -1, 101, 'abc', 1.5]) {
      expect((await getCompanyPortfolio(app, { userId: ownerId, accountId, limit: bad })).status).toBe('invalid_limit');
    }
    expect((await getCompanyPortfolio(app, { userId: ownerId, accountId, cursor: 'not-a-valid-cursor!!' })).status).toBe('invalid_cursor');
    // A cursor minted for a DIFFERENT actor is not valid for this caller (account+actor binding).
    const foreign = encodePortfolioCursor(accountId, outsiderId, { createdAt: '2026-01-01T00:00:00.000000Z', companyId: '00000000-0000-0000-0000-000000000000' });
    expect((await getCompanyPortfolio(app, { userId: ownerId, accountId, cursor: foreign })).status).toBe('invalid_cursor');
  });

  test('a PAUSED company stays visible in the portfolio with its truthful status (CDR-017 required behavior)', async () => {
    const active = await createCompanyAt('Running', '2026-02-01T00:00:00.000000Z');
    const paused = await createCompanyAt('Sleeping', '2026-01-01T00:00:00.000000Z');
    await seed.kysely.updateTable('companies').set({ status: 'active' }).where('id', '=', active).execute();
    await seed.kysely.updateTable('companies').set({ status: 'paused' }).where('id', '=', paused).execute();
    const res = await getCompanyPortfolio(app, { userId: ownerId, accountId });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.page.items.map((i) => ({ id: i.companyId, status: i.status, name: i.name }))).toEqual([
      { id: active, status: 'active', name: 'Running' },
      { id: paused, status: 'paused', name: 'Sleeping' },
    ]);
  });

  test('enrichment isolation: each candidate gets ITS OWN name under a fresh CompanyScope (no context bleed)', async () => {
    const a = await createCompanyAt('Alpha', '2026-02-01T00:00:00.000000Z');
    const b = await createCompanyAt('Beta', '2026-01-01T00:00:00.000000Z');
    const items = await enrichCandidatesSequentially(app, { userId: ownerId, accountId }, [await candidateOf(a, 'owner'), await candidateOf(b, 'owner')]);
    expect(items.map((i) => ({ id: i.companyId, name: i.name }))).toEqual([
      { id: a, name: 'Alpha' },
      { id: b, name: 'Beta' },
    ]);
  });

  test('stale drop: a membership revoked BETWEEN enumeration and enrichment yields no row (never a stale row)', async () => {
    const keep = await createCompanyAt('Keep', '2026-02-01T00:00:00.000000Z');
    const revoke = await createCompanyAt('Revoke', '2026-01-01T00:00:00.000000Z');
    // Candidates captured while both memberships are active (simulating enumeration).
    const candidates = [await candidateOf(keep, 'owner'), await candidateOf(revoke, 'owner')];
    // Now the second membership is revoked before enrichment runs.
    await seed.kysely.updateTable('company_memberships').set({ status: 'revoked' }).where('company_id', '=', revoke).where('member_user_id', '=', ownerId).execute();
    const items = await enrichCandidatesSequentially(app, { userId: ownerId, accountId }, candidates);
    // The revoked company is DROPPED; the still-active one is enriched normally.
    expect(items.map((i) => i.companyId)).toEqual([keep]);
    expect(items[0]?.name).toBe('Keep');
  });
});
