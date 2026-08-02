// @acbp/core — the cap check, and the only thing that emits `usage.limit_reached` (ACBP-P6-010; CDR-075;
// NFR-015 cost control, POL-001 spending limits; CDR-008 §8 supplies the values).
//
// THE GATEWAY'S CAPS SEAM WAS NEVER FILLED. `ModelGatewayDeps.policyPrecheck` is optional and describes itself
// as "the caps/tier pre-check", but its default is *always allowed* and no production caller supplied one — so
// the gateway enforced no cap at all, and that comment described an intention rather than a behaviour
// (CDR-075 §1).
//
// THIS FUNCTION CAN FILL IT; NOTHING FILLS IT YET, and saying so is the point (CDR-075 §4.3). `createModelGateway`
// has no production composition anywhere in the repo — only demo scripts, journey helpers and tests construct
// one, and none of them pass `caps`. An earlier draft of this header claimed "this is the function that fills
// it", which is the same overclaim §1 criticises in the P2-003 comment, reproduced one layer up. It becomes true
// the moment a real composition passes `caps`; until then this is a ceiling that is reachable, tested, and
// unreached.
//
// ── WHY `elevateToCompanyScope` AND NOT `runInCompanyScope` ─────────────────────────────────────────────────
//
// The same ruling ACBP-P6-009 made (CDR-073 §1-G3), and it matters more here than there. `runInCompanyScope`
// validates the ACTOR'S company membership, so an account owner who is not a member of every company would be
// measured against a SMALLER total than a co-owner making the identical call. A ceiling that depends on who is
// asking is not a ceiling. `elevateToCompanyScope` verifies only that the company belongs to the caller's
// ACCOUNT, via the account-scoped `companies` SELECT policy, and consults no membership.
import { AccountUsageRollupRepository, elevateToCompanyScope, writeAuditEvent, type AccountScope, type AuditWriteContext, type TenantScope } from '@acbp/database';
import { evaluateCaps, softThresholdMicros, usageDayStart, usagePeriodStart, usageLimitReached, type BreachedCap, type CapDecision, type LimitPeriod, type LimitThreshold } from '@acbp/contracts';
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

/** The period key a cap is decided against — `YYYY-MM-DD` for a day, `YYYY-MM-01` for a month. */
function periodKey(period: LimitPeriod, at: Date): string {
  return period === 'day' ? usageDayStart(at) : usagePeriodStart(at);
}

/**
 * Has this exact crossing already been recorded in this period?
 *
 * ── WHY A READ AND NOT A UNIQUE KEY (CDR-075 §3-G8) ────────────────────────────────────────────────────────
 *
 * `audit_events.idempotency_key` is unique-when-present, so a deterministic key looks like the obvious mechanism.
 * It is a trap: `writeAuditEvent` inserts with NO `ON CONFLICT`, so the second write raises `23505` — and a
 * constraint violation ABORTS THE ENCLOSING TRANSACTION. Catching it in JavaScript does not un-abort it; every
 * later statement then fails with `25P02` and the commit fails. A soft ALERT would have become a hard OUTAGE,
 * which is a worse failure than the noise it was meant to fix.
 *
 * So the mechanism is a read, and it is NAMED here rather than assumed, which is what §3-G8 asks for. Its limit
 * is stated too: two concurrent calls can both find nothing and both write, so this is "once per crossing" under
 * ordinary traffic and "at most a handful" under a race — not an exactly-once guarantee. That is the right
 * trade at this granularity, because the failure it prevents is hundreds of rows per period and the failure it
 * admits is two.
 */
async function alreadyRecorded(scope: AccountScope, companyId: string, breach: BreachedCap, threshold: LimitThreshold, at: Date): Promise<boolean> {
  const rows = await scope.db
    .selectFrom('audit_events')
    .select('payload')
    .where('name', '=', 'usage.limit_reached')
    // MATCHED ON `subject_id`, NOT `company_id`. This event is written under an ACCOUNT scope — that is where the
    // account-spanning read happens, and the company GUC after `readSpendTotals` points at whichever company the
    // loop visited last, so writing company-scoped would stamp an arbitrary one. `writeAuditEvent` therefore
    // leaves the tenant stamp `company_id` NULL and the row identifies its company through the SUBJECT.
    //
    // Filtering on `company_id` matched nothing at all, so the dedupe silently never fired — five calls wrote
    // five rows. Caught only because the new cases assert an EXACT count; the previous `>= 1` assertion would
    // have passed on all five.
    .where('subject_id', '=', companyId)
    .execute();

  // ── NO `occurred_at` WINDOW, DELIBERATELY: IT MIXED TWO CLOCKS ──────────────────────────────────────────
  //
  // The first version bounded this read by `occurred_at >= periodStart(at)`. `occurred_at` is the DATABASE clock
  // (`writeAuditEvent` never sets it, so the column default `now()` wins) while the window came from the
  // caller-supplied `at`. Those agree in production and diverge the moment they do not — a row written today
  // falls inside tomorrow's window, the crossing is wrongly suppressed, and the alert for a NEW period never
  // fires. Invisible on the day it is written, wrong the next midnight.
  //
  // The period the decision was made against is now carried IN THE PAYLOAD, so both sides of the comparison come
  // from the same clock. Unbounded by time on purpose: the row count per company is a handful of caps times a
  // handful of periods, and a coarse time prefilter would reintroduce exactly the clock it removes.
  const key = periodKey(breach.cap.period, at);
  return rows.some((r) => {
    const p = r.payload as Record<string, unknown>;
    return p['limit_scope'] === breach.cap.scope && p['limit_period'] === breach.cap.period && p['limit_period_start'] === key && p['threshold'] === threshold;
  });
}

/**
 * Decide whether a metered call may proceed, and RECORD what was decided.
 *
 * THE CHECK RUNS BEFORE THE CALL, which is the only reason NFR-015's "≤1 billing increment" bound holds: the most
 * that can exceed a ceiling is the single call already decided. Same shape as `decideStepAdmission`
 * (ACBP-P5-005) at the worker-run level, deliberately rather than coincidentally.
 *
 * ONE EVENT PER (SCOPE, PERIOD, THRESHOLD) PER PERIOD — not one per call (CDR-075 §3-G8). A company sitting just
 * past its soft threshold makes model calls all day; recording each one would put hundreds of rows into a trail
 * retained for the billing lifetime and make the incident count worthless at exactly the moment it matters. The
 * per-call refusal still reaches the caller as `budget_exceeded`; the audit row is the durable fact that the
 * ceiling was reached in this period, which is a different question and a different cardinality.
 *
 * A HARD BLOCK IS DEDUPED THE SAME WAY, deliberately: a founder whose job retries would otherwise write a row per
 * attempt. If a per-attempt count is ever wanted, it needs its own counter — CDR-074 §5's lesson, that a count
 * and an audit fact are not the same artefact.
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
    if (await alreadyRecorded(scope, input.companyId, breach, threshold, input.at)) continue;
    await audit(
      scope,
      usageLimitReached({
        companyId: input.companyId,
        limitScope: breach.cap.scope,
        limitPeriod: breach.cap.period,
        // Same derivation the dedupe reads, from the same `at` — that identity is the fix, not a coincidence.
        limitPeriodStart: periodKey(breach.cap.period, input.at),
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
