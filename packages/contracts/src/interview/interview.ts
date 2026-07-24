// @acbp/contracts — provider-neutral interview session lifecycle contract (ACBP-P2-001; CDR-022; DISC-007;
// ADR-008 semantics; WORKFLOW-STATE-MACHINES.md §2). Transport- and provider-neutral; zero-dependency like the
// rest of @acbp/contracts.
//
// This module defines WHAT an interview session is at the contract level: the CLOSED, canonical state set, the
// server-enforced legal-transition map (so illegal transitions are rejected uniformly), the honest display
// projection (DISC-007 "progress indicator is honest"), and the redacted client DTO. It knows nothing about
// execution (fresh CompanyScope transactions, durable rows, audit emission) — that lives in @acbp/core.
//
// Scope note (CDR-022): the full six-state machine is defined here so every illegal transition is rejected from
// day one, but ACBP-P2-001 only implements the `not_started→in_progress` and `in_progress⇄waiting_for_user`
// operations. The `ready_for_review`/`confirmed`/`superseded` transitions are legal, guarded members of the
// machine whose EFFECTS (understanding generation, owner confirmation, correction) belong to later M2/M3
// tickets. The state set itself is fully decided now (unlike company lifecycle's deferred deactivate/delete).

/**
 * The CLOSED, canonical interview session states (WORKFLOW-STATE-MACHINES §2, verbatim set). Order is the
 * canonical lifecycle order; it is NOT used for comparison (transitions are explicit, not ordinal).
 *
 *   not_started → in_progress ⇄ waiting_for_user → ready_for_review → confirmed ⏹ → superseded ⏹
 */
export type InterviewSessionState = 'not_started' | 'in_progress' | 'waiting_for_user' | 'ready_for_review' | 'confirmed' | 'superseded';
export const INTERVIEW_SESSION_STATES: readonly InterviewSessionState[] = ['not_started', 'in_progress', 'waiting_for_user', 'ready_for_review', 'confirmed', 'superseded'];
export function isInterviewSessionState(value: unknown): value is InterviewSessionState {
  return typeof value === 'string' && (INTERVIEW_SESSION_STATES as readonly string[]).includes(value);
}

/** The state a newly-created session is minted with (server-selected). `startInterviewSession` then performs the
 *  real `not_started → in_progress` transition — a session is never inserted directly into `in_progress`. */
export const INITIAL_INTERVIEW_SESSION_STATE: InterviewSessionState = 'not_started';

/**
 * Server-enforced legal transitions (WORKFLOW-STATE-MACHINES §2). An unlisted (from, to) pair is an illegal
 * transition and MUST be rejected + auditable. Owner ⊇ nothing is assumed — the map is exact. `superseded` is
 * fully terminal (no outgoing transition); `confirmed` produces the understanding version but may still be
 * superseded on a material correction (DISC-008).
 */
const LEGAL_TRANSITIONS: Readonly<Record<InterviewSessionState, readonly InterviewSessionState[]>> = {
  not_started: ['in_progress'],
  in_progress: ['waiting_for_user', 'ready_for_review'],
  waiting_for_user: ['in_progress'],
  ready_for_review: ['confirmed'],
  confirmed: ['superseded'],
  superseded: [],
};

/** True IFF `from → to` is a legal interview transition. Deny-by-default: unknown states yield false. */
export function isLegalInterviewTransition(from: InterviewSessionState, to: InterviewSessionState): boolean {
  const allowed = LEGAL_TRANSITIONS[from] as readonly InterviewSessionState[] | undefined;
  return allowed !== undefined && allowed.includes(to);
}

/** The legal successor states of `from` (a defensive copy; empty for a fully terminal state). */
export function legalInterviewSuccessors(from: InterviewSessionState): readonly InterviewSessionState[] {
  return [...(LEGAL_TRANSITIONS[from] ?? [])];
}

/**
 * A session is OPEN while it is not `superseded` (the cardinality the DB enforces: at most one open session per
 * company — CDR-022 §5). `superseded` is the only state that permanently retires a session; `confirmed` is a
 * resting terminal that is still the company's current session until a correction supersedes it.
 */
export function isOpenInterviewState(state: InterviewSessionState): boolean {
  return state !== 'superseded';
}

/** Fully terminal states (no outgoing transition). Only `superseded` qualifies; `confirmed` can still supersede. */
export function isTerminalInterviewState(state: InterviewSessionState): boolean {
  return legalInterviewSuccessors(state).length === 0;
}

/**
 * Honest display projection (DISC-007 "progress indicator is honest"; COMP-008 precedent). Maps the raw state
 * to a client-facing phase; an unrecognized value renders as `'unknown'` — NEVER a fabricated healthy phase.
 * Takes `unknown` on purpose: it is the honest projection at the read boundary.
 */
export type InterviewDisplayPhase = 'not_started' | 'in_progress' | 'awaiting_input' | 'in_review' | 'confirmed' | 'superseded' | 'unknown';
export function toInterviewDisplayPhase(state: unknown): InterviewDisplayPhase {
  switch (state) {
    case 'not_started':
      return 'not_started';
    case 'in_progress':
      return 'in_progress';
    case 'waiting_for_user':
      return 'awaiting_input';
    case 'ready_for_review':
      return 'in_review';
    case 'confirmed':
      return 'confirmed';
    case 'superseded':
      return 'superseded';
    default:
      return 'unknown';
  }
}

/**
 * The redacted, client-facing interview session view (CDR-022 §5). Exposes ONLY approved fields — no accountId,
 * actor/membership ids, internal SQL errors, stack traces, or secrets. Timestamps are ISO-8601 strings.
 */
export interface InterviewSessionDTO {
  readonly sessionId: string;
  readonly companyId: string;
  readonly state: InterviewSessionState;
  /** Honest display phase derived from `state`. */
  readonly phase: InterviewDisplayPhase;
  /** Set when the session first entered `in_progress`; null while still `not_started`. */
  readonly startedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
