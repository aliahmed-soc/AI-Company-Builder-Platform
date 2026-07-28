// ACBP-P5-011 — "no artifactless completion" made unrepresentable (TASK-005; EVENT-CATALOG line 180).
//
// The catalog's wording is exact: `artifact_refs[]` is **required — no artifactless completion without explicit
// no-artifact rationale**. That is two permitted shapes, not one, and the failure this guards against is the THIRD
// shape: a task that reports completion having produced nothing, with nobody able to say why. These tests exist to
// prove that shape cannot be constructed.
import { describe, test, expect } from 'vitest';
import { validateCompletionEvidence, MAX_COMPLETION_ARTIFACTS, MAX_NO_ARTIFACT_RATIONALE } from './completion.js';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('the two shapes canon permits', () => {
  test('artifacts: one or more references completes the task', () => {
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [ID_A] })).toMatchObject({ ok: true });
    const many = validateCompletionEvidence({ kind: 'artifacts', artifactIds: [ID_A, ID_B] });
    expect(many).toMatchObject({ ok: true });
    if (many.ok) expect(many.evidence).toEqual({ kind: 'artifacts', artifactIds: [ID_A, ID_B] });
  });

  test('no_artifact: an EXPLICIT rationale completes the task, and is carried through', () => {
    const r = validateCompletionEvidence({ kind: 'no_artifact', rationale: 'The research question was already answered by memory item M-4.' });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.evidence).toEqual({ kind: 'no_artifact', rationale: 'The research question was already answered by memory item M-4.' });
  });
});

describe('THE THIRD SHAPE — completion with nothing to show and nothing to say — cannot be expressed', () => {
  test('an EMPTY artifact list is refused, not treated as "no artifacts"', () => {
    // The single most likely way this requirement dies: a caller passes `[]` because nothing was produced, and the
    // system reads it as a valid completion. `[]` is not a no-artifact rationale; it is a missing one.
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [] })).toMatchObject({ ok: false, reason: 'no_evidence' });
  });

  test('a BLANK rationale is not a rationale', () => {
    for (const blank of ['', '   ', '\t\n']) {
      expect(validateCompletionEvidence({ kind: 'no_artifact', rationale: blank })).toMatchObject({ ok: false, reason: 'blank_rationale' });
    }
  });

  test('a missing, unknown or malformed shape is refused — there is no default completion', () => {
    for (const bad of [undefined, null, {}, { kind: 'artifacts' }, { kind: 'no_artifact' }, { kind: 'whatever' }, { kind: 'artifacts', artifactIds: 'x' }, 'artifacts', 7]) {
      expect(validateCompletionEvidence(bad)).toMatchObject({ ok: false });
    }
  });

  test('an artifact id that is blank or not a string is refused — a placeholder ref is a hollow success', () => {
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [ID_A, '  '] })).toMatchObject({ ok: false, reason: 'invalid_artifact_ref' });
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [ID_A, 42] })).toMatchObject({ ok: false, reason: 'invalid_artifact_ref' });
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [null] })).toMatchObject({ ok: false, reason: 'invalid_artifact_ref' });
  });
});

describe('bounds', () => {
  test('the same artifact cited twice is refused — two refs to one artifact is not two artifacts', () => {
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [ID_A, ID_A] })).toMatchObject({ ok: false, reason: 'duplicate_artifact_ref' });
  });

  test('the artifact list is bounded at its exact limit', () => {
    const at = Array.from({ length: MAX_COMPLETION_ARTIFACTS }, (_, i) => `${i}`);
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: at })).toMatchObject({ ok: true });
    expect(validateCompletionEvidence({ kind: 'artifacts', artifactIds: [...at, 'one-more'] })).toMatchObject({ ok: false, reason: 'too_many_artifacts' });
  });

  test('the rationale is bounded at its exact limit', () => {
    expect(validateCompletionEvidence({ kind: 'no_artifact', rationale: 'r'.repeat(MAX_NO_ARTIFACT_RATIONALE) })).toMatchObject({ ok: true });
    expect(validateCompletionEvidence({ kind: 'no_artifact', rationale: 'r'.repeat(MAX_NO_ARTIFACT_RATIONALE + 1) })).toMatchObject({ ok: false, reason: 'rationale_too_long' });
  });
});
