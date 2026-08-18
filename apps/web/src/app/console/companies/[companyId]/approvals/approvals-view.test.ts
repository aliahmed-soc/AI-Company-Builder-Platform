/*
 * ACBP-FE-016 — the approvals inbox view mapper.
 *
 * THE WIRE CARRIES ELEVEN FIELDS AND NOT ONE OF THEM IS A STATUS, A TIMESTAMP OR AN EXPIRY. That is the fact
 * this whole screen has to be built around, and it is not an oversight in the mapper upstream — the
 * `ApprovalInboxItem` allowlist names every field deliberately and says why each omission was made. What it
 * means here is concrete:
 *
 *   - the screen CANNOT say whether an approval has expired, or been revoked, or how long it has been waiting;
 *   - the screen CANNOT order by age, because no field carries one;
 *   - and `riskClass`, `reversibility` and `scope` are plain `string`, NOT closed unions, so any tone derived
 *     from them must survive a value nobody anticipated without asserting a severity it cannot know.
 *
 * A screen that sorted this list "newest first", or drew a red badge for an unrecognised risk class, would be
 * inventing all three.
 */
import { describe, expect, it } from 'vitest';
import { toApprovalsView, type ApprovalInboxItemLike } from './approvals-view';

function item(over: Partial<ApprovalInboxItemLike> = {}): ApprovalInboxItemLike {
  return {
    approvalRequestId: 'ar-1',
    action: 'publish_landing_page',
    reason: 'The plan calls for a public page before the pilot.',
    expectedResult: 'A page at the company domain, live.',
    preview: 'POST https://example.test/pages { "title": "Pilot" }',
    riskClass: 'medium',
    reversibility: 'reversible',
    scope: 'company',
    estimatedCostCredits: 40,
    toolId: 'web.publish',
    toolVersion: 3,
    ...over,
  };
}

describe('an empty inbox is a real answer', () => {
  it('reports nothing waiting, with no failure vocabulary', () => {
    const view = toApprovalsView([]);
    expect(view.isEmpty).toBe(true);
    for (const word of ['error', 'failed', 'refused', 'unavailable']) {
      expect(view.emptyNote.toLowerCase()).not.toContain(word);
    }
  });

  it('a non-empty inbox is not empty', () => {
    expect(toApprovalsView([item()]).isEmpty).toBe(false);
  });
});

describe('risk, reversibility and scope are free-form strings, not a closed set', () => {
  it('gives a known risk class its tone', () => {
    expect(toApprovalsView([item({ riskClass: 'high' })]).items[0]?.risk.tone).toBe('high');
  });

  it('an UNRECOGNISED risk class gets no severity tone, and is never dressed as low', () => {
    // The column is `string`. A value this screen has never seen must not be quietly rendered as safe — nor
    // as dangerous. It is shown verbatim with an explicitly unknown tone.
    const view = toApprovalsView([item({ riskClass: 'catastrophic-ish' })]);
    expect(view.items[0]?.risk.tone).toBe('unknown');
    expect(view.items[0]?.risk.label).toBe('catastrophic-ish');
  });

  it('always shows the raw value, so the tone never REPLACES what the server said', () => {
    for (const raw of ['low', 'medium', 'high', 'critical', 'weird']) {
      expect(toApprovalsView([item({ riskClass: raw })]).items[0]?.risk.label).toBe(raw);
    }
  });

  it('an irreversible action is called out, and an unknown reversibility is not called reversible', () => {
    expect(toApprovalsView([item({ reversibility: 'irreversible' })]).items[0]?.irreversible).toBe(true);
    expect(toApprovalsView([item({ reversibility: 'reversible' })]).items[0]?.irreversible).toBe(false);
    // The dangerous default. An unrecognised value must not answer "no" to "is this irreversible?".
    expect(toApprovalsView([item({ reversibility: 'partially' })]).items[0]?.irreversible).toBeNull();
  });
});

describe('the cost is an estimate and is never presented as a charge', () => {
  it('carries the number through', () => {
    expect(toApprovalsView([item({ estimatedCostCredits: 40 })]).items[0]?.estimatedCostCredits).toBe(40);
  });

  it('totals the inbox as a sum of ESTIMATES', () => {
    const view = toApprovalsView([item({ approvalRequestId: 'a', estimatedCostCredits: 40 }), item({ approvalRequestId: 'b', estimatedCostCredits: 60 })]);
    expect(view.totalEstimatedCredits).toBe(100);
    expect(view.costNote.toLowerCase()).toContain('estimate');
  });

  it('a zero-cost request is still shown as zero rather than hidden', () => {
    expect(toApprovalsView([item({ estimatedCostCredits: 0 })]).items[0]?.estimatedCostCredits).toBe(0);
  });
});

describe('what the wire does NOT carry is stated, not silently omitted', () => {
  it('says the read carries no expiry or status', () => {
    // The row asks for "expiry and revocation". Neither is on the wire — the allowlist upstream carries no
    // status column and no timestamp of any kind — so the screen must say so rather than leave an approver
    // to assume everything listed is still actionable.
    const note = toApprovalsView([item()]).unknowableNote.toLowerCase();
    expect(note).toContain('expir');
    expect(note).toContain('revok');
  });

  it('says so even when the inbox is empty, because the limitation is about the read', () => {
    expect(toApprovalsView([]).unknowableNote.toLowerCase()).toContain('expir');
  });

  it('preserves the server order and does not claim one', () => {
    // There is no timestamp to sort by, so any ordering claim would be invented.
    const view = toApprovalsView([item({ approvalRequestId: 'a' }), item({ approvalRequestId: 'b' }), item({ approvalRequestId: 'c' })]);
    expect(view.items.map((i) => i.approvalRequestId)).toEqual(['a', 'b', 'c']);
    expect(view.orderNote.toLowerCase()).toContain('does not say');
  });
});

describe('the tool that would run is identified', () => {
  it('carries id and version together, because a version is what actually runs', () => {
    const view = toApprovalsView([item({ toolId: 'web.publish', toolVersion: 3 })]);
    expect(view.items[0]?.toolLabel).toBe('web.publish v3');
  });
});

describe('the payload preview is shown as given', () => {
  it('is passed through verbatim rather than parsed or prettified', () => {
    // `preview` is the server's own rendering of what would happen. Re-formatting it here would mean this
    // screen showing something the approver's decision was not actually about.
    const raw = 'POST https://example.test/pages { "title": "Pilot" }';
    expect(toApprovalsView([item({ preview: raw })]).items[0]?.preview).toBe(raw);
  });

  it('an empty preview says the server supplied none rather than rendering a blank box', () => {
    const view = toApprovalsView([item({ preview: '' })]);
    expect(view.items[0]?.preview).toBe('');
    expect(view.items[0]?.hasPreview).toBe(false);
  });
});

describe('counts', () => {
  it('counts irreversible requests separately, and excludes the unknown ones from that count', () => {
    const view = toApprovalsView([
      item({ approvalRequestId: 'a', reversibility: 'irreversible' }),
      item({ approvalRequestId: 'b', reversibility: 'reversible' }),
      item({ approvalRequestId: 'c', reversibility: 'mystery' }),
    ]);
    expect(view.irreversibleCount).toBe(1);
    // The third is neither counted as irreversible nor treated as safe; it is reported on its own.
    expect(view.unknownReversibilityCount).toBe(1);
    expect(view.items).toHaveLength(3);
  });
});
