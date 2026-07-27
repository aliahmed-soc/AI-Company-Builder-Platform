// ACBP-P5-001a — the third refusal layer (CDR-049 §3-G3): a job whose tenant context is missing or malformed is
// REFUSED with a typed reason, never defaulted to "the current company" or "system".
//
// These tests exist because the two DB layers cannot be reached from a unit test, and because the failure this
// ticket excludes is a SUCCESSFUL enqueue against the wrong tenant. Every case below is a caller that would, under a
// defaulting implementation, get a job that runs somewhere it should not.
import { describe, test, expect } from 'vitest';
import { JOB_KINDS, isJobKind, JOB_PAYLOAD_MAX_BYTES, JOB_KIND_MAX, JOB_IDEMPOTENCY_KEY_MAX, validateJobRequest, validateJobTenancy, type JobRequestInput } from './job.js';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

/** A request that is valid in every respect, so each test below varies exactly one thing. */
function valid(over: Partial<JobRequestInput> = {}): JobRequestInput {
  return { accountId: ACCOUNT, companyId: COMPANY, kind: 'understanding.generate', payload: { documentId: 'abc' }, createdByUserId: ACTOR, ...over };
}

describe('job kinds', () => {
  test('the kind set is closed — an unregistered kind is not a kind', () => {
    expect(isJobKind('understanding.generate')).toBe(true);
    expect(isJobKind('anything.else')).toBe(false);
    expect(isJobKind('')).toBe(false);
  });

  test('every declared kind is within the DB length bound, so no kind can be valid here and rejected by the CHECK', () => {
    for (const kind of JOB_KINDS) expect(kind.length).toBeGreaterThan(0);
    for (const kind of JOB_KINDS) expect(kind.length).toBeLessThanOrEqual(JOB_KIND_MAX);
  });
});

describe('validateJobTenancy — the subset that must be answerable before a scope exists', () => {
  test('accepts a well-formed pair and returns the ids VERBATIM', () => {
    expect(validateJobTenancy({ accountId: ACCOUNT, companyId: COMPANY })).toEqual({ ok: true, value: { accountId: ACCOUNT, companyId: COMPANY } });
  });

  test('reports missing and invalid as DIFFERENT reasons — "nobody told us" is not "we were told nonsense"', () => {
    expect(validateJobTenancy({ companyId: COMPANY })).toEqual({ ok: false, reason: 'missing_account' });
    expect(validateJobTenancy({ accountId: ACCOUNT })).toEqual({ ok: false, reason: 'missing_company' });
    expect(validateJobTenancy({ accountId: 'nope', companyId: COMPANY })).toEqual({ ok: false, reason: 'invalid_account' });
    expect(validateJobTenancy({ accountId: ACCOUNT, companyId: 'system' })).toEqual({ ok: false, reason: 'invalid_company' });
  });

  test('it needs NOTHING but the two ids — so it can run before authorization without touching platform state', () => {
    // The property that makes running this ahead of the authz check safe: no kind, no payload, no actor, no database.
    expect(validateJobTenancy({ accountId: ACCOUNT, companyId: COMPANY }).ok).toBe(true);
  });

  test('validateJobRequest DELEGATES here, so the two can never disagree about what valid tenancy is', () => {
    for (const bad of [{ accountId: undefined }, { companyId: undefined }, { accountId: 'x' }, { companyId: 'x' }]) {
      const full = validateJobRequest(valid(bad));
      const only = validateJobTenancy(valid(bad));
      expect(full.ok).toBe(false);
      expect(only.ok).toBe(false);
      if (full.ok || only.ok) throw new Error('expected refusals');
      expect(full.reason).toBe(only.reason);
    }
  });
});

describe('validateJobRequest — tenant context is refused, never defaulted', () => {
  test('a fully-formed request is accepted', () => {
    const result = validateJobRequest(valid());
    expect(result.ok).toBe(true);
  });

  test.each([
    ['undefined account', { accountId: undefined }, 'missing_account'],
    ['empty account', { accountId: '' }, 'missing_account'],
    ['blank account', { accountId: '   ' }, 'missing_account'],
    ['undefined company', { companyId: undefined }, 'missing_company'],
    ['empty company', { companyId: '' }, 'missing_company'],
    ['null company', { companyId: null }, 'missing_company'],
  ])('%s is refused as %s — not defaulted', (_label, over, reason) => {
    const result = validateJobRequest(valid(over));
    expect(result).toEqual({ ok: false, reason });
  });

  test('a non-UUID account or company is refused rather than coerced', () => {
    expect(validateJobRequest(valid({ accountId: 'not-a-uuid' }))).toEqual({ ok: false, reason: 'invalid_account' });
    expect(validateJobRequest(valid({ companyId: 'system' }))).toEqual({ ok: false, reason: 'invalid_company' });
  });

  test('"system" and "null" as STRINGS are refused — the plausible-looking defaults are the whole point', () => {
    for (const sentinel of ['system', 'null', 'undefined', '0', 'default']) {
      expect(validateJobRequest(valid({ companyId: sentinel })).ok).toBe(false);
      expect(validateJobRequest(valid({ accountId: sentinel })).ok).toBe(false);
    }
  });

  test('an unregistered kind is refused', () => {
    expect(validateJobRequest(valid({ kind: 'delete.everything' }))).toEqual({ ok: false, reason: 'invalid_kind' });
  });

  test('a missing actor is refused — provenance is not optional', () => {
    expect(validateJobRequest(valid({ createdByUserId: undefined }))).toEqual({ ok: false, reason: 'invalid_actor' });
  });

  test('an over-long idempotency key is refused rather than truncated — truncation MERGES two distinct jobs', () => {
    expect(validateJobRequest(valid({ idempotencyKey: 'k'.repeat(JOB_IDEMPOTENCY_KEY_MAX + 1) }))).toEqual({ ok: false, reason: 'invalid_idempotency_key' });
    expect(validateJobRequest(valid({ idempotencyKey: 'k'.repeat(JOB_IDEMPOTENCY_KEY_MAX) })).ok).toBe(true);
    // Absent and null are both legitimate: not every job is deduplicable.
    expect(validateJobRequest(valid({ idempotencyKey: null })).ok).toBe(true);
    expect(validateJobRequest(valid({ idempotencyKey: '' }))).toEqual({ ok: false, reason: 'invalid_idempotency_key' });
  });

  test('an over-large payload is refused HERE, so the DB CHECK is a backstop and not the error surface', () => {
    const big = { blob: 'x'.repeat(JOB_PAYLOAD_MAX_BYTES) };
    expect(validateJobRequest(valid({ payload: big }))).toEqual({ ok: false, reason: 'payload_too_large' });
  });

  test('the platform payload bound is strictly tighter than the database CHECK — no band where the DB is the error surface', () => {
    expect(JOB_PAYLOAD_MAX_BYTES).toBeLessThan(65_536);
  });

  test('payload size is measured in BYTES — a multi-byte payload under the CHARACTER count is still refused', () => {
    // Each '€' is 3 UTF-8 bytes, so this is well under JOB_PAYLOAD_MAX_BYTES characters and well over it in bytes.
    const multibyte = { blob: '€'.repeat(Math.ceil(JOB_PAYLOAD_MAX_BYTES / 2)) };
    expect(validateJobRequest(valid({ payload: multibyte }))).toEqual({ ok: false, reason: 'payload_too_large' });
  });

  test('tenancy is reported FIRST — a request that is both context-stripped and otherwise malformed names the context', () => {
    // A defaulting implementation is dangerous specifically because of the missing company; the caller must be told
    // that, not told about the bad kind it also has.
    expect(validateJobRequest(valid({ companyId: undefined, kind: 'nope' }))).toEqual({ ok: false, reason: 'missing_company' });
  });

  test('a non-object payload is refused', () => {
    for (const bad of ['string', 42, ['a'], true]) {
      expect(validateJobRequest(valid({ payload: bad as never }))).toEqual({ ok: false, reason: 'invalid_payload' });
    }
  });

  test('an absent or null payload means "no references", not a refusal — and normalises to {}', () => {
    // Deliberately NOT the same call as the tenancy fields. Defaulting a missing COMPANY invents an authority the
    // caller never had; defaulting a missing PAYLOAD invents nothing — an empty payload carries no references, so a
    // job enqueued without one fails at execution rather than doing something plausible to the wrong tenant.
    for (const absent of [undefined, null]) {
      const result = validateJobRequest(valid({ payload: absent }));
      if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
      expect(result.value.payload).toEqual({});
    }
  });

  test('the accepted request carries the ids VERBATIM — validation never rewrites what it validated', () => {
    const result = validateJobRequest(valid());
    if (!result.ok) throw new Error('expected ok');
    expect(result.value.accountId).toBe(ACCOUNT);
    expect(result.value.companyId).toBe(COMPANY);
    expect(result.value.kind).toBe('understanding.generate');
    expect(result.value.idempotencyKey).toBeNull();
  });
});
