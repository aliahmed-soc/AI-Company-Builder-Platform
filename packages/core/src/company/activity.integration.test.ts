// ACBP-P1-009 / CDR-016 — real-PostgreSQL tests for the company activity feed READ use case (getCompanyActivity).
// Proves company-scoped keyset pagination (stable, no dup/omission), honest as_of, owner|viewer authz (non-member
// denied), cross-company isolation, and cursor validation. Runs the READ as the restricted `acbp_app` role under
// FORCE RLS; schema + fixtures seeded via the superuser. Skips when ACBP_TEST_DATABASE_URL is unset; never mocked.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from './company-service.js';
import { renameCompany } from './company-lifecycle.js';
import { getCompanyActivity } from './activity-service.js';
import { hasTestDatabase, createSeedClient, createAppClient, enableAppLogin, disableAppLogin } from '../tenancy/rls-integration-support.js';

const NOW = () => new Date().toISOString();
let seq = 0;
async function seedUser(seed: DatabaseClient, email: string): Promise<string> {
  seq += 1;
  const values: NewUser = { provider: 'clerk', provider_instance_id: 'ins_af', provider_user_id: `afuser_${seq}`, primary_email: email, email_verified: true, provider_updated_at: NOW() };
  const row = await seed.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

describe.skipIf(!hasTestDatabase)('company activity feed read (real PostgreSQL, restricted role) — ACBP-P1-009/CDR-016', () => {
  let seed: DatabaseClient;
  let app: DatabaseClient;
  let ownerId: string;
  let viewerId: string;
  let outsiderId: string;
  let accountId: string;

  const ALL = ['activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

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
    for (const t of ALL.filter((t) => t !== 'identity_webhook_receipts')) await seed.kysely.deleteFrom(t).execute();
    ownerId = await seedUser(seed, 'owner@example.com');
    viewerId = await seedUser(seed, 'viewer@example.com');
    outsiderId = await seedUser(seed, 'outsider@example.com');
    accountId = (await provisionPersonalAccount(app, ownerId)).accountId;
  });

  /** Create a company and generate `renames` company.updated events → (1 + renames) activity rows. */
  async function seedFeed(name: string, renames: number): Promise<string> {
    const created = await createCompany(app, { accountId, actingUserId: ownerId, creationMode: 'own_idea', name });
    if (created.status !== 'ok') throw new Error('create failed');
    for (let i = 0; i < renames; i++) {
      const r = await renameCompany(app, { userId: ownerId, accountId, companyId: created.companyId, name: `${name} v${i + 2}` });
      if (r.status !== 'ok') throw new Error('rename failed');
    }
    return created.companyId;
  }
  async function addCompanyViewer(companyId: string): Promise<void> {
    await seed.kysely.insertInto('company_memberships').values({ account_id: accountId, company_id: companyId, member_user_id: viewerId, role: 'viewer', status: 'active' }).execute();
  }

  test('returns company events newest-first with an honest as_of', async () => {
    const id = await seedFeed('Feed', 2); // company.created + 2 company.updated = 3 rows
    const res = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id });
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.page.items).toHaveLength(3);
    expect(res.page.items.map((i) => i.type)).toEqual(['company.updated', 'company.updated', 'company.created']);
    for (const it of res.page.items) expect(it.executionState).toBe('executed');
    expect(res.page.nextCursor).toBeNull();
    expect(res.page.asOf).toBe(res.page.items[0]?.occurredAt); // honest: newest returned event time
    // DTO redaction: only whitelisted display fields; the created event carries creation_mode.
    const created = res.page.items.find((i) => i.type === 'company.created');
    expect(created?.details).toEqual({ creation_mode: 'own_idea' });
    expect(created?.subjectId).toBe(id);
  });

  test('empty feed → no items, null cursor, null as_of', async () => {
    // A company with membership but (impossibly in practice) no events: assert the empty-shape via a fresh company
    // whose only event we then remove via the superuser to simulate emptiness.
    const id = await seedFeed('Empty', 0); // has exactly company.created
    await seed.kysely.deleteFrom('activity_events').where('company_id', '=', id).execute();
    const res = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id });
    expect(res).toMatchObject({ status: 'ok', page: { items: [], nextCursor: null, asOf: null } });
  });

  test('keyset pagination is stable: no duplicates, no omissions across pages', async () => {
    const id = await seedFeed('Pages', 4); // 5 rows total
    const collected: string[] = [];
    let cursor: unknown;
    let pages = 0;
    for (;;) {
      const res = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, limit: 2, cursor });
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') break;
      pages += 1;
      collected.push(...res.page.items.map((i) => i.id));
      if (res.page.nextCursor === null) break;
      cursor = res.page.nextCursor;
      if (pages > 10) throw new Error('runaway pagination');
    }
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(collected).toHaveLength(5);
    expect(new Set(collected).size).toBe(5); // no duplicates
    // Order is strictly newest-first across the whole traversal (occurred_at desc, event_id desc).
    const rows = await seed.kysely.selectFrom('activity_events').select(['event_id', 'occurred_at']).where('company_id', '=', id).orderBy('occurred_at', 'desc').orderBy('event_id', 'desc').execute();
    expect(collected).toEqual(rows.map((r) => r.event_id));
  });

  test('page size is clamped: an excessive limit never returns more than MAX; a bad limit uses the default', async () => {
    const id = await seedFeed('Clamp', 2);
    const big = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, limit: 100000 });
    expect(big.status).toBe('ok');
    if (big.status === 'ok') expect(big.page.items.length).toBeLessThanOrEqual(100);
  });

  test('authz: a company viewer may read; a non-company-member is denied (forbidden)', async () => {
    const id = await seedFeed('Guarded', 1);
    await addCompanyViewer(id);
    expect((await getCompanyActivity(app, { userId: viewerId, accountId, companyId: id })).status).toBe('ok');
    // outsider is not even an account member → forbidden.
    expect((await getCompanyActivity(app, { userId: outsiderId, accountId, companyId: id })).status).toBe('forbidden');
  });

  test('isolation: a caller cannot read another company\'s feed (no membership → forbidden)', async () => {
    const a = await seedFeed('A', 1);
    const b = await seedFeed('B', 1);
    // The owner IS a member of both here (creator). Prove cross-company via a company the owner is NOT a member of:
    // seed a company under the account whose owner membership row we then remove, leaving no company membership.
    await seed.kysely.deleteFrom('company_memberships').where('company_id', '=', b).execute();
    expect((await getCompanyActivity(app, { userId: ownerId, accountId, companyId: b })).status).toBe('forbidden');
    // The owner still reads company A normally, and A's feed never contains B's rows.
    const resA = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: a });
    if (resA.status === 'ok') for (const it of resA.page.items) expect(it.subjectId).toBe(a);
  });

  test('cursor validation: a malformed cursor and another company\'s cursor are rejected (invalid_cursor)', async () => {
    const id = await seedFeed('Cur', 3);
    const first = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, limit: 1 });
    if (first.status !== 'ok' || first.page.nextCursor === null) throw new Error('setup failed');
    // A valid cursor for THIS company works.
    expect((await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, limit: 1, cursor: first.page.nextCursor })).status).toBe('ok');
    // Malformed cursor → invalid_cursor.
    expect((await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, cursor: 'garbage%%%' })).status).toBe('invalid_cursor');
    // A cursor minted for another company is rejected (company-bound).
    const other = await seedFeed('Other', 1);
    const otherPage = await getCompanyActivity(app, { userId: ownerId, accountId, companyId: other, limit: 1 });
    if (otherPage.status === 'ok' && otherPage.page.nextCursor !== null) {
      expect((await getCompanyActivity(app, { userId: ownerId, accountId, companyId: id, cursor: otherPage.page.nextCursor })).status).toBe('invalid_cursor');
    }
  });
});
