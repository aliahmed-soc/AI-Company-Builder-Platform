// ACBP-P7-007 — TRUST-CRITICAL #16, the AUDIT half: what `boundedMetadata` does and does not protect.
//
// Canon item 16 reads "Secret values never appear in logs or audit payloads" and credits `(P0-017, P7-007)`.
// P0-017 earned the LOGS half — `redact()` plus the sentinel case in `logger.test.ts`. The AUDIT half is built
// by nobody, and this file is the executable statement of that, because prose in a decision record is exactly
// the artefact class ACBP-P7-002 proved unreliable.
//
// WHAT PROTECTS THE AUDIT PAYLOAD TODAY: `boundedMetadata` rejects objects, arrays, Errors, null, undefined,
// functions, symbols, bigints, non-finite numbers, bad key shapes, >16 keys, >1024-unit values and >4096-byte
// totals. It applies NO SECRET DETECTION WHATSOEVER. Safety rests entirely on every producer being a typed
// factory that happens to pass scalars — a CONVENTION, not a control. `audit_events` is append-only and
// permanent, so a secret written there is unrecoverable.
//
// These tests pin BOTH halves of that: the bounds that ARE enforced, and the detection that is NOT. The second
// group is written to FAIL THE DAY ENFORCEMENT LANDS, which is deliberate — whoever adds it must come here,
// see the trade-off recorded in CDR-080 §7, and update this file on purpose rather than by accident.
import { describe, test, expect } from 'vitest';
import { boundedMetadata } from './audit.js';
import { containsSecret } from '../context/context.js';

/** Synthetic, never real. Each is a shape `containsSecret` recognises. */
const SECRET_SHAPED = [
  ['a connection string', 'postgresql://acbp_app:hunter2plusmore@db.internal:5432/acbp'],
  ['a bearer token', 'Bearer abcdefghijklmnop0123456789ABCDEF'],
  ['a credential assignment', 'password: correct-horse-battery'],
  ['a JWT', 'eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4'],
  ['an AWS access key id', 'AKIA1234567890ABCDEF'],
] as const;

describe('boundedMetadata — the bounds it DOES enforce (ACBP-P1-013/CDR-019)', () => {
  test('scalars pass and are frozen', () => {
    const out = boundedMetadata({ count: 3, ok: true, reason: 'paused' });
    expect(out).toEqual({ count: 3, ok: true, reason: 'paused' });
    expect(Object.isFrozen(out)).toBe(true);
  });

  test('nested objects, arrays and Errors are rejected — no structure reaches the payload', () => {
    expect(() => boundedMetadata({ nested: { a: 1 } })).toThrow();
    expect(() => boundedMetadata({ list: [1, 2] })).toThrow();
    expect(() => boundedMetadata({ err: new Error('boom') })).toThrow();
    expect(() => boundedMetadata({ nothing: null })).toThrow();
  });

  test('an over-long value is rejected, and the error names the KEY and never the value', () => {
    const marker = 'THE-VALUE-ITSELF';
    try {
      boundedMetadata({ note: marker.padEnd(1025, 'x') });
      throw new Error('expected boundedMetadata to reject an over-long value');
    } catch (error) {
      const text = JSON.stringify(error instanceof Error ? { m: error.message, ...error } : error);
      expect(text).toContain('metadata.note');
      expect(text).not.toContain(marker);
    }
  });
});

describe('TRUST-CRITICAL #16 — the audit half is NOT enforced (ACBP-P7-007; CDR-080 §7)', () => {
  test('the detector recognises every shape used below — otherwise the next test proves nothing', () => {
    // The anti-vacuity control. If `containsSecret` stopped matching, the "accepts a secret" test below would
    // still pass and would silently become meaningless.
    for (const [label, value] of SECRET_SHAPED) {
      expect(containsSecret(value), `containsSecret should recognise ${label}`).toBe(true);
    }
  });

  test('GAP: boundedMetadata ACCEPTS secret-shaped values — nothing stops one reaching audit_events', () => {
    // THIS TEST DOCUMENTS A GAP, NOT A GUARANTEE. It is expected to fail when enforcement lands; the person who
    // adds enforcement should replace it with the positive assertion and record the decision in CDR-080 §7.
    //
    // Enforcement is NOT done here because it is a behavioural change to a merged contract on every audited
    // write, and audit-or-nothing (ADR-015) means a rejection fails the PRODUCT OPERATION. The high-entropy
    // catch-all in SECRET_PATTERNS matches a base64 SHA-256, which audit metadata legitimately carries — so a
    // naive rejection would break real writes. That trade-off is the owner's, and it is recorded rather than
    // taken inside a test-pass ticket.
    for (const [label, value] of SECRET_SHAPED) {
      const out = boundedMetadata({ detail: value });
      expect(out['detail'], `${label} was accepted verbatim`).toBe(value);
      expect(containsSecret(String(out['detail'])), `${label} survives into the payload`).toBe(true);
    }
  });

  test('GAP: the same is true at the byte limit — length is bounded, content is not', () => {
    const value = `password: ${'a'.repeat(200)}`;
    expect(value.length).toBeLessThan(1024);
    expect(containsSecret(value)).toBe(true);
    expect(boundedMetadata({ detail: value })['detail']).toBe(value);
  });
});
