// ACBP-P0-018 — driver-error normalization + redaction unit tests. Fake values only.
import { describe, test, expect } from 'vitest';
import { ErrorCodes, isPlatformError } from '@acbp/contracts';
import { toDatabaseError } from './index.js';

function pgErr(code: string, message = 'driver failure'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe('toDatabaseError', () => {
  test('unique_violation maps to a non-retryable conflict', () => {
    const e = toDatabaseError(pgErr('23505'));
    expect(e.category).toBe('conflict');
    expect(e.code).toBe(ErrorCodes.CONFLICT_DETECTED);
    expect(e.retryable).toBe(false);
  });

  test('serialization_failure maps to a retryable conflict', () => {
    const e = toDatabaseError(pgErr('40001'));
    expect(e.category).toBe('conflict');
    expect(e.retryable).toBe(true);
  });

  test('statement timeout maps to a retryable dependency timeout', () => {
    const e = toDatabaseError(pgErr('57014'));
    expect(e.category).toBe('provider_unavailable');
    expect(e.code).toBe(ErrorCodes.DEPENDENCY_TIMEOUT);
    expect(e.retryable).toBe(true);
  });

  test('integrity violations map to validation', () => {
    expect(toDatabaseError(pgErr('23503')).category).toBe('validation');
    expect(toDatabaseError(pgErr('23502')).category).toBe('validation');
  });

  test('insufficient_privilege (RLS) maps to authz', () => {
    const e = toDatabaseError(pgErr('42501'));
    expect(e.category).toBe('authz');
  });

  test('connection failures (ECONNREFUSED) map to a retryable dependency-unavailable', () => {
    const e = toDatabaseError(pgErr('ECONNREFUSED'));
    expect(e.category).toBe('provider_unavailable');
    expect(e.code).toBe(ErrorCodes.DEPENDENCY_UNAVAILABLE);
    expect(e.retryable).toBe(true);
  });

  test('unknown errors map to internal', () => {
    expect(toDatabaseError(pgErr('99999')).category).toBe('internal');
    expect(toDatabaseError(new Error('weird')).category).toBe('internal');
  });

  test('the original driver error is preserved as cause; sqlState recorded in metadata', () => {
    const original = pgErr('23505', 'duplicate key');
    const e = toDatabaseError(original, { operation: 'insert_probe' });
    expect(e.cause).toBe(original);
    const internal = e.toInternal();
    expect(internal.metadata['sqlState']).toBe('23505');
    expect(internal.metadata['operation']).toBe('insert_probe');
  });

  test('public envelope carries no SQL, parameters, or credentials', () => {
    // A driver message that (pathologically) contains a connection string with a password.
    const leaky = pgErr('28P01', 'auth failed for postgresql://acbp:pw-zz01@db:5432/app');
    const e = toDatabaseError(leaky);
    const publicJson = JSON.stringify(e.toPublic());
    expect(publicJson).not.toContain('pw-zz01');
    expect(publicJson).not.toContain('postgresql://');
    // Our own internal note is generic (the raw driver message is only in the cause chain, which the
    // observability redaction pipeline scrubs at log time).
    expect(e.toInternal().internalMessage).not.toContain('pw-zz01');
  });

  test('correlation id is attached when provided', () => {
    const e = toDatabaseError(pgErr('23505'), { correlationId: 'cid-1' });
    expect(e.correlationId).toBe('cid-1');
    expect(isPlatformError(e)).toBe(true);
  });

  test('already-normalized PlatformErrors pass through (correlation attached if missing)', () => {
    const first = toDatabaseError(pgErr('23505'));
    const again = toDatabaseError(first, { correlationId: 'cid-2' });
    expect(again.category).toBe('conflict');
    expect(again.correlationId).toBe('cid-2');
  });
});
