// @acbp/contracts — the worker runtime's decisions (ACBP-P5-005; CDR-057; NFR-015; WORK-006). Zero-dep and PURE:
// the clock is a PARAMETER (`elapsedMs`), never read here, so every budget decision is reproducible.
//
// NFR-015 is unusually precise — *"a runaway task cannot exceed its budget by more than ONE BILLING INCREMENT"* — and
// that sentence is about WHEN the check happens. Admitting a step only while headroom remains bounds the overshoot to
// the single call that crossed the line. Checking after the fact would bound nothing: one expensive call could land
// arbitrarily far past the cap and only then be noticed.
import { DEFAULT_MAX_SPEND_MICROS, DEFAULT_MAX_DURATION_MS } from './worker.js';

export { DEFAULT_MAX_SPEND_MICROS, DEFAULT_MAX_DURATION_MS };

/** CLOSED. What a worker run is doing, or how it ended. */
export const WORKER_RUN_OUTCOMES = ['running', 'succeeded', 'failed', 'stopped'] as const;
export type WorkerRunOutcome = (typeof WORKER_RUN_OUTCOMES)[number];

export function isWorkerRunOutcome(value: unknown): value is WorkerRunOutcome {
  return typeof value === 'string' && (WORKER_RUN_OUTCOMES as readonly string[]).includes(value);
}

/** `stopped` is terminal: an owner's safe-stop ends the run as surely as a failure does, without being one. */
export function isTerminalWorkerRunOutcome(value: unknown): boolean {
  return value === 'succeeded' || value === 'failed' || value === 'stopped';
}

/** Why a run was halted before its work was done. A REASON, never a message. */
export type HaltReason = 'budget_exhausted' | 'duration_exceeded' | 'bounds_unreadable';

export interface StepAdmissionInput {
  readonly maxSpendMicros: number;
  readonly maxDurationMs: number;
  readonly spentMicros: number;
  readonly elapsedMs: number;
  /** Set by P5-002's `cancelRun`. The worker learns of it at its next checkpoint — which is here. */
  readonly stopRequested: boolean;
}

export type StepAdmission =
  | { readonly kind: 'proceed' }
  // The owner asked. NOT a failure: the run did what it was told, and reporting it as failed would make a deliberate
  // intervention look like a malfunction in every count of failures.
  | { readonly kind: 'stop' }
  | { readonly kind: 'halt'; readonly reason: HaltReason; readonly failureCategory: 'policy_blocked' | 'timeout' | 'internal_error' };

/** A bound or a counter must be a finite, non-negative number. A cap we cannot read is not an absent cap. */
function usable(value: unknown, allowZero: boolean): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (allowZero ? value >= 0 : value > 0);
}

/**
 * May the runtime execute one more step?
 *
 * TOTAL and FAIL-CLOSED. An unreadable bound or counter halts rather than admitting an unbounded run — an absent cap
 * must never read as "no limit", because a run whose bounds cannot be determined is exactly the runaway NFR-015 exists
 * to stop.
 *
 * ORDER MATTERS. The stop request is checked first because an owner's request outranks every automatic rule and is not
 * a failure. Budget is reported before duration when both are breached, because it names the cheaper thing to fix.
 */
export function decideStepAdmission(input: StepAdmissionInput): StepAdmission {
  if (input.stopRequested === true) return { kind: 'stop' };

  if (!usable(input.maxSpendMicros, false) || !usable(input.maxDurationMs, false) || !usable(input.spentMicros, true) || !usable(input.elapsedMs, true)) {
    return { kind: 'halt', reason: 'bounds_unreadable', failureCategory: 'internal_error' };
  }

  // `>=`, not `>`: at exactly the cap there is no headroom left, and admitting one more call would spend past it.
  if (input.spentMicros >= input.maxSpendMicros) return { kind: 'halt', reason: 'budget_exhausted', failureCategory: 'policy_blocked' };
  if (input.elapsedMs >= input.maxDurationMs) return { kind: 'halt', reason: 'duration_exceeded', failureCategory: 'timeout' };
  return { kind: 'proceed' };
}
