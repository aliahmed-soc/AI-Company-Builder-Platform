/*
 * ACBP-FE-005 — mapping the provisioning read into something the progress screen can render.
 *
 * PURE, like `portfolio-view.ts` and `company-view.ts`: DTO in, discriminated view out. The page cannot be
 * rendered in a test in this environment, so every state a founder can land on has to be reachable here or it
 * is unverified.
 *
 * THREE CONTRACT FACTS SHAPE THIS FILE MORE THAN ANY DESIGN CHOICE DID.
 *
 * 1. THERE IS NO `running` STEP STATUS, AND THAT IS DELIBERATE. `PROVISIONING_STEP_STATUSES` is
 *    `pending | completed | failed` and the contract says `running` is "intentionally ABSENT: an in-flight step
 *    is a request-local notion that must never survive a commit" (provisioning.ts:22-27). So this view NEVER
 *    reports a step as in-progress. The familiar stepper-with-a-spinner would be drawing a state the system
 *    refuses to persist — it would look more informative and be less true.
 *
 * 2. THE FOUR ARMS ARE THE CONTRACT'S OWN, not a shape invented here. `deriveProvisioningFlags`
 *    (provisioning.ts:137-148) makes them mutually exclusive and exhaustive: `completed` implies neither other
 *    flag (:144); when not completed, `resumable === !exhausted` (:147); and all three false happens IFF the
 *    step set is malformed — wrong count or duplicates (:139-141), which the contract calls a data
 *    inconsistency whose callers must "surface a safe error rather than fabricating progress".
 *
 * 3. FAILURE DETAIL IS A CLOSED CODE, NEVER TEXT. `PROVISIONING_FAILURE_CODES` is
 *    `profile_missing | activity_projection_missing | internal_error` (:63) and the contract states a failure
 *    message "is NEVER part of the public DTO". The screen shows the code; it must not dress it up as a
 *    sentence that implies detail the server withheld.
 */
import { MAX_PROVISIONING_ATTEMPTS, type ProvisioningStatusDTO, type ProvisioningStepDTO } from '@acbp/contracts';

/** Presentation tone only. Never replaces the server's status word — the same rule the portfolio card follows. */
export type StepTone = 'done' | 'waiting' | 'failed' | 'unknown';

export interface StepView {
  /** The server's token, untouched (`mission_draft`). Kept so assertions and copy can cite what was sent. */
  readonly step: string;
  /** A human rendering DERIVED from the token by a fixed rule — never a hand-written table that could drift. */
  readonly label: string;
  readonly order: number;
  /** The server's status word, verbatim. */
  readonly status: string;
  readonly tone: StepTone;
  /** Committed attempts. 0 while pending; 1..3 after outcomes (schema.ts:281-282). */
  readonly attempt: number;
  /** Only ever one of the closed failure codes, or null. Never free text. */
  readonly failureCode: string | null;
  /** True when this step has used the attempt cap and no further attempt is permitted. */
  readonly atAttemptCap: boolean;
}

export type ProvisioningView =
  | { readonly kind: 'complete'; readonly companyStatus: string; readonly steps: readonly StepView[] }
  | {
      readonly kind: 'resumable';
      readonly companyStatus: string;
      readonly steps: readonly StepView[];
      /** The step the server says is next. Present on this arm by construction. */
      readonly nextStep: string;
      readonly nextStepLabel: string;
      /** How many of the six are done — DERIVED here because the payload carries no progress count. */
      readonly completedCount: number;
      readonly totalCount: number;
    }
  | {
      readonly kind: 'exhausted';
      readonly companyStatus: string;
      readonly steps: readonly StepView[];
      readonly blockedStep: string;
      readonly blockedStepLabel: string;
      readonly failureCode: string | null;
      readonly attempts: number;
      readonly maxAttempts: number;
    }
  | { readonly kind: 'inconsistent'; readonly companyStatus: string; readonly steps: readonly StepView[]; readonly detail: string };

function toneFor(status: string): StepTone {
  switch (status) {
    case 'completed':
      return 'done';
    case 'pending':
      return 'waiting';
    case 'failed':
      return 'failed';
    default:
      // A status outside the closed set is styled as unknown rather than guessed at — the portfolio's rule.
      return 'unknown';
  }
}

/**
 * `mission_draft` -> `Mission draft`. A DERIVATION, not a lookup table: a table would have to be edited every
 * time the closed step set changes and would silently render a stale label (or nothing) until someone noticed.
 * The raw token is kept alongside it in `step`, so nothing depends on this being pretty.
 */
function labelFor(step: string): string {
  const spaced = step.replace(/_/g, ' ');
  return spaced.length === 0 ? step : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function toStepView(s: ProvisioningStepDTO): StepView {
  return {
    step: s.step,
    label: labelFor(s.step),
    order: s.order,
    status: s.status,
    tone: toneFor(s.status),
    attempt: s.attempt,
    failureCode: s.failureCode,
    atAttemptCap: s.status === 'failed' && s.attempt >= MAX_PROVISIONING_ATTEMPTS,
  };
}

/**
 * Map the provisioning read into the view the screen renders.
 *
 * The flags are TRUSTED as the server's own derivation rather than recomputed from `steps` here. Recomputing
 * would create a second opinion about provisioning state that could disagree with the one the resume endpoint
 * actually enforces — and when they disagreed, the screen would be confidently wrong. The steps are rendered;
 * the flags decide the arm.
 */
export function toProvisioningView(dto: ProvisioningStatusDTO): ProvisioningView {
  const steps = [...dto.steps].sort((a, b) => a.order - b.order).map(toStepView);
  const companyStatus = dto.companyStatus;

  if (dto.completed) return { kind: 'complete', companyStatus, steps };

  if (dto.exhausted) {
    // The halted step is the first incomplete one; the server names it in `nextIncompleteStep`.
    const blocked = steps.find((s) => s.step === dto.nextIncompleteStep) ?? steps.find((s) => s.tone === 'failed');
    return {
      kind: 'exhausted',
      companyStatus,
      steps,
      blockedStep: blocked?.step ?? '',
      blockedStepLabel: blocked === undefined ? '' : blocked.label,
      failureCode: blocked?.failureCode ?? null,
      attempts: blocked?.attempt ?? 0,
      maxAttempts: MAX_PROVISIONING_ATTEMPTS,
    };
  }

  if (dto.resumable && dto.nextIncompleteStep !== null) {
    return {
      kind: 'resumable',
      companyStatus,
      steps,
      nextStep: dto.nextIncompleteStep,
      nextStepLabel: labelFor(dto.nextIncompleteStep),
      completedCount: steps.filter((s) => s.status === 'completed').length,
      totalCount: steps.length,
    };
  }

  // ALL THREE FLAGS FALSE. Per `deriveProvisioningFlags` (:139-141) this means the durable step set is
  // malformed — not six rows, or duplicates — which the contract classes as a data inconsistency. Resume on
  // this state returns 409, so the screen must NOT offer it as though it might work.
  return {
    kind: 'inconsistent',
    companyStatus,
    steps,
    detail:
      'The server reports this provisioning run as neither finished, resumable, nor stopped at its attempt limit. That combination means the stored step record is incomplete rather than that work is under way, so there is nothing to resume here and an operator has to look at it.',
  };
}
