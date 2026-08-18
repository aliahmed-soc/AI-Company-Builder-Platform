/*
 * ACBP-FE-016 — the approvals inbox view mapper.
 *
 * EVERY RISK VALUE IN THIS FILE COMES FROM THE CONTRACT, and that is the whole lesson of the rewrite. The
 * first version of these tests fed `'high'`, `'low'`, `'medium'` and `'critical'` — none of which the
 * `approval_requests` CHECK constraint permits — so the only tests of the tone map exercised inputs the system
 * cannot produce, and a mapping that was wrong for every real row passed green.
 *
 * The fixture therefore takes its risk class from `RISK_CLASSES` itself, and a test below asserts that the
 * screen's ordering IS the contract's ordering rather than a copy of it.
 */
import { describe, expect, it } from 'vitest';
import { MOST_RESTRICTIVE_RISK_CLASS, RISK_CLASSES, reversibilityOf } from '@acbp/contracts';
import type { ApprovalInboxItem } from '@/server/companies/companies-request';
import { INBOX_DEFAULT_PAGE_SIZE, RISK_CLASS_ORDER, toApprovalsView, type ApprovalInboxItemLike } from './approvals-view';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');

function item(over: Partial<ApprovalInboxItemLike> = {}): ApprovalInboxItemLike {
  return {
    approvalRequestId: 'ar-1',
    action: 'publish_landing_page',
    reason: 'The plan calls for a public page before the pilot.',
    expectedResult: 'A page at the company domain, live.',
    preview: 'POST https://example.test/pages { "title": "Pilot" }',
    riskClass: 'external_reversible',
    reversibility: 'reversible',
    scope: 'one_action',
    estimatedCostCredits: 40,
    toolId: 'web.publish',
    toolVersion: 3,
    expiresAt: '2026-08-19T12:00:00.000Z',
    createdAt: '2026-08-18T09:00:00.000Z',
    ...over,
  };
}

describe('the vocabulary is the contract, not a local copy', () => {
  it('uses the contract ordering verbatim', () => {
    // If someone re-declares the classes here, this fails. The first version invented four values that the
    // database CHECK constraint forbids, and nothing noticed.
    expect(RISK_CLASS_ORDER).toEqual(RISK_CLASSES);
  });

  it('every class the database can store is rendered with its OWN rank, not folded into one bucket', () => {
    const ranks = RISK_CLASSES.map((rc) => toApprovalsView([item({ riskClass: rc })], NOW).items[0]?.riskRank);
    expect(ranks).toEqual([0, 1, 2, 3]);
    // The failure the rewrite fixed: every real class collapsing to a single indistinguishable state.
    expect(new Set(ranks).size).toBe(RISK_CLASSES.length);
  });

  it('no real class is ever reported as unrecognised', () => {
    for (const rc of RISK_CLASSES) {
      expect(toApprovalsView([item({ riskClass: rc })], NOW).items[0]?.riskWasUnrecognised, rc).toBe(false);
    }
  });

  it('an unrecognised stored value resolves to the MOST restrictive class, never the least', () => {
    // Deny-by-default, matching `resolveRiskClass`. The dangerous direction is treating an unknown as calm.
    const row = toApprovalsView([item({ riskClass: 'not-a-real-class' })], NOW).items[0];
    expect(row?.riskClass).toBe(MOST_RESTRICTIVE_RISK_CLASS);
    expect(row?.riskWasUnrecognised).toBe(true);
    expect(row?.riskLabel).toContain('not-a-real-class');
    expect(row?.irreversible).toBe(true);
  });
});

describe('reversibility is derived from the risk class, as the database derives it', () => {
  it('matches the contract for every class', () => {
    for (const rc of RISK_CLASSES) {
      const expected = reversibilityOf(rc) === 'irreversible';
      expect(toApprovalsView([item({ riskClass: rc })], NOW).items[0]?.irreversible, rc).toBe(expected);
    }
  });

  it('ignores a stored reversibility that disagrees with the risk class', () => {
    // 0047 ties the two with a CHECK, so they cannot disagree in the database — but if a row ever did, the
    // class is the one the policy engine compares against, and rendering "reversible" would be the unsafe read.
    const row = toApprovalsView([item({ riskClass: 'sensitive_irreversible', reversibility: 'reversible' })], NOW).items[0];
    expect(row?.irreversible).toBe(true);
  });
});

describe('expiry — the one thing the first version said it could not show', () => {
  it('reports an expired request as expired', () => {
    const row = toApprovalsView([item({ expiresAt: '2026-08-18T11:59:59.000Z' })], NOW).items[0];
    expect(row?.expiry).toBe('expired');
  });

  it('treats an expiry exactly at now as expired, not as live', () => {
    // The boundary that matters. `now` is a parameter precisely so this case is reachable in a test.
    expect(toApprovalsView([item({ expiresAt: '2026-08-18T12:00:00.000Z' })], NOW).items[0]?.expiry).toBe('expired');
  });

  it('flags one expiring within the hour', () => {
    expect(toApprovalsView([item({ expiresAt: '2026-08-18T12:30:00.000Z' })], NOW).items[0]?.expiry).toBe('expiring_soon');
  });

  it('leaves a distant expiry live, with no note', () => {
    const row = toApprovalsView([item({ expiresAt: '2026-08-25T12:00:00.000Z' })], NOW).items[0];
    expect(row?.expiry).toBe('live');
    expect(row?.expiryNote).toBe('');
  });

  it('an UNREADABLE expiry is not treated as live', () => {
    // The unsafe fallback would be assuming validity. It is reported as unreadable and counted with expired.
    const view = toApprovalsView([item({ expiresAt: 'not a date' })], NOW);
    expect(view.items[0]?.expiry).toBe('unreadable');
    expect(view.expiredCount).toBe(1);
  });

  it('counts expired and unreadable together, because neither is safely actionable', () => {
    const view = toApprovalsView(
      [item({ approvalRequestId: 'a', expiresAt: '2026-08-01T00:00:00.000Z' }), item({ approvalRequestId: 'b', expiresAt: 'nonsense' }), item({ approvalRequestId: 'c', expiresAt: '2026-09-01T00:00:00.000Z' })],
      NOW,
    );
    expect(view.expiredCount).toBe(2);
  });
});

describe('the page is a page, and says so only when it might not be everything', () => {
  it('a full page warns that there may be more', () => {
    const full = Array.from({ length: INBOX_DEFAULT_PAGE_SIZE }, (_, i) => item({ approvalRequestId: `ar-${String(i)}` }));
    const view = toApprovalsView(full, NOW);
    expect(view.possiblyTruncated).toBe(true);
    expect(view.truncationNote).not.toBeNull();
    expect(view.truncationNote?.toLowerCase()).toContain('minimum');
  });

  it('a partial page makes no such claim', () => {
    const view = toApprovalsView([item()], NOW);
    expect(view.possiblyTruncated).toBe(false);
    expect(view.truncationNote).toBeNull();
  });

  it('the mirrored page size matches what core actually defaults to', () => {
    // `clampInboxLimit(undefined)` is 50 and the request layer sends no limit. Mirrored rather than imported
    // because @acbp/core must not reach a client-reachable module (the ACBP-FE-010 BLOCKER).
    expect(INBOX_DEFAULT_PAGE_SIZE).toBe(50);
  });
});

describe('what the page says about liveness is what the server guarantees', () => {
  it('states that everything listed is still awaiting a decision', () => {
    // `listPending` filters `status = 'pending'` and 0048's CHECK guarantees such a row has no decided_at,
    // revoked_at, superseded_at or consumed_at. The first version warned the opposite.
    const note = toApprovalsView([item()], NOW).livenessNote.toLowerCase();
    expect(note).toContain('awaiting a decision');
    expect(note).not.toMatch(/might (already )?(have been|be) (decided|revoked)/);
  });

  it('claims the order the server actually applies', () => {
    // `orderBy('created_at','desc')`, with a partial index behind it. The first version told the reader not to
    // assume an order the server had in fact chosen.
    expect(toApprovalsView([item()], NOW).orderNote.toLowerCase()).toContain('newest first');
  });

  it('preserves the order it was given', () => {
    const view = toApprovalsView([item({ approvalRequestId: 'a' }), item({ approvalRequestId: 'b' })], NOW);
    expect(view.items.map((i) => i.approvalRequestId)).toEqual(['a', 'b']);
  });
});

describe('scope, cost, tool and preview', () => {
  it('humanises a real scope and flags one the platform does not define', () => {
    expect(toApprovalsView([item({ scope: 'bounded_operating_policy' })], NOW).items[0]?.scopeLabel).toBe('Bounded, operating, policy');
    expect(toApprovalsView([item({ scope: 'invented' })], NOW).items[0]?.scopeLabel).toContain('not a scope');
  });

  it('totals the estimates and names them as estimates', () => {
    const view = toApprovalsView([item({ approvalRequestId: 'a', estimatedCostCredits: 40 }), item({ approvalRequestId: 'b', estimatedCostCredits: 60 })], NOW);
    expect(view.totalEstimatedCredits).toBe(100);
    expect(view.costNote.toLowerCase()).toContain('estimate');
  });

  it('identifies the tool by id AND version, because a version is what runs', () => {
    expect(toApprovalsView([item({ toolId: 'web.publish', toolVersion: 3 })], NOW).items[0]?.toolLabel).toBe('web.publish v3');
  });

  it('passes the preview through verbatim and reports an absent one as absent', () => {
    const raw = 'POST https://example.test/pages { "title": "Pilot" }';
    expect(toApprovalsView([item({ preview: raw })], NOW).items[0]?.preview).toBe(raw);
    expect(toApprovalsView([item({ preview: '' })], NOW).items[0]?.hasPreview).toBe(false);
  });
});

describe('an empty inbox is a real answer', () => {
  it('reports nothing waiting, with no failure vocabulary', () => {
    const view = toApprovalsView([], NOW);
    expect(view.isEmpty).toBe(true);
    for (const word of ['error', 'failed', 'refused', 'unavailable']) {
      expect(view.emptyNote.toLowerCase()).not.toContain(word);
    }
    expect(view.possiblyTruncated).toBe(false);
  });
});

describe('CONTRACT ALIGNMENT — the local shape is the real one', () => {
  it('accepts the real ApprovalInboxItem without a cast', () => {
    /*
     * THE HOUSE PATTERN, and the reason for it is written in `memory-contract-alignment.test.ts`: "a
     * hand-written body encodes what the author BELIEVED the server sends, and in ACBP-FE-005 that belief was
     * wrong". `ApprovalInboxItemLike` is exactly such a hand-written body. This assignment is the check — if
     * the real interface gains a required field, or renames one, this file stops compiling.
     */
    const real: ApprovalInboxItem = {
      approvalRequestId: 'ar-1',
      action: 'a',
      reason: 'r',
      expectedResult: 'e',
      preview: 'p',
      riskClass: 'informational',
      reversibility: 'reversible',
      scope: 'one_action',
      estimatedCostCredits: 1,
      toolId: 't',
      toolVersion: 1,
      expiresAt: '2026-08-19T12:00:00.000Z',
      createdAt: '2026-08-18T09:00:00.000Z',
    };
    const asLocal: ApprovalInboxItemLike = real;
    expect(toApprovalsView([asLocal], NOW).items).toHaveLength(1);
  });
});
