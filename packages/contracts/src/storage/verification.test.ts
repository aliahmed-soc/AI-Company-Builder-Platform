// ACBP-P5-011 — the read-back rule (TASK-005; CDR-060 G1). Pure, so it can be proven without a database or a bucket.
//
// `FAILURE-AND-RECOVERY` row 7 and `WORKFLOW-STATE-MACHINES` line 60 both say the same thing: an artifact persist
// failure FAILS THE TASK, never a hollow success. The subtle half of that is a persist that did not fail — a provider
// returning success metadata for bytes that never landed. This decides whether what came back counts as stored.
import { describe, test, expect } from 'vitest';
import { verifyPersistedObject } from './verification.js';

describe('what counts as really stored', () => {
  test('present, with the size we wrote, is stored', () => {
    expect(verifyPersistedObject({ exists: true, metadata: { contentType: 'text/markdown', sizeBytes: 12 } }, 12)).toEqual({ ok: true });
  });

  test('ABSENT is not stored — the lying provider', () => {
    // The `dropNextPut` case: `put` resolved with plausible metadata and the object is not there. Trusting the return
    // value here is exactly how a row comes to point at nothing.
    expect(verifyPersistedObject({ exists: false }, 12)).toEqual({ ok: false, reason: 'object_missing' });
  });

  test('present but SHORTER than we wrote is not stored — a truncated write is a corrupt artifact', () => {
    expect(verifyPersistedObject({ exists: true, metadata: { contentType: 'text/markdown', sizeBytes: 5 } }, 12)).toEqual({ ok: false, reason: 'size_mismatch' });
  });

  test('present but LONGER than we wrote is not stored either — that is somebody else s object under our key', () => {
    // Not a harmless surplus. Under a content-addressed key, a different length means different content, which means
    // the key does not address what we believe it does.
    expect(verifyPersistedObject({ exists: true, metadata: { contentType: 'text/markdown', sizeBytes: 20 } }, 12)).toEqual({ ok: false, reason: 'size_mismatch' });
  });

  test('a nonsense expected size refuses rather than passing — fail closed', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(verifyPersistedObject({ exists: true, metadata: { contentType: 'text/plain', sizeBytes: bad } }, bad)).toMatchObject({ ok: false });
    }
  });

  test('a malformed head result is not a success', () => {
    for (const bad of [undefined, null, {}, { exists: 'yes' }, { exists: true }]) {
      expect(verifyPersistedObject(bad as never, 12)).toMatchObject({ ok: false });
    }
  });
});
