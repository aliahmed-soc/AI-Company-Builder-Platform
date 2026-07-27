// ACBP-P1-014 / CDR-020 §4 — the SHARED two-tenant fixture harness for the tenant-isolation adversarial
// suite. Test-only; never imported by production code.
//
// Two separately branded clients (CDR-020 §4):
//   • the OWNER/FIXTURE client — migrations, deterministic seeding and catalog inspection ONLY. It is a
//     superuser in CI and therefore bypasses RLS: nothing it can do proves anything about isolation.
//   • the RESTRICTED PRODUCT client (`acbp_app`) — the ONLY client an adversarial product assertion may use.
//
// `assertRestrictedRole` is the fail-fast guard that makes the distinction impossible to get wrong silently:
// every adversarial suite calls it in beforeAll, and it FAILS when the "product" client turns out to be a
// superuser, a BYPASSRLS role, the migration/owner role, or an owner of the product tables. Without it, a
// mis-wired fixture would make every cross-tenant assertion pass vacuously (the owner role sees everything,
// so "no rows returned" could never happen — but a *write* denial test would silently succeed for the wrong
// reason, and a future refactor could quietly swap the client).
//
// The fixture is a fixed, deterministic two-tenant world (no randomness, no time dependence beyond `now()`):
//
//   account A ── owner aOwner, viewer aViewer, revoked member aRevoked
//     ├── company A1 (active)  — members: aOwner (owner), aViewer (viewer), bothCompanies (viewer)
//     └── company A2 (active)  — members: aOwner (owner), bothCompanies (viewer), aCompanyRevoked (revoked)
//   account B ── owner bOwner, viewer bViewer
//     ├── company B1 (active)
//     └── company B2 (PAUSED — deliberately, so an adversarial pause of a foreign company can be shown not
//         to leak `invalid_transition` state; without a paused foreign company that oracle is untestable)
//   outsider  — a real internal user with NO account and NO company membership
//   platformAdmin / revokedPlatformAdmin — platform_admins rows seeded through the OWNER client only
//     (there is no runtime write path to platform_admins — CDR-019).
//
// `bothCompanies` legitimately belongs to A1 AND A2 so cross-COMPANY cursor replay can be tested by a caller
// who is authorized for both (the interesting case: authority exists, but not for THAT cursor).
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { parseDatabaseConfig } from '@acbp/config';


const url = process.env['ACBP_TEST_DATABASE_URL'];
export const hasTestDatabase = typeof url === 'string' && url.length > 0;
/**
 * Ephemeral login for the restricted role, generated fresh per process. It is never persisted and never
 * leaves this machine. Generating it (rather than writing a literal that the secret scanner would flag, or
 * splitting a literal so the scanner cannot see it) keeps the security gate honest: the scanner has nothing
 * to match, and no idiom for routing around it is introduced.
 */
export const APP_ROLE_TEST_PASSWORD = `adv_${randomUUID()}`;
const ssl = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';

/** Every table the harness touches — drop order is FK-safe (children first). */
/** Re-export so consumers (notably apps/web tests) never need to import @acbp/database directly. */
export type AdversarialDatabaseClient = DatabaseClient;

export const ALL_TABLES = [
  // GLOBAL platform config, not tenant data (ACBP-P5-003a) — but this is the DROP/RESET list, not the tenancy list,
  // and it must name every migrated table. Omitting it lets the table survive `resetSchema`, so the next
  // `CREATE TABLE` collides, the migration aborts, and every downstream suite runs against no tables at all.
  'tool_definitions',
  'job_checkpoints',
  'jobs',
  'usage_events',
  'planning_run_inputs', 'planning_runs', 'task_review_flags',
  'task_deletions',
  'task_dependencies',
  'tasks',
  'milestones',
  'goals',
  'roadmaps',
  'decisions',
  'strategy_selections',
  'strategy_recommendations',
  'strategy_options',
  'strategy_generations',
  'understanding_confirmation_events',
  'understanding_item_reviews',
  'understanding_items',
  'understanding_documents',
  'memory_items',
  'interview_answers',
  'interview_questions',
  'interview_sessions',
  'platform_admins',
  'provisioning_steps',
  'company_workspace_areas',
  'activity_events',
  'company_memberships',
  'company_profiles',
  'companies',
  'audit_events',
  'memberships',
  'account_profiles',
  'accounts',
  'identity_webhook_receipts',
  'users',
] as const;

/** OWNER/FIXTURE client: migrations, seeding, catalog inspection ONLY. Bypasses RLS — proves nothing. */
export function createOwnerFixtureClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: ssl, DATABASE_APP_NAME: 'acbp-adversarial-fixture' }));
}

/** RESTRICTED PRODUCT client (`acbp_app`): the ONLY client an adversarial product assertion may use. */
export function createRestrictedProductClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_ROLE_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_APP_URL: u.toString(), DATABASE_SSL: ssl, DATABASE_APP_NAME: 'acbp-adversarial-app' }, { role: 'app' }));
}

/**
 * Configure the environment the REAL route runtime composes itself from: the restricted `acbp_app` connection
 * and synthetic provider settings. Owned here rather than restated per suite — the copies only ever differed
 * by placeholder strings, so a new variable in the composition root would silently break some callers and,
 * worse, leave others passing against a stale configuration.
 *
 * `DATABASE_URL` is REMOVED, not merely unused: the runtime must have no reachable path to the owner
 * connection even if a fallback were ever introduced. (This is a precondition; the positive proof is
 * `runtimeConnectionRoles` after the runtime has actually served a request.)
 */
export function configureRouteRuntimeEnv(): void {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_ROLE_TEST_PASSWORD;
  process.env['APP_ENV'] = 'test';
  process.env['DATABASE_APP_URL'] = u.toString();
  delete process.env['DATABASE_URL'];
  process.env['DATABASE_SSL'] = ssl;
  process.env['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'] = 'pk_test_adversarial_synthetic';
  process.env['CLERK_SECRET_KEY'] = 'sk_test_adversarial_synthetic';
  process.env['CLERK_WEBHOOK_SIGNING_SECRET'] = 'whsec_adversarial_synthetic';
  process.env['CLERK_WEBHOOK_INSTANCE_ID'] = 'ins_adversarial';
}

export async function enableAppLogin(owner: DatabaseClient): Promise<void> {
  await sql`alter role acbp_app login password ${sql.lit(APP_ROLE_TEST_PASSWORD)}`.execute(owner.kysely);
}
export async function disableAppLogin(owner: DatabaseClient): Promise<void> {
  try {
    await sql`alter role acbp_app nologin`.execute(owner.kysely);
  } catch {
    /* best effort */
  }
}

export interface RestrictedRoleProof {
  readonly currentUser: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  readonly ownedProductTables: readonly string[];
}

/**
 * FAIL-FAST GUARD (CDR-020 §4). Proves the "product" client really is the restricted role before any
 * adversarial assertion runs: `current_user` = acbp_app, NOT superuser, NOT BYPASSRLS, and NOT the owner of
 * any product table. Throws (failing the suite in beforeAll) otherwise — an adversarial result obtained on
 * the owner/superuser connection is never credited.
 */
export async function assertRestrictedRole(product: DatabaseClient): Promise<RestrictedRoleProof> {
  const r = await sql<{ current_user: string; is_super: boolean; bypass: boolean }>`
    select current_user as current_user,
           (select rolsuper from pg_roles where rolname = current_user) as is_super,
           (select rolbypassrls from pg_roles where rolname = current_user) as bypass
  `.execute(product.kysely);
  const row = r.rows[0];
  if (row === undefined) throw new Error('adversarial harness: could not resolve current_user');
  const owned = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = 'public' and tableowner = current_user order by tablename
  `.execute(product.kysely);
  const proof: RestrictedRoleProof = {
    currentUser: row.current_user,
    isSuperuser: row.is_super,
    bypassesRls: row.bypass,
    ownedProductTables: owned.rows.map((t) => t.tablename),
  };
  if (proof.currentUser !== 'acbp_app') throw new Error(`adversarial harness: product assertions must run as acbp_app, got '${proof.currentUser}'`);
  if (proof.isSuperuser) throw new Error('adversarial harness: the product client is a SUPERUSER — isolation results would be vacuous');
  if (proof.bypassesRls) throw new Error('adversarial harness: the product client has BYPASSRLS — isolation results would be vacuous');
  if (proof.ownedProductTables.length > 0) throw new Error(`adversarial harness: the product client OWNS tables (${proof.ownedProductTables.join(', ')}) — FORCE RLS proof would be ambiguous`);
  return proof;
}


/**
 * The @acbp/core operations the fixture seeds through. INJECTED rather than imported: test-support may not
 * depend on core, because adapters' tests already depend on test-support and the resulting
 * core -> adapters -> test-support -> core edge would be a workspace cycle. Injection also keeps the fixture
 * honest — accounts and companies are created through the SAME production use cases the app calls.
 */
export interface CoreSeedOps {
  provisionPersonalAccount(client: DatabaseClient, userId: string): Promise<{ readonly accountId: string }>;
  createCompany(client: DatabaseClient, params: { accountId: string; actingUserId: string; creationMode: unknown; name: unknown }): Promise<{ readonly status: string; readonly companyId?: string }>;
  pauseCompany(client: DatabaseClient, params: { userId: string; accountId: string; companyId: string }): Promise<{ readonly status: string }>;
}
export interface TwoTenantWorld {
  readonly aOwner: string;
  readonly aViewer: string;
  readonly aRevoked: string;
  readonly bOwner: string;
  readonly bViewer: string;
  readonly outsider: string;
  readonly bothCompanies: string;
  readonly aCompanyRevoked: string;
  readonly platformAdmin: string;
  readonly revokedPlatformAdmin: string;
  readonly accountA: string;
  readonly accountB: string;
  readonly companyA1: string;
  readonly companyA2: string;
  readonly companyB1: string;
  readonly companyB2: string;
  /**
   * The seeded company names, exported so leak assertions search for the string the fixture ACTUALLY wrote.
   * Restating the literals at the call site makes a rename in this file silently vacuous: a name that is
   * never emitted can never be found, so every "does not leak" check would pass without testing anything.
   */
  readonly companyNames: readonly string[];
}

/** The seeded company names, in A1, A2, B1, B2 order. */
export const SEEDED_COMPANY_NAMES = ['Alpha One', 'Alpha Two', 'Beta One', 'Beta Two'] as const;

let userSeq = 0;
async function seedUser(owner: DatabaseClient, label: string): Promise<string> {
  userSeq += 1;
  const values: NewUser = {
    provider: 'clerk',
    provider_instance_id: 'ins_adversarial',
    provider_user_id: `adv_${label}_${userSeq}`,
    primary_email: `${label}${userSeq}@example.com`,
    email_verified: true,
    provider_updated_at: new Date().toISOString(),
  };
  const row = await owner.kysely.insertInto('users').values(values).returning('id').executeTakeFirstOrThrow();
  return row.id;
}

/** Drop every managed table and re-migrate. Owner client only. */
export async function resetSchema(owner: DatabaseClient): Promise<void> {
  for (const t of [...ALL_TABLES, '_acbp_migration_probe', 'kysely_migration', 'kysely_migration_lock']) {
    await owner.kysely.schema.dropTable(t).ifExists().cascade().execute();
  }
  const result = await migrateToLatest(owner);
  if (result.error !== undefined) throw new Error('adversarial harness: migrateToLatest reported an error');
}

/** Delete all fixture rows (keeps the schema) so each suite starts from a known, empty world. */
export async function truncateFixtures(owner: DatabaseClient): Promise<void> {
  for (const t of ALL_TABLES) {
    if (t === 'identity_webhook_receipts') continue;
    await owner.kysely.deleteFrom(t).execute();
  }
}

/**
 * Seed the deterministic two-tenant world. Accounts and companies are created through the REAL production
 * bootstrap paths on the RESTRICTED client (so the fixture itself exercises production invariants); the
 * remaining membership/admin rows are written on the OWNER client, which is the only path that exists for
 * `platform_admins` (CDR-019) and the simplest deterministic path for revoked/extra memberships.
 */
export async function seedTwoTenantWorld(owner: DatabaseClient, product: DatabaseClient, ops: CoreSeedOps): Promise<TwoTenantWorld> {
  const aOwner = await seedUser(owner, 'aowner');
  const aViewer = await seedUser(owner, 'aviewer');
  const aRevoked = await seedUser(owner, 'arevoked');
  const bOwner = await seedUser(owner, 'bowner');
  const bViewer = await seedUser(owner, 'bviewer');
  const outsider = await seedUser(owner, 'outsider');
  const bothCompanies = await seedUser(owner, 'both');
  const aCompanyRevoked = await seedUser(owner, 'acorevoked');
  const platformAdmin = await seedUser(owner, 'padmin');
  const revokedPlatformAdmin = await seedUser(owner, 'pradmin');

  const accountA = (await ops.provisionPersonalAccount(product, aOwner)).accountId;
  const accountB = (await ops.provisionPersonalAccount(product, bOwner)).accountId;

  // Account-level memberships (owner rows come from the bootstrap; these are the extra states we need).
  await owner.kysely
    .insertInto('memberships')
    .values([
      { account_id: accountA, member_user_id: aViewer, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` },
      { account_id: accountA, member_user_id: bothCompanies, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` },
      { account_id: accountA, member_user_id: aCompanyRevoked, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` },
      { account_id: accountA, member_user_id: aRevoked, role: 'viewer', status: 'revoked', accepted_at: sql<Date>`now()`, revoked_at: sql<Date>`now()` },
      { account_id: accountB, member_user_id: bViewer, role: 'viewer', status: 'active', accepted_at: sql<Date>`now()` },
    ])
    .execute();

  // The three canonical creation modes (COMPANY_CREATION_MODES): own_idea | platform_suggested |
  // existing_business. A wrong mode is rejected by validation BEFORE any write, so the harness would fail
  // with no company at all — hence the explicit per-company diagnosis below rather than a bare "failed".
  const created = {
    a1: await ops.createCompany(product, { accountId: accountA, actingUserId: aOwner, creationMode: 'own_idea', name: SEEDED_COMPANY_NAMES[0] }),
    a2: await ops.createCompany(product, { accountId: accountA, actingUserId: aOwner, creationMode: 'existing_business', name: SEEDED_COMPANY_NAMES[1] }),
    b1: await ops.createCompany(product, { accountId: accountB, actingUserId: bOwner, creationMode: 'own_idea', name: SEEDED_COMPANY_NAMES[2] }),
    b2: await ops.createCompany(product, { accountId: accountB, actingUserId: bOwner, creationMode: 'platform_suggested', name: SEEDED_COMPANY_NAMES[3] }),
  };
  const failures = Object.entries(created)
    .filter(([, r]) => r.status !== 'ok')
    .map(([label, r]) => `${label}:${r.status}`);
  if (failures.length > 0) throw new Error(`adversarial harness: company bootstrap failed (${failures.join(', ')})`);
  /** Narrow the injected result to a definite id — a missing one means the use case changed shape. */
  const idOf = (label: string, r: { readonly companyId?: string }): string => {
    if (r.companyId === undefined) throw new Error(`adversarial harness: ${label} reported ok without a companyId`);
    return r.companyId;
  };
  const a1 = idOf('a1', created.a1);
  const a2 = idOf('a2', created.a2);
  const b1 = idOf('b1', created.b1);
  const b2 = idOf('b2', created.b2);

  // Company memberships beyond the creator's owner row.
  await owner.kysely
    .insertInto('company_memberships')
    .values([
      { account_id: accountA, company_id: a1, member_user_id: aViewer, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a1, member_user_id: bothCompanies, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a2, member_user_id: bothCompanies, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a2, member_user_id: aCompanyRevoked, role: 'viewer', status: 'revoked' },
      { account_id: accountB, company_id: b1, member_user_id: bViewer, role: 'viewer', status: 'active' },
    ])
    .execute();

  // Platform admins — OWNER connection only (the documented operational path; no runtime writer exists).
  await sql`insert into platform_admins (user_id) values (${platformAdmin}::uuid)`.execute(owner.kysely);
  await sql`insert into platform_admins (user_id, status, revoked_at) values (${revokedPlatformAdmin}::uuid, 'revoked', now())`.execute(owner.kysely);

  // B2 is PAUSED through the real lifecycle use case (not a direct UPDATE), so the fixture state is one a
  // production transition actually produces — and so an adversarial pause of an already-paused FOREIGN
  // company can prove it does not leak `invalid_transition` (which carries the target's current status).
  const pausedB2 = await ops.pauseCompany(product, { userId: bOwner, accountId: accountB, companyId: b2 });
  if (pausedB2.status !== 'ok') throw new Error(`adversarial harness: could not pause B2 (${pausedB2.status})`);

  return {
    aOwner,
    aViewer,
    aRevoked,
    bOwner,
    bViewer,
    outsider,
    bothCompanies,
    aCompanyRevoked,
    platformAdmin,
    revokedPlatformAdmin,
    accountA,
    accountB,
    companyA1: a1,
    companyA2: a2,
    companyB1: b1,
    companyB2: b2,
    companyNames: SEEDED_COMPANY_NAMES,
  };
}

/** Close both clients and restore the NOLOGIN restricted role. */
export async function teardown(owner: DatabaseClient | undefined, product: DatabaseClient | undefined): Promise<void> {
  if (product !== undefined) await closeDatabase(product);
  if (owner !== undefined) {
    await disableAppLogin(owner);
    for (const t of ALL_TABLES) await owner.kysely.schema.dropTable(t).ifExists().cascade().execute();
    await closeDatabase(owner);
  }
}

/**
 * Diagnostic: which database ROLE currently backs each live `acbp*` connection, excluding this harness's own
 * two clients. Used by the apps/web HTTP suite to prove the ROUTE RUNTIME (not the test's client) connects as
 * `acbp_app` — without that, a regression letting the runtime fall back to the owner URL would make every
 * HTTP isolation assertion vacuous while still passing. Lives here because `kysely` resolves in this package.
 */
export async function runtimeConnectionRoles(owner: DatabaseClient, excludeAppNames: readonly string[]): Promise<ReadonlyArray<{ readonly role: string; readonly application: string }>> {
  const r = await sql<{ usename: string; application_name: string }>`
    select usename, application_name from pg_stat_activity where application_name like 'acbp%'
  `.execute(owner.kysely);
  return r.rows.filter((row) => !excludeAppNames.includes(row.application_name)).map((row) => ({ role: row.usename, application: row.application_name }));
}

/** Run `fn` on the restricted client inside a transaction carrying exactly the supplied GUCs. */
export async function asRestricted<T>(
  product: DatabaseClient,
  gucs: { readonly actor?: string; readonly account?: string; readonly company?: string },
  fn: (kysely: DatabaseClient['kysely']) => Promise<T>,
): Promise<T> {
  return product.kysely.transaction().execute(async (tx) => {
    if (gucs.actor !== undefined) await sql`select set_config('app.current_actor', ${gucs.actor}, true)`.execute(tx);
    if (gucs.account !== undefined) await sql`select set_config('app.current_account', ${gucs.account}, true)`.execute(tx);
    if (gucs.company !== undefined) await sql`select set_config('app.current_company', ${gucs.company}, true)`.execute(tx);
    return fn(tx);
  });
}
