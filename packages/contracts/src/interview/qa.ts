// @acbp/contracts — provider-neutral question & answer persistence contract (ACBP-P2-002; CDR-023; DISC-008
// persistence; DATA-ARCHITECTURE Question/Answer). Transport- and provider-neutral; zero-dependency.
//
// Defines WHAT a persisted question/answer is at the contract level: the closed answer-status set, the bounded
// content validation, the redacted client DTOs, and the pure helpers that resolve the current answer + derive a
// question's lifecycle from the append-only revision rows. It knows nothing about storage (append-only rows,
// CompanyScope) — that lives in @acbp/database / @acbp/core.
//
// Scope note (CDR-023): a question is IMMUTABLE (DATA-ARCHITECTURE Question `I`); its `answered/skipped`
// lifecycle is DERIVED from the answers, never a mutable column. An answer is APPEND-ONLY (`A`): a revision is a
// NEW row, and the current answer is the highest revision per question. This module owns the pure derivations.
import { validationError } from '../errors.js';
import type { PublicErrorEnvelope } from '../errors.js';

/** The closed answer statuses. `skipped` is the "I don't know" path — a skip records no founder content. */
export type AnswerStatus = 'answered' | 'skipped';
export const ANSWER_STATUSES: readonly AnswerStatus[] = ['answered', 'skipped'];
export function isAnswerStatus(value: unknown): value is AnswerStatus {
  return typeof value === 'string' && (ANSWER_STATUSES as readonly string[]).includes(value);
}

/** Bounds for founder answer content (data minimization; the store is not a document body). */
export const ANSWER_CONTENT_MAX = 10_000;
export const QUESTION_PROMPT_MAX = 4_000;

/**
 * Validate a caller answer submission (pure). An `answered` submission carries non-empty, bounded content; a
 * `skipped` submission carries NO content. Returns the normalized shape or a bounded validation envelope — the
 * persistence layer must reject anything that fails here. Content is NOT trimmed (founder text is verbatim);
 * emptiness is checked on the raw string.
 */
export type AnswerSubmission = { readonly status: 'answered'; readonly content: string } | { readonly status: 'skipped'; readonly content: null };
export function validateAnswerSubmission(input: { status: unknown; content?: unknown }): { readonly ok: true; readonly value: AnswerSubmission } | { readonly ok: false; readonly error: PublicErrorEnvelope } {
  if (!isAnswerStatus(input.status)) {
    return { ok: false, error: validationError({ message: 'Answer status is invalid.', fields: ['status'] }).toPublic() };
  }
  if (input.status === 'skipped') {
    if (input.content !== undefined && input.content !== null) {
      return { ok: false, error: validationError({ message: 'A skipped answer carries no content.', fields: ['content'] }).toPublic() };
    }
    return { ok: true, value: { status: 'skipped', content: null } };
  }
  // answered
  if (typeof input.content !== 'string' || input.content.length === 0) {
    return { ok: false, error: validationError({ message: 'An answer requires non-empty content.', fields: ['content'] }).toPublic() };
  }
  if (input.content.length > ANSWER_CONTENT_MAX) {
    return { ok: false, error: validationError({ message: 'Answer content is too long.', fields: ['content'] }).toPublic() };
  }
  return { ok: true, value: { status: 'answered', content: input.content } };
}

// ── Redacted client DTOs (CDR-023 §3). No accountId, actor ids, or internal detail. ─────────────────────────

export interface QuestionDTO {
  readonly questionId: string;
  readonly position: number;
  readonly prompt: string;
  readonly createdAt: string;
}

export interface AnswerDTO {
  readonly questionId: string;
  readonly revision: number;
  readonly status: AnswerStatus;
  /** NULL iff `skipped`. */
  readonly content: string | null;
  readonly createdAt: string;
}

/** A question's derived lifecycle (DATA-ARCHITECTURE `asked → answered/skipped`). */
export type QuestionLifecycle = 'asked' | 'answered' | 'skipped';

export interface QuestionWithAnswerDTO {
  readonly question: QuestionDTO;
  /** The highest-revision answer, or null when the question has never been answered. */
  readonly currentAnswer: AnswerDTO | null;
  /** The full append-only revision history, ascending by revision. */
  readonly revisions: readonly AnswerDTO[];
  /** Derived from `currentAnswer` (never a stored column — the question row is immutable). */
  readonly lifecycle: QuestionLifecycle;
}

export interface SessionQADTO {
  readonly sessionId: string;
  /** Questions in `position` order, each with its current answer + history. */
  readonly items: readonly QuestionWithAnswerDTO[];
}

// ── Pure derivations over the append-only revision rows ─────────────────────────────────────────────────────

/** The minimal revision shape the derivations need (a subset of the DB row / DTO). */
export interface RevisionLike {
  readonly revision: number;
}

/** The current answer = the highest revision, or null for an empty set. Input order is untrusted. */
export function currentRevision<T extends RevisionLike>(revisions: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of revisions) {
    if (best === null || r.revision > best.revision) best = r;
  }
  return best;
}

/** The next revision number to assign (max + 1, or 1 for the first answer). */
export function nextRevision(revisions: readonly RevisionLike[]): number {
  const cur = currentRevision(revisions);
  return cur === null ? 1 : cur.revision + 1;
}

/** Derive a question's lifecycle from its current answer (null = still `asked`). */
export function deriveQuestionLifecycle(current: { readonly status: AnswerStatus } | null): QuestionLifecycle {
  if (current === null) return 'asked';
  return current.status === 'skipped' ? 'skipped' : 'answered';
}

/**
 * True IFF a new submission is IDENTICAL to the current answer (same status + content) — the persistence layer
 * treats this as an idempotent no-op (no new revision), satisfying "answer submission idempotent per question"
 * without an idempotency-token column. A skip re-submitted over a skip is identical; an answer with the same
 * content is identical; a different status or different content is a genuine revision.
 */
export function isSameAnswer(current: { readonly status: AnswerStatus; readonly content: string | null } | null, submission: AnswerSubmission): boolean {
  if (current === null) return false;
  return current.status === submission.status && current.content === submission.content;
}
