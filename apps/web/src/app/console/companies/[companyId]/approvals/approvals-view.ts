/*
 * ACBP-FE-016 — the approvals inbox, mapped from a read that deliberately carries very little.
 *
 * `ApprovalInboxItem` IS AN ALLOWLIST, NOT A REDACTION, and its own comment says so: `listApprovalInbox`
 * returns every column of `approval_requests`, and the request layer names the eleven fields that may cross
 * the wire so that a column added later is invisible until a human adds it. `data` — the raw tool payload —
 * is dropped as "the single highest leak risk on this table".
 *
 * WHAT THAT LEAVES THIS SCREEN UNABLE TO SAY, and it is exactly the half of the row it cannot deliver:
 *
 *   NO STATUS      — nothing distinguishes a live request from one already decided or revoked.
 *   NO TIMESTAMP   — not created, not expiring. So no age, no countdown, and NO ORDERING of our own: a list
 *                    sorted "newest first" would be sorted by nothing.
 *   NO EXPIRY      — the row asks for it; the wire has no field for it.
 *
 * Every one of those is stated on the screen rather than left for an approver to assume. An inbox that looks
 * complete while silently omitting whether its entries are still actionable is worse than one that says it
 * does not know.
 *
 * THE THREE CLASSIFYING FIELDS ARE `string`, NOT UNIONS. `riskClass`, `reversibility` and `scope` come
 * straight from the database as free text, so anything derived from them must survive a value nobody
 * anticipated. A tone is therefore advisory and never replaces the raw word, and an unrecognised
 * reversibility answers `null` to "is this irreversible?" rather than `false` — the safe default is "unknown",
 * because the unsafe one silently reassures.
 */

/** The shape the request layer sends. Declared structurally so this module needs no server import. */
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
}

export type RiskTone = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface ApprovalRowView {
  readonly approvalRequestId: string;
  readonly action: string;
  readonly reason: string;
  readonly expectedResult: string;
  readonly preview: string;
  readonly hasPreview: boolean;
  /** `label` is always the server's raw word; `tone` is advisory and may be `unknown`. */
  readonly risk: { readonly label: string; readonly tone: RiskTone };
  readonly reversibility: string;
  /** `true`/`false` only for a value this screen recognises. `null` means the server said something else. */
  readonly irreversible: boolean | null;
  readonly scope: string;
  readonly estimatedCostCredits: number;
  readonly toolLabel: string;
}

export interface ApprovalsView {
  readonly items: readonly ApprovalRowView[];
  readonly isEmpty: boolean;
  readonly emptyNote: string;
  readonly totalEstimatedCredits: number;
  readonly costNote: string;
  readonly irreversibleCount: number;
  readonly unknownReversibilityCount: number;
  /** What this read cannot tell anyone. Always present — the limitation is about the read, not the data. */
  readonly unknowableNote: string;
  readonly orderNote: string;
}

const RISK_TONES: Readonly<Record<string, RiskTone>> = { low: 'low', medium: 'medium', high: 'high', critical: 'critical' };

/** Recognised reversibility words. Anything else answers `null` — see the header. */
function irreversibilityOf(reversibility: string): boolean | null {
  if (reversibility === 'irreversible') return true;
  if (reversibility === 'reversible') return false;
  return null;
}

const UNKNOWABLE_NOTE =
  'This list cannot tell you whether an entry is still live. The read carries no status and no timestamp of any kind, so nothing here shows when a request was raised, whether it has EXPIRED, or whether it has been REVOKED — and an entry that has already been decided would look identical to one still waiting.';

const ORDER_NOTE = 'Shown in the order the server returned. It does not say how it ordered them, and there is no date on the wire to sort by, so this page does not claim an order of its own.';

const COST_NOTE = 'Credit figures are the ESTIMATE recorded when each request was raised, not a charge. Nothing here has been spent, and approving does not guarantee the estimate.';

export function toApprovalsView(items: readonly ApprovalInboxItemLike[]): ApprovalsView {
  const rows: readonly ApprovalRowView[] = items.map((it) => ({
    approvalRequestId: it.approvalRequestId,
    action: it.action,
    reason: it.reason,
    expectedResult: it.expectedResult,
    // VERBATIM. `preview` is the server's own rendering of what would happen; re-formatting it would mean
    // showing an approver something their decision was not actually about.
    preview: it.preview,
    hasPreview: it.preview.trim().length > 0,
    risk: { label: it.riskClass, tone: RISK_TONES[it.riskClass] ?? 'unknown' },
    reversibility: it.reversibility,
    irreversible: irreversibilityOf(it.reversibility),
    scope: it.scope,
    estimatedCostCredits: it.estimatedCostCredits,
    toolLabel: `${it.toolId} v${String(it.toolVersion)}`,
  }));

  return {
    items: rows,
    isEmpty: rows.length === 0,
    emptyNote: 'Nothing is waiting on an approval for this company.',
    totalEstimatedCredits: rows.reduce((n, r) => n + r.estimatedCostCredits, 0),
    costNote: COST_NOTE,
    irreversibleCount: rows.filter((r) => r.irreversible === true).length,
    // COUNTED SEPARATELY, never folded into either side. An entry whose reversibility this screen does not
    // recognise is not evidence that it is safe.
    unknownReversibilityCount: rows.filter((r) => r.irreversible === null).length,
    unknowableNote: UNKNOWABLE_NOTE,
    orderNote: ORDER_NOTE,
  };
}
