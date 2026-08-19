// ACBP-API-011 — the account usage rollup read (apps/web; ACBP-P6-009; CDR-073; trust-critical #14).
//
// ── WHY THIS IS ACCOUNT-SCOPED AND NOT A COMPANY ROUTE ──────────────────────────────────────────────────────────
//
// A rollup spans the account's companies by design, so RLS legitimately cannot narrow it and the AUTHORIZATION is
// the only thing standing between a viewer and the account's total spend. `readCreditLedger`'s review-pass-1 HIGH
// is the precedent this must not repeat: that function first ran in a COMPANY scope, so it checked the caller's
// company-membership role, and a company owner who was only an account VIEWER would have been handed the whole
// account's spending. Core runs this in an account scope for exactly that reason, and putting the surface under
// `/api/companies/{id}/…` would have re-created the confusion at the URL even with core doing the right thing.
//
// ── THE READ ONLY, AND THAT IS A RULING RATHER THAN AN OVERSIGHT ────────────────────────────────────────────────
//
// `packages/core/src/usage/index.ts` states that `rebuildAccountUsageRollup` is *"deliberately reachable from NO
// API route"*: whether an account owner may trigger a rebuild on demand is an open owner decision (CDR-073 §3.2),
// and NO `usage:rebuild` authz action exists for a route to authorize against. `reconcileAccountUsageRollup` is the
// same question with a write and an alert threshold attached. Surfacing either would answer a question nobody
// asked, so neither is here — this file exposes `readAccountUsageRollup` and nothing else.
//
// ⚠️ WHAT THIS RETURNS IS A CACHE, NOT EVIDENCE (CDR-073 §1-G1). It is a reporting read. Nothing may authorize a
// billing, limit or entitlement decision from it; when it disagrees with the ledger, the LEDGER is right and this
// row is a bug. Any surface presenting these figures as an invoice would be asserting something the platform does
// not claim.
import { resolveInternalUserForRequest, type ResolveInternalUserDeps } from '../identity/resolve-internal-user.js';
import { createLogger, createRootContext, type Logger } from '@acbp/observability';
import type { ReadAccountUsageRollupParams, ReadAccountUsageRollupResult, RebuildAccountUsageRollupOptions, RequestLimitOutcome, ProvisionResult } from '@acbp/core';

/**
 * The figures, as this layer publishes them.
 *
 * AN ALLOWLIST over `RollupFigures`' four lanes, named one at a time. `RollupFigures` is a domain type keyed by
 * `USAGE_ROLLUP_LANES`, and forwarding it wholesale would publish a lane added tomorrow without anyone deciding to
 * — the approvals-inbox lesson (CDR-088 §2.1c) applied to the numbers that describe money.
 */
export interface AccountUsageView {
  /** `YYYY-MM-01`, echoed back so a client can never mis-attribute figures to the period it asked for. */
  readonly periodStart: string;
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** MICROS, not currency units, and named so. A client that reads this as dollars is out by a factor of a million. */
  readonly estimatedCostMicros: number;
  /** ISO-8601 — WHEN the projection was computed, which is what makes a stale figure recognisable as stale. */
  readonly computedAt: string;
}

export type UsageRequestResult =
  | { readonly status: 'ok'; readonly usage: AccountUsageView }
  /**
   * The period has NEVER been computed — deliberately NOT the same as a period whose figures are zero, and
   * deliberately not a 404.
   *
   * Core draws this distinction explicitly and it survives to the wire: "computed and zero" and "never computed"
   * are different facts, and only the first is safe to show as a total. A surface that rendered `not_computed` as
   * "0" would invent a measurement nobody took.
   */
  | { readonly status: 'not_computed'; readonly periodStart: string }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 §8's request ceiling refused this call (ACBP-P7-013; CDR-082; NFR-010). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly status: 'forbidden' }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'invalid_period' };

/** The usage operations this use case needs (satisfied by the composed @acbp/core runtime). */
export interface UsageOps {
  /** CDR-008 §8's per-ACCOUNT ceiling (ACBP-P7-013; CDR-082). Required, never optional. */
  checkRequestLimit(scopeKind: 'session' | 'account', scopeKey: string): Promise<RequestLimitOutcome>;
  ensurePersonalAccount(userId: string, options?: { correlationId?: string; logger?: Logger }): Promise<ProvisionResult>;
  readAccountUsageRollup(params: ReadAccountUsageRollupParams, options?: RebuildAccountUsageRollupOptions): Promise<ReadAccountUsageRollupResult>;
}

export interface UsageRequestDeps {
  readonly identity?: ResolveInternalUserDeps;
  readonly usage?: UsageOps;
}

async function usageOps(deps: UsageRequestDeps): Promise<UsageOps> {
  if (deps.usage !== undefined) return deps.usage;
  const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
  return getClerkIdentityRuntime();
}

/** ISO-8601, or the raw value when it cannot be read — TOTAL, on the `toIsoOrRaw` precedent. */
function toIsoOrRaw(value: unknown): string {
  const at = new Date(value as string | number | Date);
  return Number.isNaN(at.getTime()) ? String(value) : at.toISOString();
}

/**
 * Read the caller's own account usage projection for one period (`usage:read` → ACCOUNT OWNER ONLY, in `@acbp/core`).
 *
 * NO AUTHORIZATION CHECK HERE, on the standing rule (CDR-087 §1): core resolves the caller's ACCOUNT membership and
 * decides. `periodStart` is forwarded RAW — `ReadAccountUsageRollupParams` types it `unknown` precisely so, and
 * refusing a malformed period is core's job. Re-validating the format here would create a second authority that
 * drifts the first time `isUsagePeriodStart` changes.
 *
 * THE ACCOUNT IS THE CALLER'S OWN, resolved from the server-verified session — never a request parameter. There is
 * no account selector on this surface at all, which is what makes "read another account's spend" unexpressible
 * rather than merely refused.
 */
export async function getAccountUsageForRequest(periodStart: unknown, deps: UsageRequestDeps = {}): Promise<UsageRequestResult> {
  const resolution = await resolveInternalUserForRequest(deps.identity ?? {});
  switch (resolution.status) {
    case 'unauthenticated':
      return { status: 'unauthenticated' };
    case 'email_unverified':
      return { status: 'email_unverified' };
    case 'rate_limited':
      return { status: 'rate_limited', retryAfterSeconds: resolution.retryAfterSeconds };
    case 'session_unavailable':
    case 'unavailable':
      return { status: 'unavailable' };
    case 'deleted':
      return { status: 'forbidden' };
    case 'not_found':
      return { status: 'not_found' };
    case 'active':
      break;
  }

  const ops = await usageOps(deps);
  const logger = createLogger({ component: 'usage', context: createRootContext() });
  const provision = await ops.ensurePersonalAccount(resolution.userId, { logger });
  const limit = await ops.checkRequestLimit('account', provision.accountId);
  if (limit.kind === 'throttled') return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  if (limit.kind === 'unavailable') return { status: 'unavailable' };

  const r = await ops.readAccountUsageRollup({ userId: resolution.userId, accountId: provision.accountId, periodStart }, {});
  switch (r.status) {
    case 'ok':
      return {
        status: 'ok',
        usage: {
          periodStart: r.periodStart,
          eventCount: r.figures.eventCount,
          inputTokens: r.figures.inputTokens,
          outputTokens: r.figures.outputTokens,
          estimatedCostMicros: r.figures.estimatedCostMicros,
          computedAt: toIsoOrRaw(r.computedAt),
        },
      };
    case 'not_computed':
      return { status: 'not_computed', periodStart: r.periodStart };
    case 'invalid_period':
      return { status: 'invalid_period' };
    // BOTH map to the same opaque 403, and the DENIAL REASON IS DROPPED HERE. `AccountAccessDenialReason` names why
    // account access failed — no such account, no membership, an inactive one — and echoing it would let an
    // unauthenticated-in-practice caller enumerate account state. "Not allowed" and "not a member" answer alike, on
    // the no-oracle rule this codebase applies to every other refusal.
    case 'forbidden':
    case 'denied':
      return { status: 'forbidden' };
  }
}
