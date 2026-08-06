// @acbp/core — the API request limit (ACBP-P7-013; CDR-081; CDR-008 §8; NFR-010).
//
// ── WHAT THIS BOUNDS, AND WHAT IT DOES NOT ───────────────────────────────────────────────────────────────────
//
// Bounds REQUEST FREQUENCY per verified session and per account, against CDR-008 §8's ruled figures. It is not
// the spend cap: NFR-015's ceiling bounds MONEY per company over a day and a month, from `usage_events` at the
// model gateway, and the two share no key, no window, no unit and no storage (CDR-081 §5). One request can spend
// an unbounded amount of money and a thousand can spend none, which is why ADR-003 lists them separately.
//
// It writes NOTHING to `usage_events`. A usage event means the platform did metered work; a throttled request did
// none, and inflating the ledger would make the spend cap and the reconciliation job (launch gate 7) disagree
// with reality — the one way these two limiters COULD contradict each other, avoided deliberately.
//
// It does not bound unauthenticated traffic, the Clerk-hosted auth surface, or the signed webhook route. Each
// exclusion has a reason and they are in CDR-081 §6, not left to be inferred from the absence of a call.
//
// ── FAIL-CLOSED, AND WHY THAT COSTS NOTHING HERE ─────────────────────────────────────────────────────────────
//
// If the bucket cannot be consulted, the limiter cannot bound anything, so admitting would be unbounded by
// definition. It refuses instead — and the refusal costs no real availability, because every request that reaches
// this point needs the same database a moment later for its actual work. A limiter that fails OPEN fails open
// precisely during the database trouble that a traffic flood causes.
//
// The refusal is reported as `unavailable`, NOT as `throttled`: telling a caller "you are sending too many
// requests" when the truth is "we could not tell" is the same class of lie as a section reporting `0` when it
// means `we could not count` (CDR-076's rule). The two map to different statuses and read differently in logs.
import { consumeBucket, type DatabaseClient, type RateLimitScopeKind } from '@acbp/database';
import { consumeTokens, rateLimitRule, MILLI, type RateLimitRule } from '@acbp/contracts';
import { REQUEST_LIMIT_DEFAULTS } from '@acbp/config';
import type { Logger } from '@acbp/observability';

/**
 * The outcome of one limit check.
 *
 * `scope` on a refusal names WHICH limit refused. Without it a throttled founder cannot tell "I am clicking too
 * fast" from "my whole account is busy", and an operator cannot tell whether the session or the account ceiling
 * is the one that binds — the same reason the emergency-stop evidence names which scopes halted (CDR-072 §0).
 */
export type RequestLimitOutcome =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'throttled'; readonly scope: RateLimitScopeKind; readonly retryAfterSeconds: number }
  | { readonly kind: 'unavailable' };

/** CDR-008 §8's two rules, built once. `rateLimitRule` throws on a rule that could never refuse or never admit. */
const SESSION_RULE: RateLimitRule = rateLimitRule({
  perMinute: REQUEST_LIMIT_DEFAULTS.sessionPerMinute,
  burst: REQUEST_LIMIT_DEFAULTS.sessionBurst,
});
const ACCOUNT_RULE: RateLimitRule = rateLimitRule({ perMinute: REQUEST_LIMIT_DEFAULTS.accountPerMinute });

const RULES: Readonly<Record<RateLimitScopeKind, RateLimitRule>> = {
  session: SESSION_RULE,
  account: ACCOUNT_RULE,
};

export interface RequestLimitOptions {
  readonly at?: Date;
  readonly logger?: Logger;
}

/**
 * Consume one request against one scope's bucket.
 *
 * Runs on the plain client with NO tenant scope, because the table is global by design — a session bucket is
 * consulted before any account is known, which is the ordering that lets this run ahead of the Clerk Backend API
 * call it is protecting (CDR-081 §3.3).
 */
export async function checkRequestLimit(
  client: DatabaseClient,
  scopeKind: RateLimitScopeKind,
  scopeKey: string,
  options: RequestLimitOptions = {},
): Promise<RequestLimitOutcome> {
  // An absent key cannot be metered, and metering everything with an absent key under ONE shared bucket would
  // let any caller throttle every other caller. Refused as unavailable rather than admitted.
  if (scopeKey === '') return { kind: 'unavailable' };

  const rule = RULES[scopeKind];
  const at = options.at ?? new Date();

  let result: { allowed: boolean; remainingMilli: number };
  try {
    result = await consumeBucket(client.kysely, {
      scopeKind,
      scopeKey,
      capacityMilli: rule.capacityMilli,
      refillMilliPerSecond: rule.refillMilliPerSecond,
      costMilli: MILLI,
      at,
    });
  } catch {
    // Caught UNCONDITIONALLY and never rethrown with detail: a provider/database exception's text is not
    // permitted to cross this boundary. The blast radius is platform-wide and that is stated here rather than
    // discovered — the same posture, and the same disclosure, as `readSpendTotals` (CDR-075).
    // The SCOPE KIND only — never the key. The key identifies a session or an account, and a rate-limit log
    // line is exactly the high-volume place where an identifier would accumulate at scale.
    options.logger?.warn('request_limit.unavailable', { metadata: { scopeKind } });
    return { kind: 'unavailable' };
  }

  if (result.allowed) return { kind: 'allowed' };

  // Retry advice is derived by the SPECIFICATION from the balance the database decided against, so the number a
  // caller is told matches the arithmetic that refused them. `consumeTokens` on a refusal spends nothing, so
  // this cannot itself consume a token.
  const advice = consumeTokens(rule, { milli: result.remainingMilli, atMs: at.getTime() }, at.getTime());
  options.logger?.info('request_limit.throttled', { metadata: { scopeKind } });
  return { kind: 'throttled', scope: scopeKind, retryAfterSeconds: advice.retryAfterSeconds };
}
