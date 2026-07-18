// ACBP-P0-018 — connection-lifecycle unit tests. No live database required: the "unavailable"
// path connects to a refused local port (deterministic ECONNREFUSED). Fake creds only.
import { describe, test, expect } from 'vitest';
import { parseDatabaseConfig, loadTestDatabaseConfig, type DatabaseConfig } from '@acbp/config';
import { createTestLogger, createRootContext, newCorrelationId } from '@acbp/observability';
import { ErrorCodes, isPlatformError } from '@acbp/contracts';
import { createDatabase, closeDatabase, checkDatabaseHealth } from './index.js';

const PW = 'pw-zz01';

describe('createDatabase', () => {
  test('valid configuration creates a client and closes cleanly (no connection performed)', async () => {
    const client = createDatabase(loadTestDatabaseConfig({}));
    expect(client.inTransaction).toBe(false);
    expect(client.config.appEnv).toBe('test');
    expect(client.kysely).toBeDefined();
    await closeDatabase(client); // pool.end() resolves even though nothing ever connected
  });

  test('invalid configuration fails fast (before any connection attempt)', () => {
    expect(() => createDatabase({} as unknown as DatabaseConfig)).toThrow();
    try {
      createDatabase(null as unknown as DatabaseConfig);
    } catch (e) {
      expect(isPlatformError(e)).toBe(true);
    }
  });
});

describe('checkDatabaseHealth (unavailable database)', () => {
  test('returns a structured, credential-free failure and logs with a correlation id', async () => {
    const cfg = parseDatabaseConfig({
      APP_ENV: 'test',
      DATABASE_URL: `postgresql://acbp:${PW}@127.0.0.1:59999/none`,
      DATABASE_SSL: 'disable',
      DATABASE_CONNECTION_TIMEOUT: '1500',
    });
    const cid = newCorrelationId();
    const tl = createTestLogger({ component: 'database', context: createRootContext({ correlationId: cid }) });
    const client = createDatabase(cfg, { logger: tl.logger });
    try {
      const health = await checkDatabaseHealth(client);
      expect(health.ok).toBe(false);
      expect(health.error?.code).toBe(ErrorCodes.DEPENDENCY_UNAVAILABLE);
      expect(health.error?.retryable).toBe(true);

      const dump = JSON.stringify(tl.records);
      expect(dump).not.toContain(PW); // credentials never appear in logs
      expect(dump).not.toContain('postgresql://'); // connection strings never appear in logs
      expect(tl.records.some((r) => r.context?.correlationId === cid)).toBe(true); // correlated diagnostics
    } finally {
      await closeDatabase(client);
    }
  }, 15_000);
});
