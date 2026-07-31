// ACBP-P6-004 / CDR-069 §1-G2 — the digest half of the binding. The material half is tested in @acbp/contracts.
//
// Not skippable: this needs no database, and the property it protects — that a changed payload produces a changed
// hash — is the one an approval's whole meaning rests on.
import { describe, test, expect } from 'vitest';
import { BINDING_NORMALIZATION_VERSION, bindingMatches, type ApprovalBindingInput } from '@acbp/contracts';
import { computePayloadBinding } from './binding.js';

const base = (): ApprovalBindingInput => ({
  toolId: 'send_email',
  toolVersion: 1,
  payload: { recipients: ['a@example.test'], subject: 'Hello' },
  costBoundCredits: 5,
});

describe('computePayloadBinding — ACBP-P6-004', () => {
  test('is a sha256 hex digest carrying its normalization version', () => {
    const b = computePayloadBinding(base());
    expect(b.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.version).toBe(BINDING_NORMALIZATION_VERSION);
  });

  test('is DETERMINISTIC — the same action hashes the same way every time', () => {
    expect(computePayloadBinding(base()).hash).toBe(computePayloadBinding(base()).hash);
  });

  test('a stored binding matches the action it was taken over, and nothing else', () => {
    const stored = computePayloadBinding(base());
    expect(bindingMatches(stored, computePayloadBinding(base()).hash)).toBe(true);
    // The attack this exists to stop: approved for one recipient, executed against another.
    expect(bindingMatches(stored, computePayloadBinding({ ...base(), payload: { recipients: ['attacker@example.test'], subject: 'Hello' } }).hash)).toBe(false);
  });

  test.each([
    ['payload', { payload: { recipients: ['a@example.test'], subject: 'Hello!' } }],
    ['tool', { toolId: 'wipe_everything' }],
    ['tool version', { toolVersion: 2 }],
    ['cost bound', { costBoundCredits: 6 }],
  ])('a changed %s produces a different digest, not merely different material', (_what, over) => {
    expect(computePayloadBinding({ ...base(), ...over }).hash).not.toBe(computePayloadBinding(base()).hash);
  });

  test('key order still does not matter once hashed', () => {
    expect(computePayloadBinding({ ...base(), payload: { subject: 'Hello', recipients: ['a@example.test'] } }).hash).toBe(computePayloadBinding(base()).hash);
  });
});
