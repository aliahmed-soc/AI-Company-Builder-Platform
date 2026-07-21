// ACBP-P0-018 — database configuration validation tests. Fake local URLs only (never real creds).
import { describe, test, expect } from 'vitest';
import { parseDatabaseConfig, loadTestDatabaseConfig, ConfigValidationError, Secret } from './index.js';

const PW = 'pw-zz01'; // short fake password sentinel (not a realistic secret format)
const validEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  APP_ENV: 'development',
  DATABASE_URL: `postgresql://acbp:${PW}@localhost:5432/acbp_dev`,
  ...over,
});

describe('parseDatabaseConfig', () => {
  test('valid configuration parses with safe defaults', () => {
    const cfg = parseDatabaseConfig(validEnv());
    expect(cfg.appEnv).toBe('development');
    expect(cfg.url).toBeInstanceOf(Secret);
    expect(cfg.poolMin).toBe(0);
    expect(cfg.poolMax).toBe(10);
    expect(cfg.connectionTimeoutMs).toBe(10_000);
    expect(cfg.idleTimeoutMs).toBe(30_000);
    expect(cfg.statementTimeoutMs).toBe(30_000);
    expect(cfg.applicationName).toBe('acbp');
    expect(cfg.ssl).toBe('disable'); // dev default
    expect(cfg.migrateOnStart).toBe(false); // safe default
  });

  test('missing DATABASE_URL fails before any connection attempt', () => {
    expect(() => parseDatabaseConfig(validEnv({ DATABASE_URL: undefined }))).toThrow(ConfigValidationError);
  });

  test('non-postgres URL is rejected', () => {
    expect(() => parseDatabaseConfig(validEnv({ DATABASE_URL: 'mysql://x/y' }))).toThrow(ConfigValidationError);
  });

  test('the connection URL is redacted from validation errors', () => {
    try {
      parseDatabaseConfig(validEnv({ DATABASE_URL: 'not-a-url' }));
      throw new Error('expected validation to fail');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      const dump = JSON.stringify(err.issues) + err.message;
      expect(dump).not.toContain('not-a-url');
      expect(err.issues.some((i) => i.field === 'DATABASE_URL' && i.message === 'invalid (redacted)')).toBe(true);
    }
  });

  test('the Secret-wrapped URL never leaks via toString/JSON/reveal-by-default', () => {
    const cfg = parseDatabaseConfig(validEnv());
    expect(String(cfg.url)).not.toContain(PW);
    expect(JSON.stringify(cfg)).not.toContain(PW);
    // reveal() is the explicit, audited escape hatch and returns the true value.
    expect(cfg.url.reveal()).toContain(PW);
  });

  test('production defaults SSL to require', () => {
    const cfg = parseDatabaseConfig(validEnv({ APP_ENV: 'production', DATABASE_URL: 'postgresql://h/d' }));
    expect(cfg.ssl).toBe('require');
  });

  test('production must not disable SSL', () => {
    expect(() => parseDatabaseConfig(validEnv({ APP_ENV: 'production', DATABASE_SSL: 'disable' }))).toThrow(ConfigValidationError);
  });

  test('pool max below pool min is rejected', () => {
    expect(() => parseDatabaseConfig(validEnv({ DATABASE_POOL_MIN: '20', DATABASE_POOL_MAX: '5' }))).toThrow(ConfigValidationError);
  });

  test('durations and pool sizes parse from strings', () => {
    const cfg = parseDatabaseConfig(validEnv({ DATABASE_CONNECTION_TIMEOUT: '2s', DATABASE_STATEMENT_TIMEOUT: '15s', DATABASE_POOL_MAX: '25' }));
    expect(cfg.connectionTimeoutMs).toBe(2000);
    expect(cfg.statementTimeoutMs).toBe(15_000);
    expect(cfg.poolMax).toBe(25);
  });

  test('input environment record is not mutated', () => {
    const env = validEnv();
    const snapshot = JSON.stringify(env);
    parseDatabaseConfig(env);
    expect(JSON.stringify(env)).toBe(snapshot);
  });

  test('loadTestDatabaseConfig is deterministic and credential-free by default', () => {
    const cfg = loadTestDatabaseConfig({});
    expect(cfg.appEnv).toBe('test');
    expect(cfg.ssl).toBe('disable');
    expect(cfg.applicationName).toBe('acbp-test');
    expect(cfg.url.reveal()).toContain('localhost');
    expect(cfg.role).toBe('owner');
  });
});

describe('parseDatabaseConfig — two-connection role model (ACBP-P1-006; CDR-013)', () => {
  const twoUrlEnv = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    APP_ENV: 'development',
    DATABASE_URL: `postgresql://acbp_owner:${PW}@localhost:5432/acbp_dev`,
    DATABASE_APP_URL: `postgresql://acbp_app:${PW}@localhost:5432/acbp_dev`,
    ...over,
  });

  test('owner role uses DATABASE_URL and is tagged role=owner', () => {
    const cfg = parseDatabaseConfig(twoUrlEnv(), { role: 'owner' });
    expect(cfg.role).toBe('owner');
    expect(cfg.url.reveal()).toContain('acbp_owner');
    expect(cfg.url.reveal()).not.toContain('acbp_app');
  });

  test('app role uses DATABASE_APP_URL and is tagged role=app (URLs are not swapped)', () => {
    const cfg = parseDatabaseConfig(twoUrlEnv(), { role: 'app' });
    expect(cfg.role).toBe('app');
    expect(cfg.url.reveal()).toContain('acbp_app');
    expect(cfg.url.reveal()).not.toContain('acbp_owner');
  });

  test('default role is owner (backward compatible)', () => {
    expect(parseDatabaseConfig(twoUrlEnv()).role).toBe('owner');
  });

  test('app role FAILS CLOSED when DATABASE_APP_URL is absent — no fallback to the owner DATABASE_URL', () => {
    expect(() => parseDatabaseConfig(twoUrlEnv({ DATABASE_APP_URL: undefined }), { role: 'app' })).toThrow(ConfigValidationError);
  });

  test('app role in production fails closed when DATABASE_APP_URL is absent even though DATABASE_URL is present', () => {
    const env = { APP_ENV: 'production', DATABASE_URL: `postgresql://acbp_owner:${PW}@db:5432/acbp`, DATABASE_SSL: 'require' };
    expect(() => parseDatabaseConfig(env, { role: 'app' })).toThrow(ConfigValidationError);
  });

  test('a bad DATABASE_APP_URL is reported under its own field and redacted', () => {
    try {
      parseDatabaseConfig(twoUrlEnv({ DATABASE_APP_URL: 'not-a-url' }), { role: 'app' });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      expect(err.issues.some((i) => i.field === 'DATABASE_APP_URL' && i.message === 'invalid (redacted)')).toBe(true);
      expect(JSON.stringify(err.issues) + err.message).not.toContain('not-a-url');
    }
  });

  test('the app URL is Secret-wrapped (never leaks via toString/JSON)', () => {
    const cfg = parseDatabaseConfig(twoUrlEnv(), { role: 'app' });
    expect(String(cfg.url)).not.toContain(PW);
    expect(JSON.stringify(cfg)).not.toContain(PW);
  });
});
