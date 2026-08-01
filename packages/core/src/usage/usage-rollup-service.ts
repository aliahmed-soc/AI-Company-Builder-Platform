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
import { addRollupFigures, emptyRollupFigures, isUsagePeriodStart, type RollupFigures } from '@acbp/contracts';
import { AccountUsageRollupRepository, elevateToCompanyScope, type DatabaseClient } from '@acbp/database';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import type { AccountAccessDenialReason } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

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
  | { readonly status: 'denied'; readonly reason: AccountAccessDenialReason }
  | { readonly status: 'invalid_period' };

/**
 * Recompute one `(account, period)` rollup from the ledger and store it.
 *
 * There is deliberately NO authorization action for this operation and NO API route reaching it. Whether an
 * account owner may trigger a rebuild on demand, or whether it is platform-only, is an OPEN OWNER DECISION
 * (CDR-073 §3.2); registering a `usage:rebuild` action now would encode an answer nobody has given. The account
 * membership check below is scope ESTABLISHMENT, not a filter — it decides whether this caller may act in the
 * account at all, and has no influence on which companies are summed.
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
    async (scope) => {
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
        const corrections = await rollups.sumCompanyCorrections(periodStart);
        figures = addRollupFigures(figures, addRollupFigures(events, corrections));
      }

      // The rollup table is account-keyed, so this write is legal even though the company GUC still holds the
      // last company elevated into (§1-G2). The upsert REPLACES the figures rather than adding to them, which
      // is what makes a repeated rebuild idempotent instead of doubling (§1-G12).
      await new AccountUsageRollupRepository(scope.db).upsert(params.accountId, periodStart, figures);
      return { figures, companyCount: companies.length };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );

  if (run.kind === 'denied') {
    return { status: 'denied', reason: run.reason };
  }
  return { status: 'ok', periodStart, figures: run.value.figures, companyCount: run.value.companyCount };
}
