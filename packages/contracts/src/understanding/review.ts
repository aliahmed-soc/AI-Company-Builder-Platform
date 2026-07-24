// @acbp/contracts — understanding review + confirmation contracts (ACBP-P2-009; CDR-030; UNDER-003/004, DISC-008).
//
// Provider-neutral shapes + PURE logic for the owner review + confirmation gate over a generated understanding
// VERSION (the immutable, versioned `understanding_documents` from P2-008). The five per-item controls, the
// optimistic-concurrency (`expected_version`) staleness guard, and the strategy-unlock gate predicate live here as
// pure functions — the effects (durable review/confirmation-event rows, audit emission, tenant scope) live in
// @acbp/core. Zero-dependency leaf: no provider SDK, no DB, no framework.

/** The CLOSED five owner review controls over an understanding item (diagram 04 `review`; API-CONTRACTS). */
export const REVIEW_DECISIONS = ['approved', 'edited', 'rejected', 'evidence_requested', 'research_requested'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export function isReviewDecision(v: unknown): v is ReviewDecision {
  return typeof v === 'string' && (REVIEW_DECISIONS as readonly string[]).includes(v);
}

/** The CLOSED confirmation-lifecycle event kinds recorded per understanding version (WORKFLOW §2 line 30/31). */
export const CONFIRMATION_EVENT_KINDS = ['confirmed', 'corrected'] as const;
export type ConfirmationEventKind = (typeof CONFIRMATION_EVENT_KINDS)[number];
export function isConfirmationEventKind(v: unknown): v is ConfirmationEventKind {
  return typeof v === 'string' && (CONFIRMATION_EVENT_KINDS as readonly string[]).includes(v);
}

/** Bounds (defense-in-depth; also the DB column widths in migration 0020). */
export const REVIEW_NOTE_MAX = 10_000; // edited corrected text / reject reason / request note
export const CORRECTION_REF_MAX = 256; // a bounded reference to what was corrected (an id / short code, never content)

/** Only `edited` MUST carry a note (the corrected text); the other four accept an optional note. */
export function reviewDecisionRequiresNote(decision: ReviewDecision): boolean {
  return decision === 'edited';
}

/** Result of validating a review note against its decision (deny-by-default at the boundary). */
export type ReviewNoteCheck = { readonly ok: true; readonly note: string | null } | { readonly ok: false };

/**
 * Validate a review note for a decision. `edited` requires a non-blank note within bounds; the other decisions
 * accept an optional (trimmed, bounded) note or none. A blank note normalizes to `null`; an over-long note (or a
 * missing note for `edited`) is rejected. Never coerces silently.
 */
export function validateReviewNote(decision: ReviewDecision, note: string | null | undefined): ReviewNoteCheck {
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (reviewDecisionRequiresNote(decision)) {
    if (trimmed.length === 0 || trimmed.length > REVIEW_NOTE_MAX) return { ok: false };
    return { ok: true, note: trimmed };
  }
  if (trimmed.length === 0) return { ok: true, note: null };
  if (trimmed.length > REVIEW_NOTE_MAX) return { ok: false };
  return { ok: true, note: trimmed };
}

/**
 * Optimistic-concurrency guard (API-CONTRACTS line 14 `expected_version`): a review decision / confirm targets the
 * CURRENT version only. True IFF `expectedVersion` is an integer equal to `currentVersion`. A stale expectation (a
 * newer version was generated meanwhile) is rejected — never applied to superseded content.
 */
export function isExpectedVersionCurrent(expectedVersion: unknown, currentVersion: number): boolean {
  return typeof expectedVersion === 'number' && Number.isInteger(expectedVersion) && expectedVersion === currentVersion;
}

/** The minimal shape of a confirmation-lifecycle event for the gate predicate. */
export interface ConfirmationEventLike {
  readonly kind: ConfirmationEventKind;
}

/**
 * The strategy-unlock gate (WORKFLOW §2; UNDER-003 "planning blocked until confirm"). A version is CONFIRMED and
 * ACTIVE IFF it has a `confirmed` event and NO `corrected` event superseding it. Deny-by-default: no events → not
 * confirmed (planning stays blocked); a correction re-blocks planning (DISC-008 "dependents flagged").
 */
export function isVersionConfirmed(events: readonly ConfirmationEventLike[]): boolean {
  let confirmed = false;
  let corrected = false;
  for (const e of events) {
    if (e.kind === 'confirmed') confirmed = true;
    else if (e.kind === 'corrected') corrected = true;
  }
  return confirmed && !corrected;
}
