// ACBP-P1-001 — unit tests for the fail-closed proxy wrapper + credential-error classifier.
// No Next runtime required. Proves that ONLY unparseable/invalid/tampered credentials become 401,
// and that provider/config/internal failures are re-thrown (never silently swallowed).
import { describe, test, expect } from 'vitest';
import { failClosed, isUnparseableCredentialError } from './fail-closed-proxy.js';
import type { NextMiddleware } from 'next/server';

const req = {} as Parameters<NextMiddleware>[0];
const evt = {} as Parameters<NextMiddleware>[1];

/** A middleware that throws the given value — models Clerk throwing during credential parsing. */
const throwsError = (err: unknown): NextMiddleware => () => {
  throw err;
};

/** A genuine base64/JSON decode SyntaxError, exactly the class Clerk raises for a malformed token. */
function realDecodeError(): SyntaxError {
  try {
    JSON.parse('{"a":');
  } catch (e) {
    return e as SyntaxError;
  }
  throw new Error('expected a SyntaxError');
}

describe('isUnparseableCredentialError — classifier', () => {
  test('a base64/JSON decode SyntaxError → credential-parse failure', () => {
    const e = realDecodeError();
    expect(e).toBeInstanceOf(SyntaxError);
    expect(isUnparseableCredentialError(e)).toBe(true);
  });
  test('"Unexpected end of data" (Clerk base64) → true', () => {
    expect(isUnparseableCredentialError(new SyntaxError('Unexpected end of data'))).toBe(true);
  });
  test('malformed / invalid-jwt / bad-signature messages → true', () => {
    expect(isUnparseableCredentialError(new Error('JWT is malformed'))).toBe(true);
    expect(isUnparseableCredentialError(new Error('invalid jwt'))).toBe(true);
    expect(isUnparseableCredentialError(new Error('token-invalid: invalid signature'))).toBe(true);
  });
  test('provider/network failures → false (NOT a credential-parse failure)', () => {
    expect(isUnparseableCredentialError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isUnparseableCredentialError(new Error('socket hang up'))).toBe(false);
    expect(isUnparseableCredentialError(new Error('fetch failed'))).toBe(false);
    expect(isUnparseableCredentialError(new Error('failed to fetch JWKS'))).toBe(false);
  });
  test('server-configuration failures → false', () => {
    expect(isUnparseableCredentialError(new Error('Missing CLERK_SECRET_KEY'))).toBe(false);
    expect(isUnparseableCredentialError(new Error('Clerk is not configured'))).toBe(false);
  });
  test('unexpected internal errors → false', () => {
    expect(isUnparseableCredentialError(new TypeError('x is not a function'))).toBe(false);
    expect(isUnparseableCredentialError(new Error('kaboom'))).toBe(false);
  });
});

describe('failClosed proxy wrapper', () => {
  test('valid middleware result passes through unchanged', async () => {
    const ok = new Response('ok', { status: 200 });
    const r = await failClosed(() => ok)(req, evt);
    expect(r).toBe(ok);
  });

  test('undefined (next) result passes through', async () => {
    const r = await failClosed(() => undefined)(req, evt);
    expect(r).toBeUndefined();
  });

  test('malformed bearer token (base64 SyntaxError) → 401', async () => {
    const r = await failClosed(throwsError(realDecodeError()))(req, evt);
    expect(r).toBeInstanceOf(Response);
    expect(r?.status).toBe(401);
    expect(await r!.json()).toEqual({ error: 'unauthenticated' });
  });

  test('garbage JWT-shaped token (decode SyntaxError) → 401', async () => {
    const r = await failClosed(throwsError(new SyntaxError('Unexpected token in JSON')))(req, evt);
    expect(r?.status).toBe(401);
  });

  test('tampered token (invalid signature) → 401', async () => {
    const r = await failClosed(throwsError(new Error('token-invalid: invalid signature')))(req, evt);
    expect(r?.status).toBe(401);
  });

  test('the 401 response leaks no token or raw Clerk error detail', async () => {
    const r = await failClosed(throwsError(new SyntaxError('sk_test_leak base64 clerk boom at chunk 27:3811')))(req, evt);
    const text = await r!.text();
    expect(text).not.toMatch(/sk_test_|clerk|base64|boom|chunk/i);
    expect(text).toBe(JSON.stringify({ error: 'unauthenticated' }));
  });

  test('provider-unavailable error is NOT converted to 401 (re-thrown)', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    await expect(failClosed(throwsError(err))(req, evt)).rejects.toBe(err);
  });

  test('unexpected internal error is NOT silently swallowed (re-thrown)', async () => {
    const err = new TypeError('reading undefined');
    await expect(failClosed(throwsError(err))(req, evt)).rejects.toBe(err);
  });

  test('server-misconfiguration error is NOT converted to 401 (re-thrown)', async () => {
    const err = new Error('Missing CLERK_SECRET_KEY');
    await expect(failClosed(throwsError(err))(req, evt)).rejects.toBe(err);
  });
});
