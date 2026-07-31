// ACBP-P6-004 / CDR-069 — the binding contract: what an approval is bound to, and when it stops authorizing.
//
// These are the negative cases ADR-009 calls launch gates. Every one asks the same question from a different angle:
// can something that is not what the human approved still authorize execution?
//
// THE MATERIAL IS TESTED, NOT THE DIGEST, and that is not a weaker test — it is a stricter one. Hashing is injective
// in practice, so two materials differ iff their digests differ; asserting on the material shows WHICH bytes moved
// when a case fails, instead of "one opaque hex string is not another". The digest itself lives in @acbp/core,
// where `node:crypto` belongs, and is tested there.
import { describe, test, expect } from 'vitest';
import { BINDING_NORMALIZATION_VERSION, bindingMaterial, bindingMatches, isExpired, approvalUsability, type ApprovalBindingInput } from './binding.js';

const base = (): ApprovalBindingInput => ({
  toolId: 'send_email',
  toolVersion: 1,
  payload: { recipients: ['a@example.test', 'b@example.test'], subject: 'Hello' },
  costBoundCredits: 5,
});

describe('bindingMaterial — ACBP-P6-004/CDR-069 §1-G1', () => {
  test('leads with the normalization version, so material from different rules can never be byte-equal', () => {
    expect(bindingMaterial(base()).startsWith(`v${BINDING_NORMALIZATION_VERSION}\n`)).toBe(true);
  });

  test('is STABLE across object key order — the same payload written differently is the same approval', () => {
    expect(bindingMaterial({ ...base(), payload: { subject: 'Hello', recipients: ['a@example.test', 'b@example.test'] } })).toBe(bindingMaterial(base()));
  });

  test('is SENSITIVE to array order — recipient order is meaningful, unlike key order', () => {
    expect(bindingMaterial({ ...base(), payload: { recipients: ['b@example.test', 'a@example.test'], subject: 'Hello' } })).not.toBe(bindingMaterial(base()));
  });

  // THE MATERIAL-CHANGE RULE, one case per bound element (APPROVAL-AND-POLICY §2).
  test.each([
    ['the PAYLOAD', { payload: { recipients: ['attacker@example.test'], subject: 'Hello' } }],
    ['one FIELD of the payload', { payload: { recipients: ['a@example.test', 'b@example.test'], subject: 'Hello!' } }],
    ['the TOOL', { toolId: 'wipe_everything' }],
    ['the TOOL VERSION', { toolVersion: 2 }],
    ['the COST BOUND', { costBoundCredits: 500 }],
  ])('changing %s changes the material', (_what, over) => {
    expect(bindingMaterial({ ...base(), ...over })).not.toBe(bindingMaterial(base()));
  });

  test('field values cannot be SHIFTED ACROSS the boundary between them', () => {
    // `("ab","c")` vs `("a","bc")` must not produce the same bytes. Labels plus a newline separator are what stop
    // a concatenation-style collision, and a collision here would be an approval for a different tool matching.
    expect(bindingMaterial({ ...base(), toolId: 'ab', toolVersion: 1 })).not.toBe(bindingMaterial({ ...base(), toolId: 'a', toolVersion: 1 }));
    expect(bindingMaterial({ ...base(), toolId: 'send_email\nversion=99', toolVersion: 1 })).not.toBe(bindingMaterial({ ...base(), toolId: 'send_email', toolVersion: 99 }));
  });

  test('an EMPTY payload still binds — "no arguments" is a payload, not an absence of one', () => {
    expect(bindingMaterial({ ...base(), payload: {} })).not.toBe(bindingMaterial(base()));
    expect(bindingMaterial({ ...base(), payload: {} })).toContain('payload={}');
  });

  test('is TOTAL over hostile payloads — cycles and junk produce material rather than throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => bindingMaterial({ ...base(), payload: cyclic })).not.toThrow();
    for (const payload of [undefined, null, 42, 'string', [1, 2, 3], new Date('nonsense')]) {
      expect(typeof bindingMaterial({ ...base(), payload })).toBe('string');
    }
  });
});

describe('bindingMatches — ACBP-P6-004/CDR-069 §1-G2', () => {
  const stored = { hash: 'abc123', version: BINDING_NORMALIZATION_VERSION };

  test('matches only an identical hash at a KNOWN version', () => {
    expect(bindingMatches(stored, 'abc123')).toBe(true);
    expect(bindingMatches(stored, 'abc124')).toBe(false);
  });

  test('an UNKNOWN normalization version is a MISMATCH, not a prompt to migrate', () => {
    // A hash we cannot recompute is a hash we cannot verify. Fail closed: ADR-009's stated cost is that the
    // normalization rules must be versioned, and the honest reading of an unrecognised version is "no".
    expect(bindingMatches({ hash: 'abc123', version: BINDING_NORMALIZATION_VERSION + 1 }, 'abc123')).toBe(false);
    expect(bindingMatches({ hash: 'abc123', version: 0 }, 'abc123')).toBe(false);
    expect(bindingMatches({ hash: 'abc123', version: '1' as never }, 'abc123')).toBe(false);
  });

  test('junk in place of a stored binding is a mismatch, never a match', () => {
    for (const junk of [undefined, null, {}, { hash: '', version: BINDING_NORMALIZATION_VERSION }, { hash: 123, version: BINDING_NORMALIZATION_VERSION }]) {
      expect(bindingMatches(junk as never, 'abc123')).toBe(false);
    }
  });
});

describe('isExpired — ACBP-P6-004/CDR-069 §1-G3', () => {
  const at = new Date('2026-08-01T12:00:00.000Z');

  test('an approval is live BEFORE its instant and expired AT it', () => {
    // `now >= expiresAt` — clock ambiguity resolves to EXPIRED, so the boundary instant is not a live approval.
    expect(isExpired(new Date(at.getTime() - 1), at)).toBe(false);
    expect(isExpired(at, at)).toBe(true);
    expect(isExpired(new Date(at.getTime() + 1), at)).toBe(true);
    // A generous margin either side, so this is not passing on millisecond arithmetic alone.
    expect(isExpired(new Date(at.getTime() - 86_400_000), at)).toBe(false);
    expect(isExpired(new Date(at.getTime() + 86_400_000), at)).toBe(true);
  });

  test('an UNREADABLE clock or expiry is EXPIRED — ambiguity never resolves to "still valid"', () => {
    expect(isExpired(at, undefined)).toBe(true);
    expect(isExpired(at, null)).toBe(true);
    expect(isExpired(at, new Date('nonsense'))).toBe(true);
    expect(isExpired(new Date('nonsense'), at)).toBe(true);
    expect(isExpired(undefined, at)).toBe(true);
    expect(isExpired('2026-08-01', at)).toBe(true);
    expect(isExpired(at.getTime(), at)).toBe(true);
  });
});

describe('approvalUsability — the whole question in one total function (CDR-069 §1-G5/G8)', () => {
  const at = new Date('2026-08-01T12:00:00.000Z');
  const HASH = 'the-expected-hash';
  const live = () => ({
    status: 'decided',
    revokedAt: null,
    expiresAt: new Date(at.getTime() + 60_000),
    binding: { hash: HASH, version: BINDING_NORMALIZATION_VERSION },
  });

  test('a live, unrevoked, unexpired, matching approval is USABLE', () => {
    expect(approvalUsability(live(), HASH, at)).toEqual({ usable: true });
  });

  // ONE REASON EACH, and the reason is the point: a refusal that cannot say why is a refusal nobody can act on.
  test.each([
    ['REVOKED', { revokedAt: new Date(at.getTime() - 1) }, 'revoked'],
    ['ALREADY CONSUMED', { status: 'consumed' }, 'consumed'],
    ['still PENDING a human', { status: 'pending' }, 'not_decided'],
    ['SUPERSEDED by an edit', { status: 'superseded' }, 'not_decided'],
    ['EXPIRED', { expiresAt: new Date(at.getTime() - 1) }, 'expired'],
  ])('an approval that is %s is refused, with that as the reason', (_what, over, reason) => {
    expect(approvalUsability({ ...live(), ...over }, HASH, at)).toEqual({ usable: false, reason });
  });

  test('a HASH MISMATCH is refused — never warned about and continued (G8)', () => {
    const r = approvalUsability(live(), 'a-different-hash', at);
    expect(r).toEqual({ usable: false, reason: 'payload_mismatch' });
    // The lenient outcome is not merely unused, it is INEXPRESSIBLE: there is no `warn` in the result type.
    expect(JSON.stringify(r)).not.toContain('warn');
  });

  test('REVOCATION OUTRANKS EXPIRY when both are true — the human acted, and that is what a reader needs to know', () => {
    expect(approvalUsability({ ...live(), revokedAt: new Date(at.getTime() - 1), expiresAt: new Date(at.getTime() - 1) }, HASH, at)).toEqual({
      usable: false,
      reason: 'revoked',
    });
  });

  test('is TOTAL over junk — an unreadable record authorizes nothing', () => {
    for (const junk of [undefined, null, {}, { status: 'decided' }, { status: 42, revokedAt: 'yes', expiresAt: 'no', binding: 'x' }]) {
      expect(approvalUsability(junk as never, HASH, at).usable).toBe(false);
    }
  });
});
