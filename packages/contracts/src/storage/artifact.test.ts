// ACBP-P5-011 — artifact contracts, made executable (CDR-060; TASK-005; NFR-014; trust-critical #2).
//
// TASK-005's failure clause is "persist failure = task fails (no hollow success)", and the way a hollow success
// actually happens is that something optional was missing and nobody noticed. So the tests here are about what is
// REQUIRED: provenance that is complete, a size that is bounded, a format that is open, and a key that is derived.
import { describe, test, expect } from 'vitest';
import {
  ARTIFACT_FORMATS,
  isArtifactFormat,
  MAX_ARTIFACT_BYTES,
  isContentHash,
  artifactObjectKey,
  validateArtifact,
} from './artifact.js';
import { verifyKeyBelongsToCompany, keyString } from './object-key.js';

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HASH = 'a'.repeat(64);

const provenance = { runId: 'r1', workerId: 'research', workerVersion: 1, modelVersion: 'fake@1' };
const artifact = (over: Partial<Parameters<typeof validateArtifact>[0]> = {}) =>
  validateArtifact({ companyId: COMPANY, format: 'markdown', sizeBytes: 1_000, contentHash: HASH, provenance, ...over });

describe('open formats (the objective: "open formats", not a proprietary blob)', () => {
  test('are exactly markdown, json and text', () => {
    expect([...ARTIFACT_FORMATS]).toEqual(['markdown', 'json', 'text']);
    for (const f of ARTIFACT_FORMATS) expect(isArtifactFormat(f)).toBe(true);
    for (const bad of ['pdf', 'docx', 'MARKDOWN', '', null, 7]) expect(isArtifactFormat(bad)).toBe(false);
  });

  test('an unrecognised format is REFUSED, never stored as-is', () => {
    expect(artifact({ format: 'docx' })).toMatchObject({ ok: false, reason: 'unsupported_format' });
  });
});

describe('the size cap (IOQ-11, recorded in CDR-060 §3)', () => {
  test('is 8 MiB, and the constant is the only place it is written down', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(8 * 1024 * 1024);
  });

  test('exactly at the cap is allowed; one byte over is refused', () => {
    // A cap that refuses its own boundary value is a different cap than the one documented.
    expect(artifact({ sizeBytes: MAX_ARTIFACT_BYTES })).toMatchObject({ ok: true });
    expect(artifact({ sizeBytes: MAX_ARTIFACT_BYTES + 1 })).toMatchObject({ ok: false, reason: 'too_large' });
  });

  test('a zero-byte or nonsense size is refused — an empty artifact is a hollow success wearing a row', () => {
    // This is the TASK-005 failure mode in miniature: a row saying "your research is saved" pointing at nothing.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null, '100']) {
      expect(artifact({ sizeBytes: bad })).toMatchObject({ ok: false });
    }
  });
});

describe('provenance is REQUIRED (TASK-005; CDR-060 G6)', () => {
  test('a complete provenance passes', () => {
    expect(artifact()).toMatchObject({ ok: true });
  });

  test('EVERY field is required — an artifact whose origin is unknown cannot be trusted or revised', () => {
    // Not "nice to have". A revision workflow (P5-012) has to know what produced the thing it is revising, and a
    // founder correcting a wrong claim has to know which run to re-run.
    for (const missing of ['runId', 'workerId', 'workerVersion', 'modelVersion'] as const) {
      const partial = { ...provenance, [missing]: undefined };
      expect(artifact({ provenance: partial })).toMatchObject({ ok: false, reason: 'incomplete_provenance' });
    }
    expect(artifact({ provenance: undefined as never })).toMatchObject({ ok: false, reason: 'incomplete_provenance' });
  });

  test('a BLANK string is not a value — whitespace provenance is as absent as none', () => {
    expect(artifact({ provenance: { ...provenance, workerId: '   ' } })).toMatchObject({ ok: false, reason: 'incomplete_provenance' });
  });
});

describe('the content hash', () => {
  test('is 64 lowercase hex characters — a sha256, checked by SHAPE here because contracts cannot hash', () => {
    // @acbp/contracts is zero-dependency and has no crypto. The bytes are hashed where they exist (core), and this
    // validates the shape so a caller cannot pass a truncated, uppercase, or made-up digest.
    expect(isContentHash(HASH)).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', null, 42]) {
      expect(isContentHash(bad)).toBe(false);
    }
  });

  test('a malformed hash refuses the artifact', () => {
    expect(artifact({ contentHash: 'not-a-hash' })).toMatchObject({ ok: false, reason: 'invalid_content_hash' });
  });
});

describe('the object key is DERIVED and CONTENT-ADDRESSED (G2, G3; trust-critical #2)', () => {
  test('lives under the company prefix, and passes the boundary check', () => {
    const key = artifactObjectKey(COMPANY, HASH, 'markdown');
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(verifyKeyBelongsToCompany(keyString(key.value), COMPANY)).toBe(true);
    expect(verifyKeyBelongsToCompany(keyString(key.value), OTHER)).toBe(false);
  });

  test('THE SAME BYTES IN THE SAME COMPANY PRODUCE THE SAME KEY — that is what makes a re-write idempotent', () => {
    const a = artifactObjectKey(COMPANY, HASH, 'markdown');
    const b = artifactObjectKey(COMPANY, HASH, 'markdown');
    expect(a.ok && b.ok && keyString(a.value) === keyString(b.value)).toBe(true);
  });

  test('the same bytes in DIFFERENT companies produce DIFFERENT keys — content addressing never crosses a tenant', () => {
    // The whole point of trust-critical #2. Two companies researching the same public page must not share an object;
    // a shared key would make one company's read a read of the other's write.
    const a = artifactObjectKey(COMPANY, HASH, 'markdown');
    const b = artifactObjectKey(OTHER, HASH, 'markdown');
    expect(a.ok && b.ok && keyString(a.value) !== keyString(b.value)).toBe(true);
  });

  test('a caller-supplied path cannot escape the prefix — the derivation refuses rather than sanitises', () => {
    for (const bad of ['../evil', 'a/../../b', '..', '']) {
      expect(artifactObjectKey(COMPANY, bad, 'markdown').ok).toBe(false);
    }
  });

  test('an invalid company id refuses — there is no un-prefixed fallback', () => {
    expect(artifactObjectKey('not-a-uuid', HASH, 'markdown').ok).toBe(false);
  });
});
