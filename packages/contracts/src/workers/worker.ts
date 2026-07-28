// @acbp/contracts — worker definitions (ACBP-P5-004; CDR-056; WORK-001/006; ADR-012; trust-critical #4). Zero-dep.
//
// Workers are VERSIONED CONFIGURATION over one shared runtime, not independent services
// (`AI-AND-WORKER-ARCHITECTURE §2`). This module holds the parts of a definition that are DECISIONS rather than data:
// what a worker state permits, where the MVP's external-effect boundary sits, and how the approval profile is read.
import { resolveRiskClass, isAtLeastAsRestrictiveAs, isRiskClass, type RiskClass } from '../tools/risk-class.js';

/** CLOSED. WORK-006: an owner may pause or disable a worker per company. */
export const WORKER_STATES = ['enabled', 'paused', 'disabled'] as const;
export type WorkerState = (typeof WORKER_STATES)[number];

export function isWorkerState(value: unknown): value is WorkerState {
  return typeof value === 'string' && (WORKER_STATES as readonly string[]).includes(value);
}

/**
 * May this worker accept new tasks? WORK-006: *"Disabled workers receive no new tasks."*
 *
 * ONLY `enabled` does, and an unrecognised state does not — a state we cannot interpret is not permission. `paused`
 * and `disabled` differ in intent (temporary vs. off) but not in this answer, and collapsing them here keeps the
 * distinction where it belongs: in what the owner is told, not in what the platform allows.
 */
export function workerAcceptsTasks(state: unknown): boolean {
  return state === 'enabled';
}

/**
 * The most permissive class an MVP worker may hold in its allowlist.
 *
 * `AI-AND-WORKER-ARCHITECTURE §2`, verbatim: *"All three run **informational / internal-reversible risk classes
 * only** — no MVP worker has any external-effect tool in its allowlist (the MVP's zero-external-actions boundary is
 * thus **structural, not procedural**)."* This constant plus {@link isMvpSafeAllowlist} is what makes "structural"
 * true; a comment saying we will not do it would be procedural.
 */
export const MVP_MAX_ALLOWED_RISK_CLASS: RiskClass = 'internal_reversible';

export interface AllowlistEntry {
  readonly toolId: string;
  /** The registry's stored class. `unknown` on purpose — nullable at the database boundary, resolved here. */
  readonly riskClass: unknown;
}

/**
 * Does every tool in this allowlist sit at or below the MVP ceiling?
 *
 * An UNCLASSIFIED tool fails: `resolveRiskClass` maps it to the most restrictive class, which is above the ceiling.
 * That is the intended direction — a worker must not gain an external-effect capability because a registration was
 * incomplete.
 */
export function isMvpSafeAllowlist(entries: readonly AllowlistEntry[]): boolean {
  return entries.every((e) => !isAtLeastAsRestrictiveAs(e.riskClass, MVP_MAX_ALLOWED_RISK_CLASS) || resolveRiskClass(e.riskClass) === MVP_MAX_ALLOWED_RISK_CLASS);
}

/**
 * Does a call at `riskClass` need approval under this worker's profile?
 *
 * The profile is a THRESHOLD, reusing P5-003a's ordering, rather than a hand-listed set that would drift from it the
 * moment the class set is re-shaped (`CDR-051 §0.1` says it should be).
 *
 * `null` threshold means nothing is gated. An UNRECOGNISED threshold gates EVERYTHING — a typo in a definition must
 * not silently switch approval off, which is what "unknown means no threshold" would have done.
 */
export function requiresApproval(riskClass: unknown, threshold: unknown): boolean {
  if (threshold === null || threshold === undefined) return false;
  // THE THRESHOLD IS CHECKED BEFORE IT IS RESOLVED, and that order is the whole guarantee. Passing an unrecognised
  // threshold straight to `isAtLeastAsRestrictiveAs` would resolve it to the MOST restrictive class — so nothing
  // would ever meet it, and a single typo in a definition would silently switch approval off for every class. This
  // is the P5-003a `riskRank` inversion in a new place, and the test caught it before it shipped.
  if (!isRiskClass(threshold)) return true;
  return isAtLeastAsRestrictiveAs(riskClass, threshold);
}

/**
 * IOQ-12, INTERIM AND REVISIT-BOUND (CDR-056 §3). Not owner-ratified.
 *
 * There is no P2–P4 telemetry to derive these from — no live provider has ever been called — so these follow the
 * CDR-008 precedent: conservative technical values, no pricing implied, stored per definition so changing one is a
 * data change rather than a deploy.
 */
export const DEFAULT_MAX_SPEND_MICROS = 500_000;

/**
 * Ten minutes. `DEFAULT_HEARTBEAT_GRACE_MS` is 90s, so this is roughly six heartbeat windows: long enough that a
 * slow-but-live run is never killed by this bound, short enough that a wedged one surfaces the same hour.
 */
export const DEFAULT_MAX_DURATION_MS = 600_000;

/** A budget is a positive integer. Zero would mean "no work permitted", which is `disabled`, said elsewhere. */
export function isValidBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
