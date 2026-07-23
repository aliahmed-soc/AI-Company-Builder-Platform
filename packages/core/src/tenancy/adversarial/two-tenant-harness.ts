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
//     └── company B2 (paused)
//   outsider  — a real internal user with NO account and NO company membership
//   platformAdmin / revokedPlatformAdmin — platform_admins rows seeded through the OWNER client only
//     (there is no runtime write path to platform_admins — CDR-019).
//
// `bothCompanies` legitimately belongs to A1 AND A2 so cross-COMPANY cursor replay can be tested by a caller
// who is authorized for both (the interesting case: authority exists, but not for THAT cursor).
import { sql } from 'kysely';
import { createDatabase, closeDatabase, migrateToLatest, type DatabaseClient, type NewUser } from '@acbp/database';
import { parseDatabaseConfig } from '@acbp/config';
import { provisionPersonalAccount } from '../../accounts/provisioning.js';
import { createCompany } from '../../company/company-service.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
export const hasTestDatabase = typeof url === 'string' && url.length > 0;
// Synthetic, throwaway local test password for the restricted role (never a real credential).
const APP_ROLE_TEST_PASSWORD = `adversarial_${'test'}_pw_1970`;
const ssl = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';

/** Every table the harness touches — drop order is FK-safe (children first). */
export const ALL_TABLES = [
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
}

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
export async function seedTwoTenantWorld(owner: DatabaseClient, product: DatabaseClient): Promise<TwoTenantWorld> {
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

  const accountA = (await provisionPersonalAccount(product, aOwner)).accountId;
  const accountB = (await provisionPersonalAccount(product, bOwner)).accountId;

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

  const a1 = await createCompany(product, { accountId: accountA, actingUserId: aOwner, creationMode: 'own_idea', name: 'Alpha One' });
  const a2 = await createCompany(product, { accountId: accountA, actingUserId: aOwner, creationMode: 'existing_business', name: 'Alpha Two' });
  const b1 = await createCompany(product, { accountId: accountB, actingUserId: bOwner, creationMode: 'own_idea', name: 'Beta One' });
  const b2 = await createCompany(product, { accountId: accountB, actingUserId: bOwner, creationMode: 'exploring', name: 'Beta Two' });
  if (a1.status !== 'ok' || a2.status !== 'ok' || b1.status !== 'ok' || b2.status !== 'ok') {
    throw new Error('adversarial harness: company bootstrap failed');
  }

  // Company memberships beyond the creator's owner row.
  await owner.kysely
    .insertInto('company_memberships')
    .values([
      { account_id: accountA, company_id: a1.companyId, member_user_id: aViewer, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a1.companyId, member_user_id: bothCompanies, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a2.companyId, member_user_id: bothCompanies, role: 'viewer', status: 'active' },
      { account_id: accountA, company_id: a2.companyId, member_user_id: aCompanyRevoked, role: 'viewer', status: 'revoked' },
      { account_id: accountB, company_id: b1.companyId, member_user_id: bViewer, role: 'viewer', status: 'active' },
    ])
    .execute();

  // Platform admins — OWNER connection only (the documented operational path; no runtime writer exists).
  await sql`insert into platform_admins (user_id) values (${platformAdmin}::uuid)`.execute(owner.kysely);
  await sql`insert into platform_admins (user_id, status, revoked_at) values (${revokedPlatformAdmin}::uuid, 'revoked', now())`.execute(owner.kysely);

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
    companyA1: a1.companyId,
    companyA2: a2.companyId,
    companyB1: b1.companyId,
    companyB2: b2.companyId,
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
