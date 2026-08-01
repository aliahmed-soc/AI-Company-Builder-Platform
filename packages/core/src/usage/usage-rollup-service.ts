// @acbp/core — the account usage rollup rebuild (ACBP-P6-009; CDR-073; USAGE-001 amended; trust-critical #14).
//
// THE ROLLUP IS A PROJECTION, NOT A SOURCE OF TRUTH (CDR-073 §1-G1). This function recomputes it from the
// ledger; nothing here may be read back as evidence for a billing, limit or entitlement decision. If the stored
// row and the ledger disagree, the ledger is right and the rollup is a bug.
//
// ── WHY THIS USES `elevateToCompanyScope` AND NOT `runInCompanyScope` (§1-G3) ───────────────────────────────
//
// An account rollup spans the account's companies; `usage_events` is dual-keyed and readable one company at a
// time. Every other read in this codebase resolves into a company with `runInCompanyScope`, which validates the
// ACTOR'S ACTIVE COMPANY MEMBERSHIP — and that is exactly what must not happen here. An account owner who is not
// a member of every company would then get a SMALLER TOTAL than a co-owner asking the same question about the
// same account, and neither number would look wrong. Trust-critical #14 says the account total is the
// DETERMINISTIC sum; a membership-filtered total is a per-caller view.
//
// `elevateToCompanyScope` instead verifies the company belongs to the caller's ACCOUNT (via the account-scoped
// `companies` SELECT policy, fail-closed) and consults no membership. Authorization stays where canon puts it —
// at the account level. Enforcement that the total is membership-independent is not this comment: it is
// `usage-rollup-service.integration.test.ts`'s "THE TOTAL DOES NOT DEPEND ON THE CALLER'S COMPANY MEMBERSHIPS",
// which rebuilds as an owner holding no company membership and asserts an identical, non-zero figure set.
//
// The alternative that was rejected rather than overlooked: widening the `usage_events` SELECT policy with
// `or current_company is null` so one query could sum the account. That predicate is fail-OPEN for any code path
// that forgets to set the company GUC, on a table canon marks trust-critical for tenant isolation (§1-G6).
import {
  addRollupFigures,
  emptyRollupFigures,
  isUsagePeriodStart,
  lanesExceedingThreshold,
  rollupFigureDrift,
  usageRollupReconciled,
  USAGE_ROLLUP_LANES,
  type RollupFigures,
  type UsageRollupLane,
} from '@acbp/contracts';
import {
  AccountUsageRollupRepository,
  elevateToCompanyScope,
  resolveOwnMembershipBootstrap,
  rollupRowFigures,
  writeAuditEvent,
  type AccountScope,
  type AuditWriteContext,
  type DatabaseClient,
} from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { isMemberRole } from '../members/roles.js';
import type { AccountAccessDenialReason } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

/**
 * THE LEDGER AGGREGATION, AND THE ONLY ONE (CDR-073 §1-G11).
 *
 * Both the rebuild and the reconciliation call this. That is not tidiness — it is what makes reconciliation
 * MEAN anything. If reconciliation had its own aggregation query, the two could drift apart, and the check whose
 * entire purpose is to detect a wrong number would be comparing one possibly-wrong number against a differently
 * possibly-wrong one. A drift check must recompute by the SAME path it is checking, or a shared bug is invisible
 * to it in exactly the case it exists to catch.
 *
 * Runs inside the caller's account scope and transaction, so a reconciliation reads the stored row and recomputes
 * the ledger without a concurrent rebuild slipping between the two.
 */
async function computeAccountUsageFromLedger(
  scope: AccountScope,
  periodStart: string,
): Promise<{ readonly figures: RollupFigures; readonly companyCount: number }> {
  // ENUMERATE FIRST, under the account scope with no company GUC set. `companies_select` is
  // `account_id = current_account` — the account's WHOLE registry, deliberately not membership-filtered and
  // deliberately not status-filtered: a `paused` company is a cancelled one whose history must still count
  // (BILL-006), and a status filter here would silently rewrite a past invoice (§1-G4).
  const companies = await scope.db.selectFrom('companies').select('id').orderBy('id').execute();

  let figures = emptyRollupFigures();
  // SEQUENTIAL, NEVER PARALLEL (§1-G5). `elevateToCompanyScope` issues `SET LOCAL app.current_company` on
  // this SHARED transaction, so two concurrent elevations would interleave the GUC and each read would
  // attribute to whichever company won the race — a wrong total with no error anywhere.
  for (const company of companies) {
    const companyScope = await elevateToCompanyScope(scope, company.id);
    const rollups = new AccountUsageRollupRepository(companyScope.db);
    const events = await rollups.sumCompanyUsage(periodStart);
    // Corrections are bucketed by the CORRECTED EVENT's period, not their own (§1-G10c), and are negative
    // or zero, so this is the same lane-wise addition.
    //
    // THIS SUM MUST STAY INSIDE THE LOOP. `sumCompanyCorrections` is confined to one company by its JOIN to the
    // dual-keyed `usage_events`, NOT by its own RLS — `usage_corrections` is account-keyed — which makes hoisting
    // it out look like a safe simplification. It is not: after the loop the company GUC holds whichever company
    // sorted last, so every other company's corrections silently vanish from the total.
    // ENFORCED BY: `usage-rollup-service.integration.test.ts` → "CORRECTIONS IN EVERY COMPANY REDUCE THE TOTAL",
    // verified by mutation (hoisting fails that test and only that test).
    const corrections = await rollups.sumCompanyCorrections(periodStart);
    figures = addRollupFigures(figures, addRollupFigures(events, corrections));
  }
  // THE ACCUMULATOR IS THE ONE SIDE OF THE BIGINT SEAM THE REPOSITORY CANNOT GUARD. `toRollupFigure` checks every
  // value crossing the driver, but this fold SUMS those checked values and the total can exceed what a JS number
  // represents exactly — after which it is silently imprecise and gets written to a `bigint` column as a
  // plausible-looking wrong number. Practically unreachable at real token volumes; refused rather than trusted,
  // because "unreachable" is the assumption §0 is about.
  for (const lane of USAGE_ROLLUP_LANES) {
    if (!Number.isSafeInteger(figures[lane])) {
      throw new RangeError(`account usage rollup lane ${lane} exceeds the safe integer range`);
    }
  }
  return { figures, companyCount: companies.length };
}

export interface RebuildAccountUsageRollupParams {
  /** Server-verified internal user id (from the identity boundary). NEVER a browser claim. */
  readonly userId: string;
  /** The account whose rollup is rebuilt. A SELECTOR — validated against an active account membership. */
  readonly accountId: string;
  /** `YYYY-MM-01`. Unvalidated on purpose: refusing a bad period is this function's job. */
  readonly periodStart: unknown;
}

export interface RebuildAccountUsageRollupOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type RebuildAccountUsageRollupResult =
  | {
      readonly status: 'ok';
      readonly periodStart: string;
      readonly figures: RollupFigures;
      /**
       * How many of the account's companies were summed. Reported because a total is uninterpretable without it:
       * "0" over three companies is a very different statement from "0" over none.
       */
      readonly companyCount: number;
    }
  /** An active account member who is not an OWNER. The figures are not disclosed and nothing is written. */
  | { readonly status: 'forbidden' }
  | { readonly status: 'denied'; readonly reason: AccountAccessDenialReason }
  | { readonly status: 'invalid_period' };

/**
 * Recompute one `(account, period)` rollup from the ledger and store it.
 *
 * OWNER-ONLY, VIA `usage:read` — and the distinction that makes this the right action rather than an invented one
 * is worth stating, because an earlier version of this function had NO check at all.
 *
 * TWO SEPARATE QUESTIONS were being conflated. *Who may TRIGGER a rebuild* is genuinely unruled (CDR-073 §3.2),
 * and nothing here answers it. *Whether the resulting FIGURES may be disclosed to a non-owner* is already ruled
 * by `API-CONTRACTS` — *"account rollup = account owner"* — and this function RETURNS those figures. Without the
 * check, a viewer refused by `readAccountUsageRollup` could call this instead and receive the identical numbers,
 * plus a write. That is the `readCreditLedger` review-pass-1 HIGH in a new place: the authorization is the only
 * thing between a viewer and account-wide spend, because a total that legitimately spans companies is one RLS
 * cannot narrow.
 *
 * Requiring OWNER does not foreclose §3.2. It is the most restrictive posture available, and a later ruling can
 * only narrow it further (to platform-only); registering a permissive `usage:rebuild` action now would have been
 * the choice that encoded an answer nobody gave.
 */
export async function rebuildAccountUsageRollup(
  client: DatabaseClient,
  params: RebuildAccountUsageRollupParams,
  options: RebuildAccountUsageRollupOptions = {},
): Promise<RebuildAccountUsageRollupResult> {
  // BEFORE any scope is established or any row written: a malformed period would otherwise become a real row
  // under a key that no later read could find, splitting one period in two.
  if (!isUsagePeriodStart(params.periodStart)) {
    return { status: 'invalid_period' };
  }
  const periodStart = params.periodStart;

  const run = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (scope): Promise<RebuildAccountUsageRollupResult> => {
      if (!(await callerMayReadAccountUsage(scope, params.userId, params.accountId, options))) {
        return { status: 'forbidden' };
      }
      const { figures, companyCount } = await computeAccountUsageFromLedger(scope, periodStart);
      // The rollup table is account-keyed, so this write is legal even though the company GUC still holds the
      // last company elevated into (§1-G2). The upsert REPLACES the figures rather than adding to them, which
      // is what makes a repeated rebuild idempotent instead of doubling (§1-G12).
      await new AccountUsageRollupRepository(scope.db).upsert(params.accountId, periodStart, figures);
      return { status: 'ok', periodStart, figures, companyCount };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  if (run.kind === 'denied') {
    return { status: 'denied', reason: run.reason };
  }
  return run.value;
}

/**
 * Does this caller hold `usage:read` on the account? Owner-only per `API-CONTRACTS`.
 *
 * Shared by the three functions that RETURN account figures, so the disclosure rule is written once. Resolved
 * from the caller's ACCOUNT membership — never a company role, which is the `readCreditLedger` pass-1 HIGH.
 */
async function callerMayReadAccountUsage(
  scope: AccountScope,
  userId: string,
  accountId: string,
  options: RebuildAccountUsageRollupOptions,
): Promise<boolean> {
  const own = await resolveOwnMembershipBootstrap(scope.db, userId, accountId);
  const role = own !== null && isMemberRole(own.role) ? own.role : null;
  return checkAuthorization(role, 'usage:read', { accountId, actorId: userId }, authzOpts(options)).kind !== 'deny';
}

// ── reconciliation (launch gate 7) ──────────────────────────────────────────────────────────────────────────

export interface ReconcileAccountUsageRollupParams {
  readonly userId: string;
  readonly accountId: string;
  readonly periodStart: unknown;
  /**
   * Per-lane drift tolerance. REQUIRED, and defaulted NOWHERE in this package.
   *
   * Launch gate 7 is *"drift beyond threshold alerts"*, and the threshold VALUE is a commercial/operational
   * decision belonging to the owner (CDR-073 §3.1), exactly as AOQ-14's limit values are. Inventing a default
   * here would ship an unruled number as though someone had chosen it — and because the alert is what makes the
   * drift visible at all, a wrong default is silent by construction.
   */
  readonly threshold: unknown;
}

export type ReconcileAccountUsageRollupResult =
  | {
      readonly status: 'ok';
      readonly periodStart: string;
      /** Recomputed from the ledger — the authoritative figures. */
      readonly computed: RollupFigures;
      /** What the projection held. All zeroes when it did not exist; read `storedExisted` to tell them apart. */
      readonly stored: RollupFigures;
      /** `computed - stored`, per lane. Signed: SHORT and OVER have different causes. */
      readonly drift: RollupFigures;
      readonly lanesExceedingThreshold: readonly UsageRollupLane[];
      /** True when any lane drifted at all — the repair happened. Distinct from having ALERTED. */
      readonly rebuildApplied: boolean;
      /** False means the projection was MISSING, not stale. */
      readonly storedExisted: boolean;
    }
  /** An active account member who is not an OWNER. No figures disclosed, no repair, no audit event. */
  | { readonly status: 'forbidden' }
  | { readonly status: 'denied'; readonly reason: AccountAccessDenialReason }
  | { readonly status: 'invalid_period' }
  | { readonly status: 'invalid_threshold' };

/**
 * Reconcile one `(account, period)` rollup against the ledger, repairing and recording what it finds.
 *
 * THE TICKET'S FAILURE MODE IS *"drift detected = rebuild + alert"*, and those are TWO SEPARATE TRIGGERS:
 *   - **Rebuild** on ANY drift, however small. The projection is wrong and the ledger is right (§1-G1); there is
 *     no tolerance for leaving a known-wrong number in place.
 *   - **Alert** only beyond the owner's threshold. That is a question about what deserves attention, not about
 *     what is correct.
 * Collapsing them would mean a sub-threshold drift went unrepaired and accumulated — §0's silent wrongness,
 * arrived at one rounding at a time.
 *
 * THE RECOMPUTATION IS FROM THE LEDGER, NEVER FROM THE PROJECTION (§1-G11). Comparing the stored row against
 * itself, or against any other cached value, would report "no drift" in precisely the case this check exists to
 * catch. `computeAccountUsageFromLedger` above is the same function the rebuild uses.
 *
 * OWNER-ONLY, VIA `usage:read`, for the reason given on {@link rebuildAccountUsageRollup}: this RETURNS the
 * account's computed figures and its drift, which `API-CONTRACTS` rules owner-only, and an earlier version
 * checked nothing and relied on "it is exposed on no API surface" — a deployment fact, not an enforcement.
 * Who may TRIGGER a reconciliation remains part of CDR-073 §3.2's open question and is flagged for the owner;
 * requiring owner is the most restrictive posture and cannot pre-empt a narrower ruling.
 *
 * ⚠️ WHAT THE ISOLATION DOES AND DOES NOT GIVE YOU. The enclosing transaction is PostgreSQL's default READ
 * COMMITTED (`withAccountTransaction` sets no isolation level), so each statement takes a FRESH snapshot: the
 * per-company sums folded below are not one instant's view. Two consequences, both real:
 *   - Reconciling a LIVE period can report drift that is merely the clock moving — events committing between the
 *     stored-row read and the last company's sum. The check is meaningful for a CLOSED period, which is what a
 *     maintenance schedule should reconcile.
 *   - Without serialization, two concurrent reconciliations could each compute from a different moment and the
 *     later writer could overwrite a NEWER correct projection with an older total. That one is closed here, by
 *     `lockAccountPeriodForReconcile` below — a transaction-scoped advisory lock on `(account, period)` taken
 *     BEFORE the stored row is read, so reconciliations of the same period run one at a time.
 * A plain `rebuildAccountUsageRollup` does not take that lock, so it is not serialized against this — the
 * projection is rebuildable and self-healing (§1-G1), and a durable fix belongs with the scheduled job.
 */
export async function reconcileAccountUsageRollup(
  client: DatabaseClient,
  params: ReconcileAccountUsageRollupParams,
  options: RebuildAccountUsageRollupOptions & { readonly auditWriter?: typeof writeAuditEvent } = {},
): Promise<ReconcileAccountUsageRollupResult> {
  if (!isUsagePeriodStart(params.periodStart)) {
    return { status: 'invalid_period' };
  }
  const periodStart = params.periodStart;
  const threshold = readThreshold(params.threshold);
  if (threshold === null) {
    return { status: 'invalid_threshold' };
  }
  const audit = options.auditWriter ?? writeAuditEvent;

  const run = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (scope): Promise<ReconcileAccountUsageRollupResult> => {
      if (!(await callerMayReadAccountUsage(scope, params.userId, params.accountId, options))) {
        return { status: 'forbidden' };
      }
      const rollups = new AccountUsageRollupRepository(scope.db);
      // SERIALIZE FIRST, before anything is read. Taken here rather than around the write because the value
      // being written was decided by the read — locking only at the upsert would let a second reconciliation
      // compute from an older moment and then overwrite a newer, correct projection.
      await rollups.lockAccountPeriodForReconcile(params.accountId, periodStart);
      const storedFigures = await rollups.findFigures(params.accountId, periodStart);
      const storedExisted = storedFigures !== undefined;
      const stored = storedFigures ?? emptyRollupFigures();

      const { figures: computed } = await computeAccountUsageFromLedger(scope, periodStart);
      const drift = rollupFigureDrift(computed, stored);
      // ANY lane off by anything at all. `lanesExceedingThreshold` answers the ALERT question, not this one.
      const drifted = USAGE_ROLLUP_LANES.some((lane) => drift[lane] !== 0);
      // A missing projection is repaired even when the account's usage is genuinely zero: "computed and zero"
      // and "never computed" are different facts, and only the first is safe to read.
      const rebuildApplied = drifted || !storedExisted;
      if (rebuildApplied) {
        await rollups.upsert(params.accountId, periodStart, computed);
      }

      const exceeding = lanesExceedingThreshold(drift, threshold);
      // AUDITED UNCONDITIONALLY, carrying the per-lane drift. An event recording only that reconciliation ran
      // cannot answer whether the number moved (§1-G15), and a run that found nothing is itself the evidence
      // that the period was checked.
      await audit(
        scope,
        usageRollupReconciled({
          accountId: params.accountId,
          periodStart,
          eventCountDrift: drift.eventCount,
          inputTokensDrift: drift.inputTokens,
          outputTokensDrift: drift.outputTokens,
          estimatedCostMicrosDrift: drift.estimatedCostMicros,
          lanesExceedingThreshold: exceeding,
          rebuildApplied,
          storedExisted,
        }),
        options.correlationId !== undefined ? ({ correlationId: options.correlationId } satisfies AuditWriteContext) : {},
      );

      return { status: 'ok', periodStart, computed, stored, drift, lanesExceedingThreshold: exceeding, rebuildApplied, storedExisted };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  if (run.kind === 'denied') {
    return { status: 'denied', reason: run.reason };
  }
  return run.value;
}

/**
 * Validate a caller-supplied threshold into `RollupFigures`, or `null` to refuse.
 *
 * ⚠️ **`NaN` IS THE DANGEROUS INPUT, AND IT IS WHY THIS FUNCTION EXISTS.** The alert test is
 * `Math.abs(drift) > threshold`, and EVERY comparison against `NaN` is `false`. A `NaN` threshold therefore does
 * not alert loudly or fail loudly — it silently disables alerting for that lane, permanently and invisibly, in
 * the one mechanism launch gate 7 relies on to notice a wrong number. It arrives easily: `Number(undefined)`,
 * `Number('')` on a missing config value, or a `parseInt` of a malformed setting.
 *
 * Negative values are refused for a weaker but real reason: a negative tolerance makes every lane alert always,
 * which is loud rather than silent, but it is still not a tolerance anyone chose.
 */
function readThreshold(value: unknown): RollupFigures | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<Record<UsageRollupLane, unknown>>;
  const out: Record<string, number> = {};
  for (const lane of USAGE_ROLLUP_LANES) {
    const raw = candidate[lane];
    // `Number.isInteger` is false for NaN and for Infinity, so both are refused here rather than reaching the
    // comparison. Asserting on the type alone would let NaN through — it is a `number`.
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null;
    out[lane] = raw;
  }
  return out as unknown as RollupFigures;
}

// ── the read (usage:read) ───────────────────────────────────────────────────────────────────────────────────

export interface ReadAccountUsageRollupParams {
  readonly userId: string;
  readonly accountId: string;
  readonly periodStart: unknown;
}

export type ReadAccountUsageRollupResult =
  | { readonly status: 'ok'; readonly periodStart: string; readonly figures: RollupFigures; readonly computedAt: Date }
  /** The period has never been computed. NOT the same as a period whose figures are zero. */
  | { readonly status: 'not_computed'; readonly periodStart: string }
  | { readonly status: 'forbidden' }
  | { readonly status: 'denied'; readonly reason: AccountAccessDenialReason }
  | { readonly status: 'invalid_period' };

/**
 * Read the stored `(account, period)` projection.
 *
 * ACCOUNT-OWNER ONLY, and it runs in an ACCOUNT scope for that reason — the `readCreditLedger` precedent, whose
 * review pass 1 HIGH is the thing to avoid repeating: that function first ran in a COMPANY scope, so it checked
 * the caller's company-membership role, and a company owner who was only an account VIEWER would have been handed
 * the whole account's spending. A rollup spans companies by design, so RLS legitimately cannot narrow it and the
 * authorization is the only thing standing between a viewer and the account's total spend.
 *
 * ⚠️ THE FIGURES RETURNED HERE ARE A CACHE, NOT EVIDENCE (§1-G1). This is a reporting read. Nothing may authorize
 * a billing, limit or entitlement decision from it; when it disagrees with the ledger, the ledger is right and
 * this row is a bug. That is what `reconcileAccountUsageRollup` above exists to notice.
 */
export async function readAccountUsageRollup(
  client: DatabaseClient,
  params: ReadAccountUsageRollupParams,
  options: RebuildAccountUsageRollupOptions = {},
): Promise<ReadAccountUsageRollupResult> {
  if (!isUsagePeriodStart(params.periodStart)) {
    return { status: 'invalid_period' };
  }
  const periodStart = params.periodStart;

  const run = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (scope): Promise<ReadAccountUsageRollupResult> => {
      if (!(await callerMayReadAccountUsage(scope, params.userId, params.accountId, options))) {
        return { status: 'forbidden' };
      }
      const row = await new AccountUsageRollupRepository(scope.db).find(params.accountId, periodStart);
      if (row === undefined) return { status: 'not_computed', periodStart };
      // ONE read, converted here: the figure columns are `bigint` and arrive as strings (§1-G14).
      return { status: 'ok', periodStart, figures: rollupRowFigures(row), computedAt: row.computed_at };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  if (run.kind === 'denied') {
    return { status: 'denied', reason: run.reason };
  }
  return run.value;
}

function authzOpts(options: RebuildAccountUsageRollupOptions): { correlationId?: string; logger?: Logger } {
  const o: { correlationId?: string; logger?: Logger } = {};
  if (options.correlationId !== undefined) o.correlationId = options.correlationId;
  if (options.logger !== undefined) o.logger = options.logger;
  return o;
}
