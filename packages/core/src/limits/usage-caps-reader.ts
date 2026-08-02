// @acbp/core — reading spend for a cap decision (ACBP-P6-010; CDR-075 §3-G6/G12/G13).
//
// Separated from `usage-caps.ts` so the assembly and the decision stay pure and unit-testable; only this file
// touches a database.
import { AccountUsageRollupRepository, type TenantScope } from '@acbp/database';
import { usagePeriodStart, usageDayStart } from '@acbp/contracts';

/**
 * The current company's spend so far this UTC MONTH, in integer micro-units, or `null` if it cannot be read.
 *
 * READS THE LEDGER (`sumCompanyUsage` aggregates `usage_events`), never `account_usage_rollups` — CDR-075 §3-G12.
 * The rollup is a projection rebuilt on a schedule; a cap decided from a stale projection under-counts, silently
 * and in the customer's favour, which is the shape that survives longest.
 *
 * NULL ON FAILURE RATHER THAN A THROW, and this is the load-bearing choice. Callers turn `null` into either an
 * unobserved policy dimension (→ unevaluable → deny, CDR-066 §3-G9) or a `halt` from `evaluateCaps`. Both are
 * fail-closed. Letting the error propagate instead would make a cap check able to abort the caller's own
 * transaction — the cap would stop being a decision and become an outage with a different cause.
 *
 * The error is intentionally not inspected: there is no failure mode of "cannot read the spend" that should
 * allow the call, so distinguishing them would only create a branch where one of them eventually does.
 */
export async function readCompanyMonthSpendMicros(scope: TenantScope, at: Date): Promise<number | null> {
  try {
    const figures = await new AccountUsageRollupRepository(scope.db).sumCompanyUsage(usagePeriodStart(at));
    return figures.estimatedCostMicros;
  } catch {
    return null;
  }
}

/** The current company's spend so far this UTC DAY, in integer micro-units, or `null` if it cannot be read. */
export async function readCompanyDaySpendMicros(scope: TenantScope, at: Date): Promise<number | null> {
  try {
    const figures = await new AccountUsageRollupRepository(scope.db).sumCompanyUsageForDay(usageDayStart(at));
    return figures.estimatedCostMicros;
  } catch {
    return null;
  }
}
