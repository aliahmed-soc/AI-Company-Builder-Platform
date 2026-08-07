// ACBP-P6-007 / CDR-072 — real-PostgreSQL proof of `emergency_stops` + `held_work` under the RESTRICTED role.
//
// THIS SUITE EXISTS BECAUSE IT DID NOT. Migration 0050 shipped with its CHECKs, its partial unique index and its
// dual-scope RLS predicates entirely unproven against a database — every other table in this repo has a suite like
// this one, and the P1-014 catalog covers only grants and "RLS is enabled", never the constraint BEHAVIOUR. For a
// table whose whole purpose is to make a dishonest stop record impossible to store, "the constraint is written in
// the migration" is not the same claim as "the constraint rejects the row".
//
// Setup/seed on the superuser (owner); every assertion runs as `acbp_app` (NOSUPERUSER, NOBYPASSRLS, non-owner).
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { parseDatabaseConfig } from '@acbp/config';
import { STOP_SCOPES } from '@acbp/contracts';
import { createDatabase, closeDatabase, migrateToLatest, createMigrator, withTransaction, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
const hasTestDatabase = typeof url === 'string' && url.length > 0;
const APP_TEST_PASSWORD = `stop_${'test'}_pw_1970`;

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const INSUFFICIENT_PRIVILEGE = '42501';
const FK_VIOLATION = '23503';

const ALL = ['approval_decisions', 'emergency_stops', 'held_work', 'approval_requests', 'planning_run_inputs', 'planning_runs', 'task_review_flags', 'policy_evaluations', 'policies', 'artifact_revisions', 'artifacts', 'credit_transactions', 'worker_runs', 'company_worker_states', 'worker_definitions', 'tool_definitions', 'job_checkpoints', 'jobs', 'tool_calls', 'task_runs', 'task_deletions', 'task_dependencies', 'tasks', 'milestones', 'goals', 'roadmaps', 'decisions', 'strategy_selections', 'strategy_recommendations', 'strategy_options', 'strategy_generations', 'usage_corrections', 'api_rate_limit_buckets', 'account_usage_rollups', 'usage_events', 'understanding_confirmation_events', 'understanding_item_reviews', 'understanding_items', 'understanding_documents', 'memory_items', 'interview_answers', 'interview_questions', 'interview_sessions', 'platform_admins', 'provisioning_steps', 'company_workspace_areas', 'activity_events', 'company_memberships', 'company_profiles', 'companies', 'audit_events', 'memberships', 'account_profiles', 'accounts', 'identity_webhook_receipts', 'users'] as const;

/**
 * The SQLSTATE of a rejected operation, or 'no-error' if it unexpectedly succeeded.
 *
 * The SQLSTATE rather than a constraint name, because `toDatabaseError` sanitizes every database error down to a
 * category and a code — no constraint name ever reaches a caller, and that sanitization is a security property this
 * suite must not ask anyone to relax. Pinning the EXACT code is what stops one failure mode masquerading as
 * another; a bare `.rejects.toThrow()` is satisfied by all of them, including a typo in the test's own SQL.
 */
const isSqlState = (v: unknown): v is string => typeof v === 'string' && /^[0-9A-Z]{5}$/.test(v);
const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
  p.then(() => 'no-error').catch((e: unknown) => {
    for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
      const node = cur as { code?: unknown; cause?: unknown };
      if (isSqlState(node.code)) return node.code;
      cur = node.cause;
    }
    return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
  });

function superuserClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-stop-int' }));
}
function appRoleClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: u.toString(), DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable', DATABASE_APP_NAME: 'acbp-app-stop-test' }));
}

describe.skipIf(!hasTestDatabase)('emergency_stops + held_work (real PostgreSQL, restricted role) — ACBP-P6-007/CDR-072', () => {
  let su: DatabaseClient;
  let app: DatabaseClient;
  let userU = '';
  let accountA = '';
  let accountB = '';
  let companyA1 = '';
  let companyA2 = '';
  let companyB1 = '';

  async function asApp<T>(gucs: Record<string, string>, fn: (trx: DatabaseClient['kysely']) => Promise<T>): Promise<T> {
    return withTransaction(app, async (tx) => {
      for (const [k, v] of Object.entries(gucs)) await sql`select set_config(${k}, ${v}, true)`.execute(tx.kysely);
      return fn(tx.kysely);
    });
  }
  const scope = (a: string, c: string) => ({ 'app.current_account': a, 'app.current_company': c });
  /** Account context ONLY — the shape an account-wide read takes when no company is current. */
  const acct = (a: string) => ({ 'app.current_account': a });

  /** Insert a stop as the APP role, so RLS and every CHECK are exercised on the path the product actually uses. */
  const insertStop = (
    a: string,
    c: string,
    row: { companyId: string | null; scope: string; targetId: string | null; status?: string },
  ): Promise<string> =>
    asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`
        insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id, status)
        values (${a}::uuid, ${row.companyId}::uuid, ${row.scope}, ${row.targetId}, ${userU}::uuid, ${row.status ?? 'active'})
        returning id
      `.execute(k);
      return r.rows[0]!.id;
    });

  async function insertTask(a: string, c: string): Promise<string> {
    return asApp(scope(a, c), async (k) => {
      const r = await sql<{ id: string }>`
        insert into tasks (account_id, company_id, state, title, created_by_user_id)
        values (${a}::uuid, ${c}::uuid, 'running', 'in flight', ${userU}::uuid) returning id
      `.execute(k);
      return r.rows[0]!.id;
    });
  }

  beforeAll(async () => {
    su = superuserClient();
    for (const t of [...ALL, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
      await su.kysely.schema.dropTable(t).ifExists().cascade().execute();
    }
    const r = await migrateToLatest(su);
    expect(r.error).toBeUndefined();
    await sql`alter role acbp_app login password ${sql.lit(APP_TEST_PASSWORD)}`.execute(su.kysely);
    app = appRoleClient();

    const u = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_stop', 'user_stop_u', now()) returning id`.execute(su.kysely);
    userU = u.rows[0]!.id;
    const v = await sql<{ id: string }>`insert into users (provider, provider_instance_id, provider_user_id, provider_updated_at) values ('clerk', 'inst_stop', 'user_stop_v', now()) returning id`.execute(su.kysely);
    const userV = v.rows[0]!.id;
    accountA = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userU}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    accountB = (await sql<{ id: string }>`insert into accounts (created_by_user_id) values (${userV}::uuid) returning id`.execute(su.kysely)).rows[0]!.id;
    companyA1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyA2 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountA}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;
    companyB1 = (await sql<{ id: string }>`insert into companies (account_id, creation_mode) values (${accountB}::uuid, 'own_idea') returning id`.execute(su.kysely)).rows[0]!.id;

    // Clean down/up BY NAME, so 0050 is proven to be reversible and re-appliable rather than only ever applied once.
    const down = await createMigrator(su).migrateTo('0049_policy_autonomy_level');
    expect(down.error).toBeUndefined();
    const up = await migrateToLatest(su);
    expect(up.error).toBeUndefined();
  }, 120_000);

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
    await sql`delete from held_work`.execute(su.kysely);
    await sql`delete from emergency_stops`.execute(su.kysely);
    await sql`delete from tasks`.execute(su.kysely);
  });

  // ── the constraints that make a dishonest stop UNSTORABLE (CDR-072 §0) ────────────────────────────────────

  test('A COMPANY STOP MUST NAME ITS OWN COMPANY — the review-pass-2 hole, closed at the schema', async () => {
    // THE FAILURE: the covering rule matches a `company` stop by comparing `target_id` to the CALL's company, while
    // RLS shows the row to the company in `company_id`. With nothing tying them together, a stop raised in A1
    // naming A2 was storable, ACTIVE and visible to A1 — and covered NOTHING. The operator is told the company is
    // halted while every call goes through. §0 with a different mask on.
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: 'company', targetId: companyA2 }))).toBe(CHECK_VIOLATION);
    // ...and the honest one is accepted, so the constraint is not simply refusing everything.
    await expect(insertStop(accountA, companyA1, { companyId: companyA1, scope: 'company', targetId: companyA1 })).resolves.toEqual(expect.any(String));
  });

  test('an identity scope without a target is unstorable, and a non-identity scope WITH one is too', async () => {
    for (const s of ['task', 'worker', 'capability', 'integration', 'company']) {
      expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: s, targetId: null }))).toBe(CHECK_VIOLATION);
    }
    // Blank is not a target either — otherwise `''` would satisfy "has a target" and match nothing.
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: 'task', targetId: '   ' }))).toBe(CHECK_VIOLATION);
    for (const s of ['external_actions_only']) {
      expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: s, targetId: 'anything' }))).toBe(CHECK_VIOLATION);
    }
  });

  test('account_wide REQUIRES a null company, and every other scope REQUIRES one', async () => {
    // An account-wide stop pinned to a company would not cover its siblings; a company-scoped stop without a company
    // would be invisible to the company predicate. Either way a scope silently misses.
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: 'account_wide', targetId: null }))).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: null, scope: 'external_actions_only', targetId: null }))).toBe(CHECK_VIOLATION);
    await expect(insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null })).resolves.toEqual(expect.any(String));
  });

  test('an unknown scope cannot be stored — the vocabulary is closed at the database, not only in TypeScript', async () => {
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: companyA1, scope: 'everything', targetId: null }))).toBe(CHECK_VIOLATION);
  });

  test("THE MIGRATION'S SCOPE LIST EQUALS THE CONTRACT'S — set equality, read back from the live CHECK", async () => {
    // Migration 0050 and `@acbp/contracts` each carry the vocabulary, and 0050's comment claimed they were
    // "asserted equal by a test". THEY WERE NOT — the independent review found no such assertion anywhere, and one
    // hard-coded unknown value (the case above) is not set equality. This is that assertion, and it reads the
    // constraint PostgreSQL actually enforces rather than the migration's source text.
    //
    // The failure it prevents: a scope added to contracts without the migration passes `activateStop`'s
    // enforceability check and then dies on a 23514 AFTER authorization — a throw where the design promises a typed
    // refusal. The ACTIVITY_TYPES divergence (contracts widened without a migration) is the precedent 0050 cites.
    const def = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'emergency_stops_scope_valid'
    `.execute(su.kysely);
    const definition = def.rows[0]?.definition;
    expect(definition, 'emergency_stops_scope_valid must exist for this assertion to mean anything').toBeDefined();
    const inCheck = [...String(definition).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...STOP_SCOPES].sort());
  });

  test('status and the clearing columns cannot disagree', async () => {
    // An `active` row recording who cleared it, or a `cleared` row that does not, is a record nobody can read
    // honestly afterwards — "was the platform halted at 14:05?" stops having an answer.
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) =>
          sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id, status, cleared_at, cleared_by_user_id)
              values (${accountA}::uuid, null, 'account_wide', null, ${userU}::uuid, 'active', now(), ${userU}::uuid)`.execute(k),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) =>
          sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id, status)
              values (${accountA}::uuid, null, 'account_wide', null, ${userU}::uuid, 'cleared')`.execute(k),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  test('AT MOST ONE ACTIVE STOP OF A SHAPE — and clearing the first frees the shape again', async () => {
    // Without this, two identical account-wide stops are both storable and "clear the stop" clears ONE — leaving
    // the platform halted by a record the operator believed they had just removed.
    const first = await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    expect(await sqlStateOf(insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null }))).toBe(UNIQUE_VIOLATION);
    // `NULLS NOT DISTINCT` is what makes that true: without it two NULL targets would count as distinct rows.
    await sql`update emergency_stops set status = 'cleared', cleared_at = now(), cleared_by_user_id = ${userU}::uuid where id = ${first}::uuid`.execute(su.kysely);
    await expect(insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null })).resolves.toEqual(expect.any(String));
  });

  // ── the dual-scope RLS predicate: this is what makes `account_wide` actually account-wide ──────────────────

  test('DUAL SCOPE: an account-wide stop is visible from EVERY company in the account', async () => {
    await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(1);
    // The sibling company sees it too — if it did not, an account-wide halt would miss every company but one.
    expect(await asApp(scope(accountA, companyA2), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(1);
    // And under account context alone, which is the shape a company-less read takes.
    expect(await asApp(acct(accountA), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(1);
  });

  test("a company-scoped stop is NOT visible to a SIBLING company — the over-halt direction", async () => {
    await insertStop(accountA, companyA1, { companyId: companyA1, scope: 'company', targetId: companyA1 });
    expect(await asApp(scope(accountA, companyA1), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(1);
    expect(await asApp(scope(accountA, companyA2), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(0);
  });

  test('NOTHING crosses an account boundary, account-wide rows included', async () => {
    await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    expect(await asApp(scope(accountB, companyB1), (k) => k.selectFrom('emergency_stops').selectAll().execute())).toHaveLength(0);
    // ...and the write direction: a row cannot be planted into another account.
    expect(
      await sqlStateOf(
        asApp(scope(accountB, companyB1), (k) =>
          sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${accountA}::uuid, null, 'account_wide', null, ${userU}::uuid)`.execute(k),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // ── the grants: what is halted must not be editable, and nothing may be erased ─────────────────────────────

  test('SCOPE AND TARGET ARE IMMUTABLE — the record of WHAT was halted cannot be re-pointed', async () => {
    const id = await insertStop(accountA, companyA1, { companyId: companyA1, scope: 'task', targetId: 'task-1' });
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update emergency_stops set scope = 'worker' where id = ${id}::uuid`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update emergency_stops set target_id = 'task-2' where id = ${id}::uuid`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    // The activation columns too: who halted the platform and when are not editable by the role being restrained.
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`update emergency_stops set activated_at = now() where id = ${id}::uuid`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    // The one legal mutation IS permitted, so the test above is about the withheld columns and not a dead grant.
    await expect(
      asApp(scope(accountA, companyA1), (k) =>
        sql`update emergency_stops set status = 'cleared', cleared_at = now(), cleared_by_user_id = ${userU}::uuid where id = ${id}::uuid`.execute(k),
      ),
    ).resolves.toBeDefined();
  });

  test('NEITHER TABLE MAY BE DELETED FROM — a halt that happened is history', async () => {
    const stopId = await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    const taskId = await insertTask(accountA, companyA1);
    await asApp(scope(accountA, companyA1), (k) =>
      sql`insert into held_work (account_id, company_id, stop_id, task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${stopId}::uuid, ${taskId}::uuid)`.execute(k),
    );
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`delete from emergency_stops where id = ${stopId}::uuid`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(asApp(scope(accountA, companyA1), (k) => sql`delete from held_work`.execute(k)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // ── held_work: what a stop caught cannot be re-attributed, and a review needs an actor ─────────────────────

  test('held work is TENANT-PINNED to its stop — a foreign account\'s halt cannot be cited', async () => {
    // RI checks ALWAYS bypass RLS, so a single-column FK would let one account's held item claim it was held by a
    // halt that was never in force for it. The composite FK is what stops that.
    const foreignStop = await insertStop(accountB, companyB1, { companyId: null, scope: 'account_wide', targetId: null });
    const taskId = await insertTask(accountA, companyA1);
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) =>
          sql`insert into held_work (account_id, company_id, stop_id, task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${foreignStop}::uuid, ${taskId}::uuid)`.execute(k),
        ),
      ),
    ).toBe(FK_VIOLATION);
  });

  test('a REVIEWED item records who decided and when; a held one records neither', async () => {
    const stopId = await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    const taskId = await insertTask(accountA, companyA1);
    // "Reviewed" without an actor would make ADMIN-002's review-to-resume claimable without anyone deciding.
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) =>
          sql`insert into held_work (account_id, company_id, stop_id, task_id, status) values (${accountA}::uuid, ${companyA1}::uuid, ${stopId}::uuid, ${taskId}::uuid, 'confirmed')`.execute(k),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
    // ...and the mirror: a still-`held` item cannot claim a reviewer either.
    expect(
      await sqlStateOf(
        asApp(scope(accountA, companyA1), (k) =>
          sql`insert into held_work (account_id, company_id, stop_id, task_id, status, reviewed_at, reviewed_by_user_id) values (${accountA}::uuid, ${companyA1}::uuid, ${stopId}::uuid, ${taskId}::uuid, 'held', now(), ${userU}::uuid)`.execute(k),
        ),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  test('one hold per task per stop — a review queue nobody can finish is a review queue nobody does', async () => {
    const stopId = await insertStop(accountA, companyA1, { companyId: null, scope: 'account_wide', targetId: null });
    const taskId = await insertTask(accountA, companyA1);
    const insert = () =>
      asApp(scope(accountA, companyA1), (k) =>
        sql`insert into held_work (account_id, company_id, stop_id, task_id) values (${accountA}::uuid, ${companyA1}::uuid, ${stopId}::uuid, ${taskId}::uuid)`.execute(k),
      );
    await insert();
    expect(await sqlStateOf(insert())).toBe(UNIQUE_VIOLATION);
  });
});
