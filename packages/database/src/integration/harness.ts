// ACBP-P0-018 — real-PostgreSQL integration harness.
//
// Canonical approach (TEST-AND-VERIFICATION-STRATEGY.md): "CI ephemeral Postgres … no mocks — real
// Postgres". The ephemeral database is provided by the environment and its URL exported as
// ACBP_TEST_DATABASE_URL (a GitHub Actions `services: postgres` container in CI; `docker run
// postgres` or a disposable managed database locally). When it is absent, the integration suite
// SKIPS — it is never silently replaced by SQLite/in-memory/mocks.
import { parseDatabaseConfig } from '@acbp/config';
import { createDatabase, type DatabaseClient } from '../index.js';

const url = process.env['ACBP_TEST_DATABASE_URL'];
export const hasTestDatabase = typeof url === 'string' && url.length > 0;

export function createTestDatabase(): DatabaseClient {
  if (!hasTestDatabase) throw new Error('ACBP_TEST_DATABASE_URL is not set');
  return createDatabase(
    parseDatabaseConfig({
      APP_ENV: 'test',
      DATABASE_URL: url,
      DATABASE_SSL: process.env['ACBP_TEST_DATABASE_SSL'] ?? 'disable',
      DATABASE_APP_NAME: 'acbp-integration',
    }),
  );
}
