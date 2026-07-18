// ACBP-P0-017 — redaction tests. Sentinel is short + passed as a variable (never a scannable literal).
import { describe, test, expect } from 'vitest';
import { Secret } from '@acbp/config';
import { redact, REDACTED } from './index.js';

const SENTINEL = 'zz-sentinel-01';

describe('redaction', () => {
  test('sensitive keys are redacted case-insensitively', () => {
    const out = redact({ Password: SENTINEL, API_KEY: SENTINEL, AccessToken: SENTINEL, safe: 'keep' }) as Record<string, unknown>;
    expect(out['Password']).toBe(REDACTED);
    expect(out['API_KEY']).toBe(REDACTED);
    expect(out['AccessToken']).toBe(REDACTED);
    expect(out['safe']).toBe('keep');
  });

  test('nested objects and arrays are redacted', () => {
    const out = redact({ a: { b: { secret: SENTINEL } }, list: [{ token: SENTINEL }, 'ok'] }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
    expect(JSON.stringify(out)).toContain('ok');
  });

  test('input object is not mutated', () => {
    const input = { password: SENTINEL, nested: { token: SENTINEL } };
    const snapshot = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('circular structures do not crash redaction', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out['name']).toBe('a');
    expect(out['self']).toBe('[Circular]');
  });

  test('Secret wrapper values are redacted', () => {
    const out = redact({ creds: new Secret(SENTINEL), list: [new Secret(SENTINEL)] });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('error messages and nested causes are redacted', () => {
    const err = new Error(`db password=${SENTINEL}`, { cause: { apiKey: SENTINEL } });
    const out = redact(err);
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('stack traces do not leak sentinel secrets', () => {
    const err = new Error(`token=${SENTINEL}`);
    const out = redact(err) as Record<string, unknown>;
    expect(typeof out['stack']).toBe('string');
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('authorization headers are redacted', () => {
    const out = redact({ headers: { Authorization: `Bearer ${SENTINEL}`, cookie: `session=${SENTINEL}` } });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  test('sensitive URL query values are redacted', () => {
    const out = redact({ url: `https://api.example.com/v1?token=${SENTINEL}&user=bob` });
    const json = JSON.stringify(out);
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain('user=bob');
  });

  test('unknown/unusual values do not crash redaction', () => {
    expect(() => redact(undefined)).not.toThrow();
    expect(() => redact(null)).not.toThrow();
    expect(() => redact(Symbol('x'))).not.toThrow();
    expect(() => redact(() => 1)).not.toThrow();
    expect(() => redact(123n)).not.toThrow();
  });
});
