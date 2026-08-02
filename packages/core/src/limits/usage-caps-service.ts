// @acbp/core — the cap check, and the only thing that emits `usage.limit_reached` (ACBP-P6-010; CDR-075;
// NFR-015 cost control, POL-001 spending limits; CDR-008 §8 supplies the values).
//
// THE GATEWAY'S CAPS SEAM WAS NEVER FILLED. `ModelGatewayDeps.policyPrecheck` is optional and describes itself
// as "the caps/tier pre-check", but its default is *always allowed* and no production caller supplied one — so
// the gateway enforced no cap at all, and that comment described an intention rather than a behaviour
// (CDR-075 §1). This is the function that fills it.
//
// ── WHY `elevateToCompanyScope` AND NOT `runInCompanyScope` ─────────────────────────────────────────────────
//
// The same ruling ACBP-P6-009 made (CDR-073 §1-G3), and it matters more here than there. `runInCompanyScope`
// validates the ACTOR'S company membership, so an account owner who is not a member of every company would be
// measured against a SMALLER total than a co-owner making the identical call. A ceiling that depends on who is
// asking is not a ceiling. `elevateToCompanyScope` verifies only that the company belongs to the caller's
// ACCOUNT, via the account-scoped `companies` SELECT policy, and consults no membership.
import { AccountUsageRollupRepository, elevateToCompanyScope, writeAuditEvent, type AccountScope, type AuditWriteContext, type TenantScope } from '@acbp/database';
import { evaluateCaps, softThresholdMicros, usageDayStart, usagePeriodStart, usageLimitReached, type CapDecision } from '@acbp/contracts';
import type { UsageCapsConfig } from '@acbp/config';
import type { Logger } from '@acbp/observability';
import { observedCapsFrom, type SpendReads } from './usage-caps.js';

export interface CapCheckOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
  readonly auditWriter?: typeof writeAuditEvent;
}

/**
 * One company's spend for both periods, FROM THE LEDGER.
 *
 * Not `account_usage_rollups` (CDR-075 §3-G12): the rollup is a projection rebuilt on a schedule, and a cap
 * decided from a stale projection under-counts silently, self-consistently, and in the customer's favour.
 *
 * The two reads are SEQUENTIAL. They share one transaction, and a single PostgreSQL connection does not run two
 * statements at once — `Promise.all` here buys nothing and invites a driver-level surprise.
 */
async function readCompanySpend(scope: TenantScope, at: Date): Promise<SpendReads> {
  const repo = new AccountUsageRollupRepository(scope.db);
  const day = await repo.sumCompanyUsageForDay(usageDayStart(at));
  const month = await repo.sumCompanyUsage(usagePeriodStart(at));
  return { dayMicros: day.estimatedCostMicros, monthMicros: month.estimatedCostMicros };
}

interface SpendTotals {
  readonly company: SpendReads;
  readonly account: SpendReads;
}

const UNREADABLE: SpendReads = { dayMicros: null, monthMicros: null };

/**
 * Sum the account's companies once, keeping the target company's own figures out of the same pass.
 *
 * ENUMERATED FIRST under the account scope with no company GUC set: `companies_select` is
 * `account_id = current_account`, the account's whole registry — deliberately not membership-filtered and
 * deliberately not status-filtered, because a `paused` company's spend is still spend (CDR-073 §1-G4).
 *
 * SEQUENTIAL, NEVER PARALLEL. `elevateToCompanyScope` issues `SET LOCAL app.current_company` on this SHARED
 * transaction, so two concurrent elevations would interleave the GUC and each read would attribute to whichever
 * company won the race — a wrong total with no error anywhere (CDR-073 §1-G5).
 *
 * ANY failed read makes BOTH totals unreadable rather than partial. A partial sum is an under-count, and an
 * under-count is exactly the failure that lets spend through a ceiling. `evaluateCaps` halts on null (§3-G6).
 */
async function readSpendTotals(scope: AccountScope, companyId: string, at: Date): Promise<SpendTotals> {
  let companies: readonly { readonly id: string }[];
  try {
    companies = await scope.db.selectFrom('companies').select('id').orderBy('id').execute();
  } catch {
    return { company: UNREADABLE, account: UNREADABLE };
  }

  let company: SpendReads = UNREADABLE;
  let dayTotal = 0;
  let monthTotal = 0;

  for (const row of companies) {
    let figures: SpendReads;
    try {
      figures = await readCompanySpend(await elevateToCompanyScope(scope, row.id), at);
    } catch {
      return { company: UNREADABLE, account: UNREADABLE };
    }
    if (figures.dayMicros === null || figures.monthMicros === null) return { company: UNREADABLE, account: UNREADABLE };
    dayTotal += figures.dayMicros;
    monthTotal += figures.monthMicros;
    if (row.id === companyId) company = figures;
  }

  // The target company was not in its own account's registry. Refusing to guess: reporting zero would read as
  // "spent nothing" and allow the call, which is the fail-open direction on a billing control.
  if (company === UNREADABLE) return { company: UNREADABLE, account: UNREADABLE };
  return { company, account: { dayMicros: dayTotal, monthMicros: monthTotal } };
}

/**
 * Decide whether a metered call may proceed, and RECORD what was decided.
 *
 * THE CHECK RUNS BEFORE THE CALL, which is the only reason NFR-015's "≤1 billing increment" bound holds: the most
 * that can exceed a ceiling is the single call already decided. Same shape as `decideStepAdmission`
 * (ACBP-P5-005) at the worker-run level, deliberately rather than coincidentally.
 *
 * AN EVENT IS WRITTEN FOR EVERY THRESHOLD CROSSED — each soft breach, and the hard block. A block with no record
 * would leave a founder's work stopped with nothing to point at, which §4-G4.3 forbids.
 *
 * NOTHING IS RECORDED FOR A HALT. An unreadable total means no threshold is KNOWN to have been crossed, and
 * writing `usage.limit_reached` there would assert a cap event that may never have happened. The halt surfaces
 * as its own outcome, never as "you are out of budget".
 */
export async function checkUsageCaps(
  scope: AccountScope,
  input: { readonly companyId: string; readonly at: Date },
  config: UsageCapsConfig,
  options: CapCheckOptions = {},
): Promise<CapDecision> {
  const audit = options.auditWriter ?? writeAuditEvent;
  const totals = await readSpendTotals(scope, input.companyId, input.at);
  const decision = evaluateCaps(observedCapsFrom(config, totals.company, totals.account));

  if (decision.outcome === 'halt') {
    // WARN, not error: the platform is degraded rather than broken, and the call is refused rather than
    // mis-billed. Deliberately carries no spend figure — there is not one, which is the entire point.
    options.logger?.warn('usage.cap_unreadable', { metadata: { limit_scope: decision.unreadable.scope, limit_period: decision.unreadable.period } });
    return decision;
  }

  const crossings: { readonly breach: (typeof decision.softBreaches)[number]; readonly threshold: 'hard' | 'soft' }[] = decision.softBreaches.map((breach) => ({
    breach,
    threshold: 'soft' as const,
  }));
  if (decision.outcome === 'block') crossings.unshift({ breach: decision.blocking, threshold: 'hard' });

  for (const { breach, threshold } of crossings) {
    await audit(
      scope,
      usageLimitReached({
        companyId: input.companyId,
        limitScope: breach.cap.scope,
        limitPeriod: breach.cap.period,
        threshold,
        limitMicros: breach.cap.limitMicros,
        spentMicros: breach.spentMicros,
        // The hard event's threshold IS the ceiling; a soft event's is the alert line that was crossed.
        thresholdMicros: threshold === 'hard' ? breach.cap.limitMicros : softThresholdMicros(breach.cap),
      }),
      options.correlationId !== undefined ? ({ correlationId: options.correlationId } satisfies AuditWriteContext) : {},
    );
  }

  return decision;
}
