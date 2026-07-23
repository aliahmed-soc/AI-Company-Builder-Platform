// @acbp/contracts — provider-neutral workspace-provisioning contract (ACBP-P1-012; CDR-018; COMP-002/003).
//
// Workspace provisioning is the INTERNAL-POSTGRES-ONLY, checkpointed sequence that takes a newly created company
// from `draft` through `onboarding` to `active`. This module defines WHAT provisioning is at the contract level:
// the closed ordered step set, the durable step statuses (a `running` state is NEVER committed — CDR-018 §4),
// the bounded attempt cap, the closed result/failure codes, the workspace-area registry set, and the redacted
// client DTOs. It deliberately knows nothing about execution (fresh CompanyScope transactions, request-driven
// sequencing) — that lives in @acbp/core. Zero-dependency, pure ECMAScript.

/** The CLOSED, ORDERED set of canonical provisioning steps (CDR-018 §2; diagram 03). Order is load-bearing. */
export const PROVISIONING_STEPS = ['profile', 'mission_draft', 'research', 'roadmap', 'documents', 'activity'] as const;
export type ProvisioningStepName = (typeof PROVISIONING_STEPS)[number];
export function isProvisioningStepName(value: unknown): value is ProvisioningStepName {
  return typeof value === 'string' && (PROVISIONING_STEPS as readonly string[]).includes(value);
}

/** 1-based canonical order of a step (matches `provisioning_steps.step_order` and the execution sequence). */
export function provisioningStepOrder(step: ProvisioningStepName): number {
  return PROVISIONING_STEPS.indexOf(step) + 1;
}

/**
 * DURABLE step statuses (CDR-018 §4). `running` is intentionally ABSENT: an in-flight step is a request-local
 * notion that must never survive a commit — the durable row moves pending → completed | failed atomically with
 * the step's material effect, so no lease/heartbeat machinery is ever needed.
 */
export const PROVISIONING_STEP_STATUSES = ['pending', 'completed', 'failed'] as const;
export type ProvisioningStepStatus = (typeof PROVISIONING_STEP_STATUSES)[number];
export function isProvisioningStepStatus(value: unknown): value is ProvisioningStepStatus {
  return typeof value === 'string' && (PROVISIONING_STEP_STATUSES as readonly string[]).includes(value);
}

/** Maximum TOTAL committed attempts per step, including the first (CDR-018 §5). */
export const MAX_PROVISIONING_ATTEMPTS = 3;

/**
 * The CLOSED workspace-area registry set (CDR-018 §6): the four steps that CREATE a minimal
 * `company_workspace_areas` row. `profile` and `activity` are VERIFICATION steps — they create no area row
 * (their artifacts already exist from the P1-010 bootstrap / P1-009 projection).
 */
export const WORKSPACE_AREAS = ['mission_draft', 'research', 'roadmap', 'documents'] as const;
export type WorkspaceArea = (typeof WORKSPACE_AREAS)[number];
export function isWorkspaceArea(value: unknown): value is WorkspaceArea {
  return typeof value === 'string' && (WORKSPACE_AREAS as readonly string[]).includes(value);
}

/** The CLOSED per-step SUCCESS result codes (audit `result_code`; CDR-018 §6 — never free text). */
export const PROVISIONING_RESULT_CODES: Readonly<Record<ProvisioningStepName, string>> = {
  profile: 'profile_verified',
  mission_draft: 'mission_area_ready',
  research: 'research_area_ready',
  roadmap: 'roadmap_area_ready',
  documents: 'document_area_ready',
  activity: 'activity_stream_verified',
};

/**
 * The CLOSED, BOUNDED failure codes (CDR-018 §4/§8). A failure message is NEVER part of the public DTO or the
 * audit payload — only one of these codes. `profile_missing` / `activity_projection_missing` are the controlled
 * verification failures; `internal_error` is the bounded catch-all for a controlled step failure that is not a
 * specific missing-artifact case (never carries exception/SQL detail).
 */
export const PROVISIONING_FAILURE_CODES = ['profile_missing', 'activity_projection_missing', 'internal_error'] as const;
export type ProvisioningFailureCode = (typeof PROVISIONING_FAILURE_CODES)[number];
export function isProvisioningFailureCode(value: unknown): value is ProvisioningFailureCode {
  return typeof value === 'string' && (PROVISIONING_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The redacted, client-facing per-step view (CDR-018 §12). Exposes ONLY the approved fields — no accountId,
 * actor/membership ids, internal SQL errors, stack traces, free-form failure text, audit correlation internals,
 * provider identifiers (none exist), or secrets.
 */
export interface ProvisioningStepDTO {
  readonly step: ProvisioningStepName;
  readonly order: number;
  readonly status: ProvisioningStepStatus;
  readonly attempt: number;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly failureCode: ProvisioningFailureCode | null;
}

/** The redacted, client-facing provisioning status (ordered six-step view + derived flags). */
export interface ProvisioningStatusDTO {
  readonly companyId: string;
  /** Truthful company lifecycle status at read time ('draft' | 'onboarding' | 'active' | 'paused'). */
  readonly companyStatus: string;
  /** All six steps in canonical order. */
  readonly steps: readonly ProvisioningStepDTO[];
  /** The first step (canonical order) not yet completed, or null when all are completed. */
  readonly nextIncompleteStep: ProvisioningStepName | null;
  /** True IFF resume can make progress: not completed and not blocked by an exhausted step. */
  readonly resumable: boolean;
  /** True IFF the sequence is halted by a step that failed at the attempt cap (resume performs no mutation). */
  readonly exhausted: boolean;
  /** True IFF all six steps are completed. */
  readonly completed: boolean;
}

/** The minimal durable-step shape the derivations below need (a subset of the DB row / DTO). */
export interface ProvisioningStepLike {
  readonly step: ProvisioningStepName;
  readonly status: ProvisioningStepStatus;
  readonly attempt: number;
}

/** Sort steps into canonical execution order (pure; input order is untrusted). */
export function sortProvisioningSteps<T extends ProvisioningStepLike>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => provisioningStepOrder(a.step) - provisioningStepOrder(b.step));
}

/** The first step (canonical order) whose status is not `completed`, or null when all six are completed. */
export function nextIncompleteProvisioningStep(steps: readonly ProvisioningStepLike[]): ProvisioningStepName | null {
  for (const s of sortProvisioningSteps(steps)) {
    if (s.status !== 'completed') return s.step;
  }
  return null;
}

/** True IFF this step is failed AT (or beyond, defensively) the attempt cap — no further attempts permitted. */
export function isProvisioningStepExhausted(step: ProvisioningStepLike): boolean {
  return step.status === 'failed' && step.attempt >= MAX_PROVISIONING_ATTEMPTS;
}

/**
 * Derive the honest status flags from the six durable step rows (pure; CDR-018 §7/§12):
 *  - `completed`  — every step is `completed` (the all-six activation gate);
 *  - `exhausted`  — the sequence is HALTED: the first incomplete step is failed at the attempt cap;
 *  - `resumable`  — resume can make progress (`!completed && !exhausted`).
 * A partial/malformed set (≠ 6 steps or duplicates) is a data inconsistency: fail closed — not completed, not
 * resumable (callers surface a safe error rather than fabricating progress).
 */
export function deriveProvisioningFlags(steps: readonly ProvisioningStepLike[]): { completed: boolean; exhausted: boolean; resumable: boolean; nextIncompleteStep: ProvisioningStepName | null } {
  const names = new Set(steps.map((s) => s.step));
  if (steps.length !== PROVISIONING_STEPS.length || names.size !== PROVISIONING_STEPS.length) {
    return { completed: false, exhausted: false, resumable: false, nextIncompleteStep: null };
  }
  const ordered = sortProvisioningSteps(steps);
  const next = nextIncompleteProvisioningStep(ordered);
  if (next === null) return { completed: true, exhausted: false, resumable: false, nextIncompleteStep: null };
  const nextRow = ordered.find((s) => s.step === next);
  const exhausted = nextRow !== undefined && isProvisioningStepExhausted(nextRow);
  return { completed: false, exhausted, resumable: !exhausted, nextIncompleteStep: next };
}
