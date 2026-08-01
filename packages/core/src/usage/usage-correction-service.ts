// @acbp/core — compensating usage corrections (ACBP-P6-009; CDR-073 §1-G9/G10; trust-critical #13).
//
// Canon, verbatim: **"Usage corrections create compensating records (never edits)."**
//
// "NEVER EDITS" IS NOT ENFORCED BY THIS FILE, AND SAYING SO IS THE POINT. There is no update path here because
// there is no UPDATE or DELETE grant on `usage_corrections` (migration 0051) or `usage_events` (migration 0017,
// where that ledger's append-only grants were set) at all, and
// `UsageCorrectionRepository` exposes only `insert`. A future caller cannot edit recorded usage by being careless;
// it would have to be granted a privilege that does not exist. That is what makes the clause structural rather
// than conventional.
//
// The three bounds that keep a correction honest live in the TABLE, not here, for the same reason:
//   - every delta `<= 0` (CHECK)          — a correction may only ever REDUCE recorded usage (§1-G10a)
//   - magnitude <= the corrected event    — a trigger, because a CHECK cannot see another row (§1-G10)
//   - at most ONE correction per event    — a unique index (§1-G10b)
// This service's job is authorization, scope, attribution and the audit record.
import { isAllowed, isPlatformError, usageCorrected } from '@acbp/contracts';
import {
  UsageCorrectionRepository,
  elevateToCompanyScope,
  resolveOwnMembershipBootstrap,
  writeAuditEvent,
  type DatabaseClient,
} from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { isMemberRole } from '../members/roles.js';
import type { AccountAccessDenialReason } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

/** The maximum length of the owner's free-text justification. Bounded because it is caller-supplied. */
const REASON_MAX = 500;

/** The floor of PostgreSQL `integer`, which is what the four delta columns are (migration 0051). */
const INT4_MIN = -2_147_483_648;

export interface RecordUsageCorrectionParams {
  /** Server-verified internal user id (from the identity boundary). NEVER a browser claim. */
  readonly userId: string;
  readonly accountId: string;
  /**
   * The company owning the corrected event. REQUIRED, and not derivable here: `usage_events` is dual-keyed, so
   * under an account scope with no company GUC the event is invisible. Supplying the wrong one does not
   * mis-attribute anything — the event simply will not be found in that company's slice.
   */
  readonly companyId: string;
  readonly correctsUsageEventId: string;
  /** Per-lane signed deltas, each `<= 0`. Unvalidated here on purpose: refusing bad input is this function's job. */
  readonly eventCountDelta: unknown;
  readonly inputTokensDelta: unknown;
  readonly outputTokensDelta: unknown;
  readonly estimatedCostMicrosDelta: unknown;
  /** Why. Required and non-blank — an unexplained adjustment to a billing figure is not an audit trail. */
  readonly reason: unknown;
}

export interface RecordUsageCorrectionOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

export type RecordUsageCorrectionResult =
  | { readonly status: 'ok'; readonly correctionId: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'denied'; readonly reason: AccountAccessDenialReason }
  /** The company is not in this account, or the caller's account scope could not reach it. */
  | { readonly status: 'company_not_found' }
  /** No such event in that company. RLS-confined, so another tenant's event reads as ABSENT, never as forbidden. */
  | { readonly status: 'usage_event_not_found' }
  | { readonly status: 'invalid_delta' }
  | { readonly status: 'invalid_reason' }
  /** This event already has a correction (§1-G10b). The first one stands; a second is an escalation, not a retry. */
  | { readonly status: 'already_corrected' }
  /** A bound the table enforces was violated — most often a delta larger than the event it corrects (§1-G10). */
  | { readonly status: 'exceeds_original' };

/**
 * Append one compensating entry against a recorded usage event.
 *
 * OWNER-ONLY, at the ACCOUNT level (`usage:correct`). A correction moves a billing-relevant figure, so it is
 * deliberately a different action from reading usage and is checked against the caller's ACCOUNT-membership role
 * — the `readCreditLedger` precedent, whose review found that checking a COMPANY role for an account-level fact
 * hands account-wide authority to someone who only has it in one company.
 *
 * ONE TRANSACTION. The correction row and its audit event commit or roll back together, so a recorded adjustment
 * with no audit trail is not reachable — the same rule the credit ledger follows.
 */
export async function recordUsageCorrection(
  client: DatabaseClient,
  params: RecordUsageCorrectionParams,
  options: RecordUsageCorrectionOptions = {},
): Promise<RecordUsageCorrectionResult> {
  const deltas = readDeltas(params);
  if (deltas === null) return { status: 'invalid_delta' };
  const reason = readReason(params.reason);
  if (reason === null) return { status: 'invalid_reason' };
  const audit = options.auditWriter ?? writeAuditEvent;

  const run = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (scope): Promise<RecordUsageCorrectionResult> => {
      const own = await resolveOwnMembershipBootstrap(scope.db, params.userId, params.accountId);
      const role = own !== null && isMemberRole(own.role) ? own.role : null;
      // `!isAllowed(...)`, not `.kind === 'deny'`. Both are correct against today's closed two-variant
      // `AuthzDecision`, but only the first stays deny-by-default if a third variant is ever added: "is not an
      // allow" refuses the unknown case, "is a deny" falls through to permitting it.
      if (!isAllowed(checkAuthorization(role, 'usage:correct', { accountId: params.accountId, actorId: params.userId }, authzOpts(options)))) {
        return { status: 'forbidden' };
      }

      // Elevate into the company owning the event. `elevateToCompanyScope` verifies the company belongs to the
      // caller's ACCOUNT via the account-scoped `companies` policy and fails closed when it does not — so a
      // company id belonging to another account cannot be used to reach into it.
      // `elevateToCompanyScope` throws a `not_found` PlatformError when the company is not visible under this
      // account (fail-closed). ONLY that is a refusal. It also issues two live statements — a `companies` select
      // and a `set_config` — and a connection reset, statement timeout or GUC misconfiguration on either throws
      // too. A bare `catch` would report an outage to the owner as "that company id is wrong", which is the same
      // swallow-everything defect `classifyCorrectionFailure` returns `null` to avoid a few lines below.
      let companyScope;
      try {
        companyScope = await elevateToCompanyScope(scope, params.companyId);
      } catch (error: unknown) {
        if (isPlatformError(error) && error.category === 'not_found') return { status: 'company_not_found' };
        throw error;
      }

      // THE EVENT MUST EXIST, IN THIS COMPANY. Checked before the insert so the common mistake gets a typed
      // refusal rather than a foreign-key error, and RLS-confined so a foreign event reads as ABSENT — a refusal
      // that distinguished "not yours" from "does not exist" would confirm the row exists to someone who may not
      // see it.
      const event = await companyScope.db
        .selectFrom('usage_events')
        .select('id')
        .where('id', '=', params.correctsUsageEventId)
        .executeTakeFirst();
      if (event === undefined) return { status: 'usage_event_not_found' };

      let correction;
      try {
        correction = await new UsageCorrectionRepository(companyScope.db).insert({
          accountId: params.accountId,
          companyId: params.companyId,
          correctsUsageEventId: params.correctsUsageEventId,
          eventCountDelta: deltas.eventCountDelta,
          inputTokensDelta: deltas.inputTokensDelta,
          outputTokensDelta: deltas.outputTokensDelta,
          estimatedCostMicrosDelta: deltas.estimatedCostMicrosDelta,
          reason,
          createdByUserId: params.userId,
        });
      } catch (error: unknown) {
        // Map the table's own guards onto typed refusals. THROWN, never returned as a value after a partial
        // write: a typed refusal returned from inside the scope helper would COMMIT the transaction, which is
        // the defect already recorded for scope helpers elsewhere in this codebase. Here the insert is the only
        // write and it failed, so returning is safe — but the classification below must not swallow anything it
        // does not recognise, or a real fault would read as a clean refusal.
        const refusal = classifyCorrectionFailure(error);
        if (refusal === null) throw error;
        return { status: refusal };
      }

      await audit(
        companyScope,
        usageCorrected({
          correctionId: correction.id,
          correctsUsageEventId: params.correctsUsageEventId,
          eventCountDelta: deltas.eventCountDelta,
          inputTokensDelta: deltas.inputTokensDelta,
          outputTokensDelta: deltas.outputTokensDelta,
          estimatedCostMicrosDelta: deltas.estimatedCostMicrosDelta,
          hasReason: true,
        }),
        options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
      );
      return { status: 'ok', correctionId: correction.id };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  if (run.kind === 'denied') return { status: 'denied', reason: run.reason };
  return run.value;
}

/**
 * Which of the table's guards refused, or `null` when the error is not one this function recognises.
 *
 * PINNED TO SQLSTATE, NOT TO MESSAGE TEXT. Constraint names and provider messages are sanitized before they reach
 * callers in this codebase, so matching on them would be matching on something that is not there. `23505` is the
 * one-correction-per-event unique index (§1-G10b).
 *
 * ⚠️ `23514` IS ONE-TO-MANY AND `exceeds_original` NAMES ONLY ITS COMMONEST CAUSE. Migration 0051's trigger
 * raises a check violation for five conditions — the per-lane magnitude bound, the event not being visible in
 * scope, the event belonging to another account, retracting more than one event, plus the table's own
 * non-positive/not-empty/reason-length CHECKs. SQLSTATE alone cannot tell them apart. The non-magnitude
 * conditions are unreachable on this path today because the deltas are validated before the insert and the event
 * is looked up first (a foreign event returns `usage_event_not_found`), which is what keeps the label honest —
 * NOT the code distinguishing them. Relaxing either of those pre-checks would start reporting other refusals as
 * `exceeds_original`, and the trigger would need distinct error codes before that happened.
 *
 * Returning `null` rather than a catch-all refusal is the load-bearing part: an unrecognised failure must
 * propagate, or a genuine fault would be reported to the caller as an ordinary, expected refusal.
 */
function classifyCorrectionFailure(error: unknown): 'already_corrected' | 'exceeds_original' | null {
  for (let e: unknown = error, depth = 0; e !== null && e !== undefined && depth < 5; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (code === '23505') return 'already_corrected';
    if (code === '23514') return 'exceeds_original';
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** All four deltas, or `null`. Each must be an integer `<= 0`, and at least one must be non-zero. */
function readDeltas(params: RecordUsageCorrectionParams): {
  readonly eventCountDelta: number;
  readonly inputTokensDelta: number;
  readonly outputTokensDelta: number;
  readonly estimatedCostMicrosDelta: number;
} | null {
  const raw = [params.eventCountDelta, params.inputTokensDelta, params.outputTokensDelta, params.estimatedCostMicrosDelta];
  // `Number.isInteger` is false for NaN and Infinity, so neither reaches the database. A NaN delta would
  // otherwise be inserted as NULL or rejected far from where it was introduced.
  //
  // THE LOWER BOUND IS NOT DECORATION. The four delta columns are `integer` (int4), so a value below
  // −2,147,483,648 is rejected by the BIND, raising `22003 numeric_value_out_of_range` — and that happens BEFORE
  // the magnitude trigger can refuse it, so `classifyCorrectionFailure` (which knows 23505 and 23514) would not
  // recognise it and the caller would get a thrown internal error where `invalid_delta` is the honest answer.
  // One branch away from a typed refusal is not close enough.
  if (!raw.every((v) => typeof v === 'number' && Number.isInteger(v) && v <= 0 && v >= INT4_MIN)) return null;
  // An all-zero correction records an adjustment that adjusts nothing, permanently consuming this event's one
  // correction slot (§1-G10b) and leaving no way to make the real one.
  if (raw.every((v) => v === 0)) return null;
  return {
    eventCountDelta: raw[0] as number,
    inputTokensDelta: raw[1] as number,
    outputTokensDelta: raw[2] as number,
    estimatedCostMicrosDelta: raw[3] as number,
  };
}

/** The trimmed reason, or `null`. Blank is refused: the reason is the audit trail for a billing adjustment. */
function readReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > REASON_MAX) return null;
  return trimmed;
}

function authzOpts(options: RecordUsageCorrectionOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
