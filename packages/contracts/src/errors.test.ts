// ACBP-P0-016 — structured-error taxonomy tests (public/internal separation, safety, determinism).
import { describe, test, expect } from 'vitest';
import {
  PlatformError,
  ErrorCodes,
  isPlatformError,
  normalizeError,
  validationError,
  platformError,
  statusFor,
  type PublicErrorEnvelope,
} from './index.js';

// Fake sentinel — NOT a realistic secret format. Must never appear in any public output.
const SECRET_SENTINEL = 'zz-secret-sentinel-01';
const TENANT_SENTINEL = 'company_other_tenant_42';

describe('platform errors: codes & categories', () => {
  test('known errors retain code and category', () => {
    const e = platformError('authz', { code: ErrorCodes.AUTHORIZATION_DENIED });
    expect(e.category).toBe('authz');
    expect(e.code).toBe(ErrorCodes.AUTHORIZATION_DENIED);
    expect(isPlatformError(e)).toBe(true);
  });

  test('error codes are unique', () => {
    const values = Object.values(ErrorCodes);
    expect(new Set(values).size).toBe(values.length);
  });

  test('retryable classification: limit_exceeded/provider_unavailable retryable, others not', () => {
    expect(platformError('limit_exceeded').retryable).toBe(true);
    expect(platformError('provider_unavailable').retryable).toBe(true);
    expect(platformError('validation').retryable).toBe(false);
    expect(platformError('internal').retryable).toBe(false);
  });

  test('status mapping is consistent', () => {
    expect(statusFor('not_found')).toBe(404);
    expect(platformError('not_found').status).toBe(404);
    expect(statusFor('internal')).toBe(500);
  });
});

describe('normalization of unknown thrown values', () => {
  test('native Error → internal category, cause preserved internally', () => {
    const cause = new Error('boom from provider');
    const e = normalizeError(cause);
    expect(e.category).toBe('internal');
    expect(e.code).toBe(ErrorCodes.INTERNAL_ERROR);
    expect(e.cause).toBe(cause);
    expect(e.toInternal().causeChain.join(' ')).toContain('boom from provider');
  });

  test('string, object, null, undefined normalize safely to internal', () => {
    for (const v of ['a raw string', { some: 'object' }, null, undefined]) {
      const e = normalizeError(v);
      expect(e.category).toBe('internal');
      expect(e.toPublic().category).toBe('internal');
    }
  });

  test('existing PlatformError passes through; correlationId attached when missing', () => {
    const original = platformError('conflict');
    expect(normalizeError(original)).toBe(original);
    const withCid = normalizeError(original, { correlationId: 'cid-123' });
    expect(withCid.correlationId).toBe('cid-123');
    expect(withCid.category).toBe('conflict');
  });

  test('validation errors map consistently', () => {
    const e = validationError({ fields: ['email', 'name'] });
    expect(e.category).toBe('validation');
    expect(e.code).toBe(ErrorCodes.VALIDATION_FAILED);
    expect(e.retryable).toBe(false);
    expect(e.metadata['failedFields']).toBe('email,name');
  });
});

describe('public/internal separation & safety', () => {
  test('public serialization excludes internal diagnostics, stack, metadata, cause', () => {
    const e = platformError('internal', {
      message: 'An internal error occurred.',
      internalMessage: `db=postgres://u:${SECRET_SENTINEL}@h/db`,
      metadata: { tenantId: TENANT_SENTINEL, region: 'us' },
      cause: new Error(`raw provider: ${SECRET_SENTINEL}`),
      correlationId: 'cid-9',
    });
    const pub = e.toPublic();
    expect(Object.keys(pub).sort()).toEqual(['category', 'code', 'correlationId', 'message', 'retryable']);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(SECRET_SENTINEL);
    expect(json).not.toContain(TENANT_SENTINEL);
    expect(json).not.toContain('internalMessage');
    expect(json).not.toContain('stack');
    expect(json).not.toContain('metadata');
  });

  test('JSON.stringify(error) cannot reveal internal fields (toJSON = public)', () => {
    const e = platformError('internal', {
      internalMessage: `secret=${SECRET_SENTINEL}`,
      metadata: { tenantId: TENANT_SENTINEL },
      cause: new Error(SECRET_SENTINEL),
    });
    const json = JSON.stringify(e);
    expect(json).not.toContain(SECRET_SENTINEL);
    expect(json).not.toContain(TENANT_SENTINEL);
    expect(json).not.toContain('stack');
  });

  test('stack traces are excluded from public output but available internally', () => {
    const e = platformError('internal', { internalMessage: 'with stack' });
    expect(e.toPublic()).not.toHaveProperty('stack');
    expect(typeof e.toInternal().stack).toBe('string');
  });

  test('secret sentinel is never exposed publicly even when present internally', () => {
    const e = normalizeError(new Error(`API_KEY leaked ${SECRET_SENTINEL}`), { correlationId: 'c1' });
    expect(JSON.stringify(e.toPublic())).not.toContain(SECRET_SENTINEL);
    // …but it IS retained internally for diagnostics
    expect(e.toInternal().internalMessage).toContain(SECRET_SENTINEL);
  });

  test('cross-tenant metadata is not exposed publicly', () => {
    const e = platformError('not_found', { metadata: { tenantId: TENANT_SENTINEL } });
    expect(JSON.stringify(e.toPublic())).not.toContain(TENANT_SENTINEL);
    expect(e.toInternal().metadata['tenantId']).toBe(TENANT_SENTINEL);
  });
});

describe('determinism & guards', () => {
  test('public envelope is deterministic for identical inputs', () => {
    const mk = (): PublicErrorEnvelope =>
      platformError('validation', { code: ErrorCodes.VALIDATION_FAILED, message: 'bad', correlationId: 'c' }).toPublic();
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });

  test('type guard distinguishes PlatformError from other values', () => {
    expect(isPlatformError(platformError('internal'))).toBe(true);
    expect(isPlatformError(new Error('x'))).toBe(false);
    expect(isPlatformError('string')).toBe(false);
    expect(isPlatformError(null)).toBe(false);
  });

  test('causes remain available internally through normalization', () => {
    const root = new Error('root cause');
    const wrapped = new PlatformError('provider_unavailable', { cause: root, internalMessage: 'wrap' });
    expect(wrapped.cause).toBe(root);
    expect(wrapped.toInternal().causeChain.some((c) => c.includes('root cause'))).toBe(true);
  });
});
