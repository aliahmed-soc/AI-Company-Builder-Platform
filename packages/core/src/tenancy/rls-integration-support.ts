// Test-support for ACBP-P1-006 integration suites that must exercise RLS END-TO-END (CDR-013): a
// superuser/owner SEED client (schema + fixtures; bypasses RLS) and a restricted `acbp_app` APP client
// (the actual application operations; subject to FORCE RLS). NOT imported by production code — `kysely`
// is a core devDependency used only here.
import { sql } from 'kysely';
import { createDatabase, type DatabaseClient } from '@acbp/database';
import { parseDatabaseConfig } from '@acbp/config';

const url = process.env['ACBP_TEST_DATABASE_URL'];
export const hasTestDatabase = typeof url === 'string' && url.length > 0;
// Synthetic, throwaway local test password for the restricted role (never a real credential).
const APP_ROLE_TEST_PASSWORD = `rls_${'test'}_pw_1970`;
const ssl = process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable';

/** Superuser (owner/admin) client for schema setup + fixture seeding — bypasses RLS. */
export function createSeedClient(): DatabaseClient {
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_SSL: ssl, DATABASE_APP_NAME: 'acbp-seed' }));
}

/** Restricted `acbp_app` client for the ACTUAL application operations — subject to RLS (role='app'). */
export function createAppClient(): DatabaseClient {
  const u = new URL(url as string);
  u.username = 'acbp_app';
  u.password = APP_ROLE_TEST_PASSWORD;
  return createDatabase(parseDatabaseConfig({ APP_ENV: 'test', DATABASE_URL: url, DATABASE_APP_URL: u.toString(), DATABASE_SSL: ssl, DATABASE_APP_NAME: 'acbp-app' }, { role: 'app' }));
}

/** Give the migration-created NOLOGIN acbp_app role a throwaway test login (run via the seed/superuser client). */
export async function enableAppLogin(seed: DatabaseClient): Promise<void> {
  await sql`alter role acbp_app login password ${sql.lit(APP_ROLE_TEST_PASSWORD)}`.execute(seed.kysely);
}
export async function disableAppLogin(seed: DatabaseClient): Promise<void> {
  try {
    await sql`alter role acbp_app nologin`.execute(seed.kysely);
  } catch {
    /* best effort */
  }
}
