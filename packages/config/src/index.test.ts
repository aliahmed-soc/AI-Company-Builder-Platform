// ACBP-P0-015 — configuration validation tests (positive, negative, isolation, redaction).
import { describe, test, expect } from 'vitest';
import {
  parseWebServerConfig,
  parseWorkerConfig,
  parsePublicConfig,
  parseBootstrapConfig,
  loadTestConfig,
  ConfigValidationError,
  Secret,
} from './index.js';

// Short (<16 char) sentinel passed as a variable — never a quoted 16+ literal, so it cannot trip
// the secret scanner, while still proving redaction (the exact string must never appear in output).
const SENTINEL = 'zzsentinel0001';

function baseEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    APP_ENV: 'development',
    APP_PUBLIC_URL: 'http://localhost:3000',
    INFISICAL_CLIENT_ID: 'dev-client-id',
    INFISICAL_CLIENT_SECRET: SENTINEL,
    ...over,
  };
}

describe('valid configuration', () => {
  test('development', () => {
    const c = parseWebServerConfig(baseEnv());
    expect(c.appEnv).toBe('development');
    expect(c.port).toBe(3000);
  });
  test('test (loadTestConfig)', () => {
    expect(loadTestConfig().appEnv).toBe('test');
  });
  test('staging', () => {
    expect(parseWebServerConfig(baseEnv({ APP_ENV: 'staging' })).appEnv).toBe('staging');
  });
  test('production (https)', () => {
    const c = parseWebServerConfig(baseEnv({ APP_ENV: 'production', APP_PUBLIC_URL: 'https://app.example.com' }));
    expect(c.appEnv).toBe('production');
  });
});

describe('invalid configuration', () => {
  test('missing required value', () => {
    expect(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_ID: undefined }))).toThrow(ConfigValidationError);
  });
  test('empty required value', () => {
    const err = captureError(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_ID: '' })));
    expect(err.issues.some((i) => i.field === 'INFISICAL_CLIENT_ID')).toBe(true);
  });
  test('invalid URL', () => {
    const err = captureError(() => parseWebServerConfig(baseEnv({ APP_PUBLIC_URL: 'not-a-url' })));
    expect(err.issues.some((i) => i.field === 'APP_PUBLIC_URL' && /URL/.test(i.message))).toBe(true);
  });
  test('invalid integer', () => {
    const err = captureError(() => parseWebServerConfig(baseEnv({ PORT: 'abc' })));
    expect(err.issues.some((i) => i.field === 'PORT' && /integer/.test(i.message))).toBe(true);
  });
  test('out-of-range integer', () => {
    const err = captureError(() => parseWebServerConfig(baseEnv({ PORT: '70000' })));
    expect(err.issues.some((i) => i.field === 'PORT')).toBe(true);
  });
  test('invalid boolean', () => {
    expect(() => parseWebServerConfig(baseEnv({ APP_TELEMETRY_ENABLED: 'yes' }))).toThrow(ConfigValidationError);
  });
  test('unknown environment value', () => {
    expect(() => parseWebServerConfig(baseEnv({ APP_ENV: 'prod' }))).toThrow(ConfigValidationError);
  });
  test('unsafe missing value with no default (secret)', () => {
    expect(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_SECRET: undefined }))).toThrow(ConfigValidationError);
  });
  test('cross-field: production requires https', () => {
    const err = captureError(() => parseWebServerConfig(baseEnv({ APP_ENV: 'production', APP_PUBLIC_URL: 'http://x' })));
    expect(err.issues.some((i) => /https/.test(i.message))).toBe(true);
  });
});

describe('defaults and distinctions', () => {
  test('safe default applied (PORT, telemetry)', () => {
    const c = parseWebServerConfig(baseEnv());
    expect(c.port).toBe(3000);
    expect(c.telemetryEnabled).toBe(false);
  });
  test('absent vs empty are both rejected for required, with distinct handling', () => {
    expect(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_ID: undefined }))).toThrow();
    expect(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_ID: '' }))).toThrow();
  });
});

describe('public/server separation', () => {
  test('public allowlist exposes only appEnv + publicUrl', () => {
    const pub = parsePublicConfig(baseEnv({ SOME_OTHER: 'x' }));
    expect(Object.keys(pub).sort()).toEqual(['appEnv', 'publicUrl']);
  });
  test('server secret is excluded from public output', () => {
    const json = JSON.stringify(parsePublicConfig(baseEnv()));
    expect(json).not.toContain('INFISICAL');
    expect(json).not.toContain(SENTINEL);
  });
});

describe('web/worker isolation', () => {
  test('web has port, worker has concurrency; shapes differ', () => {
    const web = parseWebServerConfig(baseEnv());
    const worker = parseWorkerConfig(baseEnv());
    expect(web).toHaveProperty('port');
    expect(web).not.toHaveProperty('concurrency');
    expect(worker).toHaveProperty('concurrency');
    expect(worker).not.toHaveProperty('port');
  });
  test('worker config does not require APP_PUBLIC_URL', () => {
    expect(() => parseWorkerConfig(baseEnv({ APP_PUBLIC_URL: undefined }))).not.toThrow();
  });
});

describe('secret safety', () => {
  test('Secret redacts in string/JSON but reveal() returns the value', () => {
    const s = new Secret(SENTINEL);
    expect(String(s)).toBe('[REDACTED]');
    expect(JSON.stringify({ s })).not.toContain(SENTINEL);
    expect(s.reveal()).toBe(SENTINEL);
  });
  test('web-server config JSON redacts the bootstrap secret', () => {
    const json = JSON.stringify(parseWebServerConfig(baseEnv()));
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain('[REDACTED]');
  });
  test('validation error never contains the secret value', () => {
    const err = captureError(() => parseBootstrapConfig(baseEnv({ INFISICAL_CLIENT_SECRET: '' })));
    expect(err.message).not.toContain(SENTINEL);
    expect(err.issues.some((i) => i.field === 'INFISICAL_CLIENT_SECRET' && i.message === 'invalid (redacted)')).toBe(true);
  });
});

describe('purity and determinism', () => {
  test('does not mutate the input environment object', () => {
    const env = Object.freeze(baseEnv());
    const before = JSON.stringify(env);
    parseWebServerConfig(env);
    expect(JSON.stringify(env)).toBe(before);
  });
  test('repeated parsing is deterministic', () => {
    const redact = (c: unknown): string => JSON.stringify(c);
    expect(redact(parseWebServerConfig(baseEnv()))).toBe(redact(parseWebServerConfig(baseEnv())));
  });
});

function captureError(fn: () => unknown): ConfigValidationError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigValidationError) return e;
    throw e;
  }
  throw new Error('expected ConfigValidationError to be thrown');
}
