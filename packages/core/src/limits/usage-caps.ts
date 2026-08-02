// @acbp/core — assembling the configured caps and the policy observation (ACBP-P6-010; CDR-075; NFR-015,
// POL-001; CDR-008 §8 supplies the values, CDR-066 §3-G8 keeps them out of here).
//
// ── WHY THIS FILE EXISTS AT ALL: CDR-067's landmine ──────────────────────────────────────────────────────────
//
// The dispatcher supplies the policy engine exactly ONE observation (`risk_class`). A rule on `spending_limit`
// therefore has nothing to read, is UNEVALUABLE, and by CDR-066 §3-G9 contributes `deny`. CDR-067's own post-
// review correction spells out the consequence — a company whose policy carried a spend cap would have EVERY
// TOOL CALL REFUSED — and notes it is "latent today because no product path writes rules until P6-010".
//
// ACBP-P6-010 is that product path. So supplying the observation is not a nicety here; without it, the first
// spend rule anyone writes takes a tenant offline, and the rule would look perfectly correct in the database.
import type { UsageCapsConfig } from '@acbp/config';
import type { ObservedCap, ProvenancedFact } from '@acbp/contracts';

/** Spend already recorded in a scope, per period, in integer micro-units. `null` = COULD NOT BE READ. */
export interface SpendReads {
  readonly dayMicros: number | null;
  readonly monthMicros: number | null;
}

/**
 * Pair CDR-008's four configured caps with the spend observed for each one's own scope and period.
 *
 * THE ACCOUNT CEILING IS DERIVED, not stored twice. CDR-008 §8 states it relatively — "account-level cap = 3×
 * company cap across companies" — and deriving it is what stops the two drifting apart the first time someone
 * edits only the company value. An account ceiling that slipped below its own company cap would make the company
 * cap unreachable, turning the per-company number into decoration with nothing reporting a contradiction.
 *
 * `null` totals are passed THROUGH rather than defaulted to zero. Zero reads as "nothing spent yet" and allows
 * the call; `evaluateCaps` halts on null instead (CDR-075 §3-G6). A cap that fails open is not a cap.
 */
export function observedCapsFrom(config: UsageCapsConfig, company: SpendReads, account: SpendReads): ObservedCap[] {
  const soft = config.softPercent;
  return [
    { cap: { scope: 'company', period: 'day', limitMicros: config.companyDailyMicros, softPercent: soft }, spentMicros: company.dayMicros },
    { cap: { scope: 'company', period: 'month', limitMicros: config.companyMonthlyMicros, softPercent: soft }, spentMicros: company.monthMicros },
    {
      cap: { scope: 'account', period: 'day', limitMicros: config.companyDailyMicros * config.accountMultiplier, softPercent: soft },
      spentMicros: account.dayMicros,
    },
    {
      cap: { scope: 'account', period: 'month', limitMicros: config.companyMonthlyMicros * config.accountMultiplier, softPercent: soft },
      spentMicros: account.monthMicros,
    },
  ];
}

/**
 * The `spending_limit` observation for the policy engine — the company's spend so far in the CURRENT UTC MONTH.
 *
 * STRUCTURED PROVENANCE, and the claim is true: the figure comes from the usage ledger, not from model text.
 * ADR-010 §5 puts `spending_limit` among the trust-critical dimensions precisely so a model can never supply it;
 * labelling a real ledger figure `model` would route it down the untrusted path, and `registry` would be a lie.
 *
 * WHY THE MONTH, when the dimension carries no period of its own. A rule's operand is a bare number, so the
 * period is decided here or nowhere. Month is chosen because billing periods are monthly (ADR-013) and CDR-008's
 * monthly figure is the headline ceiling — an operand a founder writes is far more likely to mean "per month"
 * than "per day". **This is a choice, not a derivation**: the policy engine's `spending_limit` dimension having
 * no period is a real gap in ADR-010, recorded in CDR-075 rather than papered over. The CDR-008 platform caps do
 * not depend on it — they carry their own explicit periods through `observedCapsFrom`.
 *
 * RETURNS `undefined` WHEN THE TOTAL IS UNREADABLE, and that direction matters. Substituting `0` would put the
 * company under every conceivable cap, so a rule that should have blocked would allow. Leaving the dimension
 * unobserved makes it unevaluable, and CDR-066 §3-G9 turns that into `deny` — fail-closed, which is the only
 * safe direction for a figure nobody can read.
 */
export function spendingLimitObservation(monthMicros: number | null): ProvenancedFact | undefined {
  return monthMicros === null ? undefined : { value: monthMicros, provenance: 'structured' };
}
