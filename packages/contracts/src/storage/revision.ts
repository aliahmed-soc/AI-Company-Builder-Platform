// @acbp/contracts — the revision request (ACBP-P5-012; CDR-064; TASK-005 lineage; J-13; ADR-016). Zero-dep and PURE.
//
// A REVISION IS NOT AN EDIT. Canon is consistent about this: ADR-016 §5 says "new version per revision,
// lineage-linked; no destructive overwrite", and `AI-AND-WORKER-ARCHITECTURE.md:13` says revisions "create
// lineage-linked new runs". So the thing this module validates is a REQUEST for new work, not a mutation of an
// existing artifact — which is why the `artifacts` table needs no UPDATE path for any of it (CDR-064 G2).
//
// What lives here is only what can be decided without a database: is there guidance, is it bounded, is there a real
// idempotency key. Everything about lineage itself is a foreign key, and belongs to the migration.

/**
 * The bound on founder-authored revision guidance, in CHARACTERS.
 *
 * Characters rather than UTF-8 bytes, deliberately: a byte limit refuses a shorter piece of Arabic or emoji prose
 * than of English, which is a silent penalty on non-Latin scripts rather than a real limit. The database column is
 * sized to the worst case this implies.
 */
export const REVISION_GUIDANCE_MAX = 2000;

/**
 * CLOSED. A refusal outside this set would reach a caller that cannot branch on it, and the caller's job on any of
 * these is to report an honest, actionable reason rather than retry.
 */
export const REVISION_REFUSALS = ['guidance_required', 'guidance_too_long', 'key_required'] as const;
export type RevisionRefusal = (typeof REVISION_REFUSALS)[number];

export type RevisionGuidanceResult = { readonly ok: true; readonly guidance: string } | { readonly ok: false; readonly reason: RevisionRefusal };
export type RevisionKeyResult = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly reason: RevisionRefusal };

/**
 * May this guidance start a revision?
 *
 * GUIDANCE IS REQUIRED. A revision request with nothing to change is a re-run wearing a revision's name: the worker
 * has nothing to do differently, and the founder is charged a credit (CDR-064 G4) for the same output. Refusing is
 * the honest answer, and "re-run this task" is a different operation that already exists.
 *
 * Returns the TRIMMED value on success so exactly one place decides what the guidance IS — the caller stores what
 * this returns, and the bound is measured against the same string that gets stored.
 */
export function validateRevisionGuidance(value: unknown): RevisionGuidanceResult {
  if (typeof value !== 'string') return { ok: false, reason: 'guidance_required' };
  const guidance = value.trim();
  if (guidance === '') return { ok: false, reason: 'guidance_required' };
  // `[...guidance]` counts code points, so an emoji is one character rather than four. `.length` would count UTF-16
  // units and quietly halve the allowance for anything outside the BMP.
  if ([...guidance].length > REVISION_GUIDANCE_MAX) return { ok: false, reason: 'guidance_too_long' };
  return { ok: true, guidance };
}

/**
 * The idempotency key for a revision request (CDR-064 G3).
 *
 * A BLANK KEY IS REFUSED, never treated as a key. P5-003b and P5-014 both paid for the opposite: an empty string
 * accepted as a real key makes unrelated calls collide, and for a metered operation that means one founder's
 * revision silently answering another's request — and only one of them being charged.
 */
export function validateRevisionKey(value: unknown): RevisionKeyResult {
  if (typeof value !== 'string') return { ok: false, reason: 'key_required' };
  const key = value.trim();
  if (key === '') return { ok: false, reason: 'key_required' };
  return { ok: true, key };
}

/**
 * One revision request, as the founder sees it (CDR-064 G1).
 *
 * `newTaskId` is the link that makes lineage derivable: an artifact whose run belongs to that TASK is a revision of
 * `originalArtifactId`. J-13: *"new linked task created (lineage to original) -> re-execution"* - not a new run on
 * the finished original, which the state machine forbids anyway (`running->completed` is terminal). There is deliberately NO `revision_of_artifact_id`
 * column on `artifacts` — lineage in two places is lineage that can disagree, and a revision run that wrote three
 * artifacts would need it set correctly three times.
 *
 * The guidance IS returned here: the founder asked for it and needs to see what they asked. It is the AUDIT payload
 * that excludes it, following `task.deleted`'s reason text.
 */
export interface ArtifactRevisionDTO {
  readonly revisionId: string;
  readonly originalArtifactId: string;
  readonly newTaskId: string;
  readonly guidance: string;
  readonly requestedAt: string;
}
