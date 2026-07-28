// @acbp/contracts — task completion evidence (ACBP-P5-011; TASK-005; EVENT-CATALOG line 180). Zero-dep and PURE.
//
// `EVENT-CATALOG` line 180 requires `artifact_refs[]` on `task.completed`: *"required — no artifactless completion
// without explicit no-artifact rationale, TASK-005"*. `WORKFLOW-STATE-MACHINES` line 60 says the same thing from the
// other side: the `running→completed` transition is guarded by *"artifact persisted (TASK-005 — persistence failure
// ⇒ failed, never hollow success)"*.
//
// Read together those are TWO permitted shapes and a forbidden third. The forbidden one — a task reporting completion
// having produced nothing, with nobody able to say why — is not rejected here by a validation someone could forget to
// call. It is UNREPRESENTABLE: {@link CompletionEvidence} has no third member, and an empty artifact list is a
// refusal rather than a synonym for "no artifacts".
//
// This is why the event is registered by THIS ticket and not by the coordinator (ACBP-P5-002 recorded the deferral in
// `audit.ts` and in `succeedRun`'s own doc comment): a succeeded RUN is not a completed TASK, and until artifacts
// existed there was nothing for the requirement to be true of.

/** The most artifacts one completion may cite. A task producing more than this is a design problem, not a big task. */
export const MAX_COMPLETION_ARTIFACTS = 50;

/** Bound on the no-artifact rationale. Long enough for a real explanation, short enough to stay a bounded surface. */
export const MAX_NO_ARTIFACT_RATIONALE = 1000;

/**
 * What a completing task offers as evidence that it produced something — or an explicit account of why it did not.
 *
 * A CLOSED union with exactly the two shapes canon permits. Adding a third would have to be a deliberate edit here,
 * reviewed as such, rather than an empty array quietly flowing through a caller.
 */
export type CompletionEvidence =
  | { readonly kind: 'artifacts'; readonly artifactIds: readonly string[] }
  | { readonly kind: 'no_artifact'; readonly rationale: string };

export const COMPLETION_REFUSALS = ['no_evidence', 'invalid_artifact_ref', 'duplicate_artifact_ref', 'too_many_artifacts', 'blank_rationale', 'rationale_too_long', 'unknown_shape'] as const;
export type CompletionRefusal = (typeof COMPLETION_REFUSALS)[number];

export type CompletionValidation = { readonly ok: true; readonly evidence: CompletionEvidence } | { readonly ok: false; readonly reason: CompletionRefusal };

/**
 * May this task complete, and on what evidence?
 *
 * TOTAL over `unknown`, because the input reaches this from an HTTP body or a worker's structured output, and the
 * declared type is only a promise. TYPED refusals rather than throws: the caller's job on a refusal is to leave the
 * task un-completed and say why, which is precisely the outcome TASK-005 is protecting.
 *
 * AN EMPTY LIST IS `no_evidence`, NOT SUCCESS. This is the single line that decides whether the requirement survives
 * contact with a real caller: a worker that produced nothing will pass `[]` long before it thinks to pass a
 * rationale, and a system that accepts `[]` has an artifactless completion with no rationale — the exact thing canon
 * forbids, arrived at without anyone deciding to allow it.
 */
export function validateCompletionEvidence(input: unknown): CompletionValidation {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'unknown_shape' };
  const candidate = input as { kind?: unknown; artifactIds?: unknown; rationale?: unknown };

  if (candidate.kind === 'artifacts') {
    if (!Array.isArray(candidate.artifactIds)) return { ok: false, reason: 'unknown_shape' };
    const ids: readonly unknown[] = candidate.artifactIds as readonly unknown[];
    if (ids.length === 0) return { ok: false, reason: 'no_evidence' };
    if (ids.length > MAX_COMPLETION_ARTIFACTS) return { ok: false, reason: 'too_many_artifacts' };
    const seen = new Set<string>();
    const artifactIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== 'string' || id.trim() === '') return { ok: false, reason: 'invalid_artifact_ref' };
      if (seen.has(id)) return { ok: false, reason: 'duplicate_artifact_ref' };
      seen.add(id);
      artifactIds.push(id);
    }
    return { ok: true, evidence: { kind: 'artifacts', artifactIds } };
  }

  if (candidate.kind === 'no_artifact') {
    const rationale = candidate.rationale;
    if (typeof rationale !== 'string' || rationale.trim() === '') return { ok: false, reason: 'blank_rationale' };
    if (rationale.length > MAX_NO_ARTIFACT_RATIONALE) return { ok: false, reason: 'rationale_too_long' };
    return { ok: true, evidence: { kind: 'no_artifact', rationale } };
  }

  return { ok: false, reason: 'unknown_shape' };
}

/** How many artifacts this completion cites. Zero exactly when an explicit rationale was given instead. */
export function completionArtifactCount(evidence: CompletionEvidence): number {
  return evidence.kind === 'artifacts' ? evidence.artifactIds.length : 0;
}
