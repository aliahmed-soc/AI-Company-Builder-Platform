/*
 * ACBP-FE-016 — the approvals inbox view mapper.
 *
 * THIS FILE IS A REWRITE, AND WHAT IT REPLACED IS WORTH RECORDING, because the first version failed in the
 * exact way the ticket existed to prevent. It invented a risk vocabulary — `low` / `medium` / `high` /
 * `critical` — none of which the database can hold. The real set is CHECKed in migration 0047 and declared in
 * `@acbp/contracts`: `informational`, `internal_reversible`, `external_reversible`, `sensitive_irreversible`.
 * So every real row fell to the "unknown" branch, and a `sensitive_irreversible` action rendered IDENTICALLY
 * to an `informational` one. The screen withheld the severity the server had supplied on every single row.
 *
 * Its tests passed because they fed `'high'` and `'low'` — values that cannot occur. That is the standing rule
 * ("could a wrong implementation have produced this same green?") violated in the most literal way available:
 * the only tests of the tone map exercised inputs the system cannot produce.
 *
 * THE VOCABULARY IS NOW IMPORTED, NEVER RESTATED. `RISK_CLASSES` and `riskRank` come from the contract, so the
 * ordering here cannot drift from the ordering the policy engine compares against, and adding a fifth class
 * upstream makes this file fail to compile rather than silently mislabel it.
 *
 * WHAT THIS READ ACTUALLY GUARANTEES, checked rather than assumed:
 *   - EVERY ENTRY IS LIVE. `listPending` filters `status = 'pending'`, and 0048's CHECK guarantees a pending
 *     row has no `decided_at`, `revoked_at`, `superseded_at` or `consumed_at`. The first version warned that a
 *     listed request might already be decided or revoked — doubt the server had already resolved, stated
 *     before anything else on the page, in the alarming direction.
 *   - IT IS ORDERED, newest first (`orderBy('created_at','desc')`, with a partial index behind it). The first
 *     version told the reader not to assume an order the server had in fact chosen.
 *   - IT IS A PAGE. `clampInboxLimit(undefined)` is 50, and the request layer passes no limit — so a company
 *     with more than 50 pending approvals silently saw 50, under a heading that read "N waiting".
 *   - EXPIRY IS KNOWN. `expires_at` is NOT NULL on every row; it was simply not in the wire allowlist. It is
 *     now, so the one thing an approver genuinely could not see is the thing this screen leads with.
 */
import { APPROVAL_SCOPES, RISK_CLASSES, isRiskClass, resolveRiskClass, reversibilityOf, riskRank } from '@acbp/contracts';
import type { RiskClass } from '@acbp/contracts';

/**
 * The page size the server applies when no limit is sent, which is what this screen's read does.
 * `clampInboxLimit(undefined) === 50`. Mirrored rather than imported because `@acbp/core` must not be pulled
 * into a client-reachable module — the ACBP-FE-010 BLOCKER — and asserted against core in the test suite.
 */
export const INBOX_DEFAULT_PAGE_SIZE = 50;

/** The shape the request layer sends. Its fidelity to the real `ApprovalInboxItem` is asserted by a test. */
export interface ApprovalInboxItemLike {
  readonly approvalRequestId: string;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly preview: string;
  readonly riskClass: string;
  readonly reversibility: string;
  readonly scope: string;
  readonly estimatedCostCredits: number;
  readonly toolId: string;
  readonly toolVersion: number;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export type ExpiryState = 'expired' | 'expiring_soon' | 'live' | 'unreadable';

export interface ApprovalRowView {
  readonly approvalRequestId: string;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly preview: string;
  readonly hasPreview: boolean;
  /** The contract's own class. An unreadable stored value resolves to the MOST restrictive, never the least. */
  readonly riskClass: RiskClass;
  /** True when the stored value was not a member of the set — the label says so, and the class is not trusted. */
  readonly riskWasUnrecognised: boolean;
  readonly riskLabel: string;
  /** 0-3, the contract's ordering. Higher is more restrictive. */
  readonly riskRank: number;
  readonly irreversible: boolean;
  readonly scopeLabel: string;
  readonly estimatedCostCredits: number;
  readonly toolLabel: string;
  readonly expiresAt: string;
  readonly expiry: ExpiryState;
  readonly expiryNote: string;
}

export interface ApprovalsView {
  readonly items: readonly ApprovalRowView[];
  readonly isEmpty: boolean;
  readonly emptyNote: string;
  readonly totalEstimatedCredits: number;
  readonly costNote: string;
  readonly irreversibleCount: number;
  readonly expiredCount: number;
  /** True when the page is full, so the server may be holding more it was never asked for. */
  readonly possiblyTruncated: boolean;
  readonly truncationNote: string | null;
  readonly orderNote: string;
  /** The single thing this read genuinely cannot answer. Never a manufactured one. */
  readonly livenessNote: string;
}

/** `sensitive_irreversible` → `Sensitive, irreversible`. The raw token is an internal word, not English. */
function humanise(token: string): string {
  return token.replace(/_/g, ', ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * How close to expiry counts as "soon".
 *
 * A THRESHOLD IS A JUDGEMENT AND IS NAMED AS ONE. The platform states no expiry-warning policy anywhere, so
 * this is this screen's choice, not a rule it is enforcing — which is why the copy says "within an hour"
 * rather than implying the server flagged it.
 */
const EXPIRING_SOON_MS = 60 * 60 * 1000;

function expiryStateOf(expiresAt: string, now: number): { state: ExpiryState; note: string } {
  const at = Date.parse(expiresAt);
  // NOT a silent fallback to "live". A timestamp this screen cannot parse is reported as unreadable, because
  // treating it as live is the direction that gets an expired action approved.
  if (Number.isNaN(at)) return { state: 'unreadable', note: 'This request records an expiry this page could not read, so it is not treated as still valid.' };
  if (at <= now) return { state: 'expired', note: 'This request has passed its expiry. It is still listed because the server lists everything pending, but deciding it may no longer have any effect.' };
  if (at - now <= EXPIRING_SOON_MS) return { state: 'expiring_soon', note: 'This request expires within an hour.' };
  return { state: 'live', note: '' };
}

/**
 * `now` IS A PARAMETER, NOT `Date.now()`. A module that reads the clock cannot be tested for the boundary
 * cases that matter — a request expiring one millisecond from now, or one that expired a moment ago — and
 * those two are exactly where an approver is misled.
 */
export function toApprovalsView(items: readonly ApprovalInboxItemLike[], now: number): ApprovalsView {
  const rows: readonly ApprovalRowView[] = items.map((it) => {
    const recognised = isRiskClass(it.riskClass);
    // `resolveRiskClass` NEVER throws and falls back to the most restrictive class — the contract's own
    // deny-by-default. An unrecognised value must not be rendered as the calm end of the scale.
    const riskClass = resolveRiskClass(it.riskClass);
    const expiry = expiryStateOf(it.expiresAt, now);
    return {
      approvalRequestId: it.approvalRequestId,
      action: it.action,
      reason: it.reason,
      expectedResult: it.expectedResult,
      // VERBATIM: the server's own rendering of what would happen.
      preview: it.preview,
      hasPreview: it.preview.trim().length > 0,
      riskClass,
      riskWasUnrecognised: !recognised,
      riskLabel: recognised ? humanise(riskClass) : `${humanise(riskClass)} (the stored value “${it.riskClass}” is not one this platform defines, so it is treated as the most restrictive)`,
      riskRank: riskRank(it.riskClass),
      // DERIVED FROM THE RISK CLASS, which is how the database derives it too (0047's CHECK ties them
      // biconditionally). Reading the stored column instead would let a row that somehow disagreed with itself
      // render as reversible.
      irreversible: reversibilityOf(riskClass) === 'irreversible',
      scopeLabel: (APPROVAL_SCOPES as readonly string[]).includes(it.scope) ? humanise(it.scope) : `${it.scope} (not a scope this platform defines)`,
      estimatedCostCredits: it.estimatedCostCredits,
      toolLabel: `${it.toolId} v${String(it.toolVersion)}`,
      expiresAt: it.expiresAt,
      expiry: expiry.state,
      expiryNote: expiry.note,
    };
  });

  const possiblyTruncated = rows.length >= INBOX_DEFAULT_PAGE_SIZE;

  return {
    items: rows,
    isEmpty: rows.length === 0,
    emptyNote: 'Nothing is waiting on an approval for this company.',
    totalEstimatedCredits: rows.reduce((n, r) => n + r.estimatedCostCredits, 0),
    costNote: 'Credit figures are the ESTIMATE recorded when each request was raised, not a charge. Nothing here has been spent.',
    irreversibleCount: rows.filter((r) => r.irreversible).length,
    expiredCount: rows.filter((r) => r.expiry === 'expired' || r.expiry === 'unreadable').length,
    possiblyTruncated,
    // STATED ONLY WHEN IT MIGHT BE TRUE. The server was asked for no particular number and returns at most 50;
    // a full page is indistinguishable from a full page with more behind it, so the count above it is a floor.
    truncationNote: possiblyTruncated
      ? `This is a page of at most ${String(INBOX_DEFAULT_PAGE_SIZE)} and it is full, so there may be more waiting that this page did not ask for. Treat the counts above as a minimum.`
      : null,
    orderNote: 'Newest first — the order the server returns them in.',
    // THE ONE REAL LIMITATION, and it is small. Everything listed is pending: the read filters on it and a
    // database constraint backs that filter. What this page cannot show is what happened to anything NOT
    // pending, because a decided or revoked request simply never appears here.
    livenessNote:
      'Everything here is still awaiting a decision — the server returns pending requests only. Anything already decided, revoked or superseded is not listed at all, so this page shows what is outstanding rather than a history.',
  };
}

/** Exported for the test that asserts this screen's vocabulary is the contract's, not a local invention. */
export const RISK_CLASS_ORDER: readonly RiskClass[] = RISK_CLASSES;
