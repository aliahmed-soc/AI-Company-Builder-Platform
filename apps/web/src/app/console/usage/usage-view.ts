/*
 * ACBP-FE-018 — turning the account usage rollup into figures a founder can read.
 *
 * ⚠️ **THIS IS A REPORTING CACHE, NOT A BILL, AND THE SCREEN MUST NOT PRETEND OTHERWISE.** The read's own header
 * says it in the strongest terms available (`usage-request.ts:20-23`, CDR-073 §1-G1): *"Nothing may authorize a
 * billing, limit or entitlement decision from it; when it disagrees with the ledger, the LEDGER is right and this
 * row is a bug. Any surface presenting these figures as an invoice would be asserting something the platform does
 * not claim."* That sentence is addressed to this file. Every string below is written so a founder cannot mistake
 * these numbers for money owed.
 *
 * ⚠️ **"COMPUTED AND ZERO" AND "NEVER COMPUTED" ARE DIFFERENT FACTS.** Core draws the distinction, the request
 * layer preserves it, and the route sends `usage: null` rather than a zeroed body specifically so it survives to
 * here — `usage-http.ts:36-38`: *"sending zeroes here would collapse that distinction at the last possible moment
 * and hand the client a measurement nobody took."* The backlog row states the same requirement from the other
 * side: *"Zero usage is an explicit computed zero, not a blank."* They are two states with two different
 * sentences, and a test asserts the copy differs.
 *
 * ⚠️ **`estimatedCostMicros` IS MICROS, AND THE PLATFORM NAMES NO CURRENCY FOR IT.** Migration 0017 defines it as
 * *"integer micro-units (1e-6 of the cost unit)"* — the cost unit is deliberately unnamed, and a search of
 * `packages/contracts/src/usage` and `packages/core/src/usage` finds no currency field, code or symbol anywhere.
 * A currency appears in exactly one place in this repository, `anthropic-gateway.ts:27`, as ONE provider's
 * published list price; that is a property of an adapter, not of this lane.
 *
 * So **nothing here renders a currency symbol.** A `$` on this screen would assert something the server never
 * said, and the first draft of this file did exactly that before the contract was checked. The figure is shown in
 * cost units with the word "estimated" attached, and the copy says plainly that no currency is recorded.
 *
 * The conversion is done in INTEGER arithmetic rather than by dividing a float, because `1250 / 1e6` does not give
 * you `0.00125` in binary floating point.
 *
 * FIGURES CARRY THEIR UNITS IN TEXT (the row's accessibility line). Every value below is a string that names what
 * it counts, so nothing depends on a column heading, a tooltip or a colour.
 */

/** The wire shape this screen consumes — the `ok` arm of `UsageRequestResult`, pinned by the alignment suite. */
export interface AccountUsageWire {
  readonly periodStart: string;
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly computedAt: string;
}

export type UsageState = 'computed' | 'never_computed';

export interface UsageFigureView {
  readonly key: 'eventCount' | 'inputTokens' | 'outputTokens' | 'estimatedCost';
  readonly label: string;
  /** The number and its unit, as one readable string. Never a bare numeral. */
  readonly value: string;
  /** One sentence saying what this figure is, and — for the cost — what it is not. */
  readonly note: string;
}

export interface UsageView {
  readonly state: UsageState;
  readonly periodStart: string;
  /** `2026-08` rendered as `August 2026`; falls back to the raw value rather than inventing a date. */
  readonly periodLabel: string;
  readonly headline: string;
  readonly note: string;
  readonly figures: readonly UsageFigureView[];
  /** True only when the projection EXISTS and every lane is zero — a measured zero. */
  readonly isMeasuredZero: boolean;
  readonly computedAt: string | null;
  /** What makes a stale figure recognisable as stale, in words. */
  readonly computedAtLabel: string;
}

const MICROS_PER_UNIT = 1_000_000;

/** Thousands separators, and nothing else. `Intl` with an explicit locale so the output cannot drift by host. */
function count(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/**
 * Micros → a decimal count of COST UNITS, in INTEGER arithmetic. **No currency symbol** — see the header.
 *
 * `micros / 1_000_000` is a float division on a money-shaped value: 1250 micros becomes 0.0012500000000000002 in
 * binary floating point, and a screen that rounds that has silently invented a figure. Splitting the integer into
 * whole units and a zero-padded remainder keeps every digit exact.
 *
 * Trailing zeros are trimmed to at most six places but never below two, because a cost rendered as `0.1` reads
 * like a typo where `0.10` reads like a measured amount.
 */
export function microsToCostUnits(micros: number): string {
  if (!Number.isFinite(micros)) return '0.00';
  const negative = micros < 0;
  const abs = Math.abs(Math.trunc(micros));
  const whole = Math.floor(abs / MICROS_PER_UNIT);
  const frac = String(abs % MICROS_PER_UNIT).padStart(6, '0');
  const trimmed = frac.replace(/0+$/, '');
  const decimals = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  return `${negative ? '-' : ''}${count(whole)}.${decimals}`;
}

/** `2026-08-01` → `August 2026`. An unparseable value is returned AS IS rather than guessed at. */
export function periodLabelOf(periodStart: string): string {
  const m = /^(\d{4})-(\d{2})-01$/.exec(periodStart);
  if (m === null) return periodStart;
  const at = new Date(`${periodStart}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return periodStart;
  return at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function figuresOf(usage: AccountUsageWire): readonly UsageFigureView[] {
  return [
    {
      key: 'eventCount',
      label: 'Model calls',
      value: `${count(usage.eventCount)} ${usage.eventCount === 1 ? 'call' : 'calls'}`,
      note: 'Each call the platform made to a model on this account’s behalf, across every company in it.',
    },
    {
      key: 'inputTokens',
      label: 'Input tokens',
      value: `${count(usage.inputTokens)} tokens`,
      note: 'Tokens sent to the model — the prompts, and whatever context was assembled with them.',
    },
    {
      key: 'outputTokens',
      label: 'Output tokens',
      value: `${count(usage.outputTokens)} tokens`,
      note: 'Tokens the model returned.',
    },
    {
      key: 'estimatedCost',
      label: 'Estimated provider cost',
      // The unit and the hedge are both in the VALUE, not only in the label — a figure read aloud on its own must
      // still carry them. No currency symbol: the platform records none for this lane.
      value: `${microsToCostUnits(usage.estimatedCostMicros)} cost units (estimated)`,
      note: 'An ESTIMATE of what the model providers charged, computed by this platform — not an invoice, not a balance, and not what you will be charged. It is stored in micro-units and the platform records NO currency for it, so no currency is shown. Nothing charges from this figure.',
    },
  ];
}

export function toUsageView(usage: AccountUsageWire | null, periodStartWhenAbsent?: string): UsageView {
  if (usage === null) {
    const periodStart = periodStartWhenAbsent ?? '';
    return {
      state: 'never_computed',
      periodStart,
      periodLabel: periodStart === '' ? 'this period' : periodLabelOf(periodStart),
      headline: 'No usage projection has been computed for this period.',
      /*
       * NOT "you used nothing", and the difference is the whole point. The platform has not measured this period,
       * which is a statement about the PROJECTION rather than about the account's activity. Saying "zero" here
       * would hand a founder a measurement nobody took.
       *
       * It also does not offer a way to trigger one: `rebuildAccountUsageRollup` is deliberately reachable from no
       * API route (CDR-073 §3.2 is an open owner decision, and no `usage:rebuild` authorization action exists), so
       * a control here could only be inert.
       */
      note: 'That is not the same as zero usage — it means the projection for this period has not been built yet, so there is no figure to show. Rebuilding it on demand is not something this console can trigger.',
      figures: [],
      isMeasuredZero: false,
      computedAt: null,
      computedAtLabel: 'Never computed.',
    };
  }

  const isMeasuredZero = usage.eventCount === 0 && usage.inputTokens === 0 && usage.outputTokens === 0 && usage.estimatedCostMicros === 0;

  return {
    state: 'computed',
    periodStart: usage.periodStart,
    periodLabel: periodLabelOf(usage.periodStart),
    headline: isMeasuredZero
      ? 'This period was measured, and the total is zero.'
      : `${count(usage.eventCount)} model ${usage.eventCount === 1 ? 'call' : 'calls'} in this period.`,
    note: isMeasuredZero
      ? 'The projection exists and every figure in it is zero — a measured zero, not a missing number. Nothing on this account called a model in this period.'
      : 'These figures are a reporting projection across every company in this account. They record what was used; no charge, limit or entitlement is decided from them.',
    figures: figuresOf(usage),
    isMeasuredZero,
    computedAt: usage.computedAt,
    // WHEN it was computed is what makes a stale figure recognisable as stale, so it is a first-class label rather
    // than a timestamp tucked into a corner.
    computedAtLabel: `Projection computed ${usage.computedAt}.`,
  };
}
