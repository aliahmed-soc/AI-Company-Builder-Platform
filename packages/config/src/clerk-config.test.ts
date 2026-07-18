// ACBP-P1-001 — Clerk configuration validation tests. Clearly-FAKE hyphenated placeholders only
// (never real keys; hyphens prevent the secret scanner's key-format patterns from matching).
import { describe, test, expect } from 'vitest';
import { parseClerkConfig, loadTestClerkConfig, ConfigValidationError, Secret } from './index.js';

const PK = 'pk_test_fake-local-publishable';
const SK = 'sk_test_fake-local-secret';
const valid = (over: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: PK,
  CLERK_SECRET_KEY: SK,
  CLERK_AUTHORIZED_PARTIES: 'http://localhost:3000, https://app.example.test',
  ...over,
});

describe('parseClerkConfig', () => {
  test('valid config: publishable is public; secret/jwt are Secret-wrapped', () => {
    const c = parseClerkConfig(valid({ CLERK_JWT_KEY: 'fake-pem-material' }));
    expect(c.publishableKey).toBe(PK); // public, plain string
    expect(c.secretKey).toBeInstanceOf(Secret);
    expect(c.jwtKey).toBeInstanceOf(Secret);
    expect(c.instanceType).toBe('development'); // pk_test_ => development
    expect(c.authorizedParties).toEqual(['http://localhost:3000', 'https://app.example.test']);
  });

  test('secret values never serialize via toString/JSON; reveal() is the explicit escape hatch', () => {
    const c = parseClerkConfig(valid({ CLERK_JWT_KEY: 'jwt-fake-material' }));
    expect(String(c.secretKey)).not.toContain('fake-local-secret');
    expect(JSON.stringify(c)).not.toContain('fake-local-secret');
    expect(JSON.stringify(c)).not.toContain('jwt-fake-material');
    expect(c.secretKey.reveal()).toBe(SK);
  });

  test('missing publishable or secret key fails', () => {
    expect(() => parseClerkConfig(valid({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined }))).toThrow(ConfigValidationError);
    expect(() => parseClerkConfig(valid({ CLERK_SECRET_KEY: undefined }))).toThrow(ConfigValidationError);
  });

  test('malformed keys are rejected (wrong prefix)', () => {
    expect(() => parseClerkConfig(valid({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'nope' }))).toThrow(ConfigValidationError);
    expect(() => parseClerkConfig(valid({ CLERK_SECRET_KEY: 'nope' }))).toThrow(ConfigValidationError);
  });

  test('secret key is redacted in validation errors', () => {
    try {
      parseClerkConfig(valid({ CLERK_SECRET_KEY: 'totally-wrong-not-a-clerk-key' }));
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigValidationError);
      const err = e as ConfigValidationError;
      const dump = JSON.stringify(err.issues) + err.message;
      expect(dump).not.toContain('totally-wrong-not-a-clerk-key');
      expect(err.issues.some((i) => i.field === 'CLERK_SECRET_KEY' && i.message === 'invalid (redacted)')).toBe(true);
    }
  });

  test('mismatched test/live instance between publishable and secret is rejected', () => {
    expect(() => parseClerkConfig(valid({ CLERK_SECRET_KEY: 'sk_live_fake-prod-secret' }))).toThrow(ConfigValidationError);
  });

  test('authorized parties default to empty when unset (not enforced)', () => {
    const c = parseClerkConfig(valid({ CLERK_AUTHORIZED_PARTIES: undefined }));
    expect(c.authorizedParties).toEqual([]);
  });

  test('loadTestClerkConfig is deterministic and credential-free', () => {
    const c = loadTestClerkConfig();
    expect(c.instanceType).toBe('development');
    expect(c.publishableKey.startsWith('pk_test_')).toBe(true);
    expect(c.secretKey).toBeInstanceOf(Secret);
  });
});
