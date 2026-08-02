// @acbp/config — usage cap values (ACBP-P6-010; CDR-075 §4; CDR-008 §8; NFR-015, POL-001).
//
// ⚠️ THESE VALUES ARE INTERIM AND CARRY A MANDATORY REVISIT.
//
// They are CDR-008 §8's, authorized by the product owner on 2026-07-18 as pre-alpha calibration, and CDR-008 §21
// binds a **mandatory revisit at the first alpha telemetry review**. They are conservative guesses made without
// usage data, not a considered pricing or entitlement position — D-02 (commercial formula) is untouched and
// **AOQ-14 (final caps) remains OPEN**. Nothing here answers it.
//
// The revisit trigger is named at this definition rather than only in the CDR because a number whose provisional
// status lives three documents away gets read as settled by whoever finds it next (CDR-075 §4-G4.2).
//
// WHY VALUES LIVE HERE AND NOT IN `@acbp/contracts` OR `@acbp/core` (CDR-066 §3-G8, restated CDR-075 §2-G2.2):
// a default limit is a statement about when a founder's money is spent without asking them. The evaluator must be
// unable to hold an opinion about that; it evaluates whatever it is given.
//
// This module deliberately does NOT import `@acbp/contracts` — it yields plain numbers, and the composition layer
// assembles them into cap definitions. Config stays dependency-free of the domain.
import { z } from 'zod';
import { ConfigValidationError, type ConfigIssue } from './index.js';

/**
 * CDR-008 §8, in integer micro-units (1 US dollar = 1_000_000 micro-units), matching `estimated_cost_micros`
 * on the usage ledger.
 *
 * `accountMultiplier` is a multiplier rather than an absolute figure because CDR-008 states the account ceiling
 * *relatively* — "account-level cap = 3× company cap across companies". Storing it absolutely would let the two
 * drift apart silently the first time someone changed only the company value.
 */
export const USAGE_CAP_DEFAULTS = {
  /** $5/day per company (CDR-008 §8, interim). */
  companyDailyMicros: 5_000_000,
  /** $50/month per company (CDR-008 §8, interim). */
  companyMonthlyMicros: 50_000_000,
  /** Account ceiling = 3× the company cap, across that account's companies (CDR-008 §8, interim). */
  accountMultiplier: 3,
  /** Soft alert at 75% of any hard cap (CDR-008 §8, interim). */
  softPercent: 75,
} as const;

export interface UsageCapsConfig {
  readonly companyDailyMicros: number;
  readonly companyMonthlyMicros: number;
  readonly accountMultiplier: number;
  readonly softPercent: number;
}

type EnvRecord = Record<string, string | undefined>;

/**
 * A non-negative integer from the environment, STRICTLY.
 *
 * `z.coerce.number()` is deliberately not used: it accepts `'5.5'`, `'1e6'`, `'0x10'` and `''`, and every one of
 * those would become a cap the owner did not write. A malformed cap must fail the load, never soften into a
 * default — an operator who mistyped a ceiling would otherwise see the platform enforcing a number their config
 * file does not contain, with nothing anywhere reporting a disagreement.
 */
const intFromEnv = (field: string) =>
  z
    .string({ required_error: 'is required' })
    .regex(/^\d+$/, 'must be a non-negative integer (no decimals, signs, or exponent notation)')
    .transform((s) => Number(s))
    .refine((n) => Number.isSafeInteger(n), 'must be within the safe integer range')
    .describe(field);

const schema = z.object({
  ACBP_CAP_COMPANY_DAILY_MICROS: intFromEnv('ACBP_CAP_COMPANY_DAILY_MICROS').optional(),
  ACBP_CAP_COMPANY_MONTHLY_MICROS: intFromEnv('ACBP_CAP_COMPANY_MONTHLY_MICROS').optional(),
  // At least 1: below that the account ceiling would sit UNDER a single company's own cap, so the company cap
  // could never be reached and the per-company value would be decoration.
  ACBP_CAP_ACCOUNT_MULTIPLIER: intFromEnv('ACBP_CAP_ACCOUNT_MULTIPLIER').refine((n) => n >= 1, 'must be at least 1').optional(),
  // 1..99. Zero would alert from zero spend; 100 would alert only when the hard cap already blocks, which is an
  // alert nobody can act on in time. `evaluateCaps` halts on both — refusing at load turns a runtime halt into a
  // startup failure, which is the cheaper place to find it.
  ACBP_CAP_SOFT_PERCENT: intFromEnv('ACBP_CAP_SOFT_PERCENT')
    .refine((n) => n >= 1 && n <= 99, 'must be between 1 and 99')
    .optional(),
});

/**
 * Parse the usage cap configuration from an explicit environment record.
 *
 * Pure and total-or-throwing, matching this package's other `parse*` functions. Errors name the FIELD and never
 * echo the value — uniform with the rest of the package so no future field has to remember to opt in.
 */
export function parseUsageCapsConfig(env: EnvRecord): UsageCapsConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    const issues: ConfigIssue[] = r.error.issues.map((i) => ({ field: String(i.path[0] ?? 'unknown'), message: i.message }));
    throw new ConfigValidationError(issues);
  }
  return {
    companyDailyMicros: r.data.ACBP_CAP_COMPANY_DAILY_MICROS ?? USAGE_CAP_DEFAULTS.companyDailyMicros,
    companyMonthlyMicros: r.data.ACBP_CAP_COMPANY_MONTHLY_MICROS ?? USAGE_CAP_DEFAULTS.companyMonthlyMicros,
    accountMultiplier: r.data.ACBP_CAP_ACCOUNT_MULTIPLIER ?? USAGE_CAP_DEFAULTS.accountMultiplier,
    softPercent: r.data.ACBP_CAP_SOFT_PERCENT ?? USAGE_CAP_DEFAULTS.softPercent,
  };
}

/** Read the usage caps from `process.env` at the composition boundary. Fails fast on invalid config. */
export function loadUsageCapsConfig(): UsageCapsConfig {
  return parseUsageCapsConfig(process.env);
}
