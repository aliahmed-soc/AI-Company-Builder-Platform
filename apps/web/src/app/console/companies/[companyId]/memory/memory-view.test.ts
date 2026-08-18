/*
 * ACBP-FE-010 — the memory view mapper's rules.
 *
 * Three of these encode facts the server will never contradict, which is exactly why they need tests:
 * the version chain is derived client-side from a FORWARD-only pointer, the 100-item cap is silent, and
 * edit/delete are owner-only while the response body never says so.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryItemDTO } from '@acbp/contracts';
import { describeMemory, toMemoryView } from './memory-view';

function item(over: Partial<MemoryItemDTO> & { memoryItemId: string }): MemoryItemDTO {
  return {
    type: 'user_fact',
    content: `Content of ${over.memoryItemId}`,
    sourceType: 'interview_answer',
    sourceRef: 'question:q1',
    confidence: null,
    confirmationState: 'proposed',
    supersededBy: null,
    createdAt: '2026-08-18T00:00:00.000Z',
    ...over,
  };
}

describe('toMemoryView — an unread list is not an empty one', () => {
  it('reports unknown when nothing has been read, and none_exist only when the server returned zero', () => {
    // The defect ACBP-FE-007 shipped and an independent review caught: a failed read rendered as a positive
    // server assertion of absence. Encoded here from the start rather than after the fact.
    expect(toMemoryView(null, 'owner', false).itemsState).toBe('unknown');
    expect(toMemoryView([], 'owner', false).itemsState).toBe('none_exist');
  });

  it('claims no counts when the list was never read', () => {
    const view = toMemoryView(null, 'owner', false);
    expect(view.rows).toHaveLength(0);
    const sentence = describeMemory(view).toLowerCase();
    expect(sentence).not.toContain('no memory items');
  });

  it('reports has_items when the server returned any', () => {
    expect(toMemoryView([item({ memoryItemId: 'm1' })], 'owner', false).itemsState).toBe('has_items');
  });
});

describe('toMemoryView — edit and delete are OWNER-ONLY, and the response never says so', () => {
  it('offers both controls to an owner', () => {
    const row = toMemoryView([item({ memoryItemId: 'm1' })], 'owner', false).rows[0];
    expect(row?.edit.kind).toBe('available');
    expect(row?.delete.kind).toBe('available');
  });

  it('refuses both to a viewer, naming the ROLE as the reason', () => {
    // `memory:edit` and `memory:delete` are owner-only while `memory:read` and `memory:write` are
    // owner+viewer. No memory response reveals the caller's role, so the gate is fed by the company read.
    // Enabling these for a viewer would ship a control that the server refuses with an opaque 403.
    const row = toMemoryView([item({ memoryItemId: 'm1' })], 'viewer', false).rows[0];
    expect(row?.edit.kind).toBe('unavailable');
    expect(row?.delete.kind).toBe('unavailable');
    expect(row?.edit.kind === 'unavailable' && row.edit.because).toBe('role');
    expect(row?.delete.kind === 'unavailable' && row.delete.reason.toLowerCase()).toContain('owner');
  });

  it('refuses both on an unrecognised role rather than assuming permission', () => {
    const row = toMemoryView([item({ memoryItemId: 'm1' })], 'something_new', false).rows[0];
    expect(row?.edit.kind).toBe('unavailable');
    expect(row?.edit.kind === 'unavailable' && row.edit.because).toBe('unknown');
  });

  it('refuses both on a SUPERSEDED item even for an owner, because the server will', () => {
    // Only the current version is editable or deletable; the server answers a bare 409 otherwise.
    const rows = toMemoryView([item({ memoryItemId: 'old', supersededBy: 'new' }), item({ memoryItemId: 'new' })], 'owner', false).rows;
    const old = rows.find((r) => r.memoryItemId === 'old');
    expect(old?.edit.kind).toBe('unavailable');
    expect(old?.edit.kind === 'unavailable' && old.edit.because).toBe('lifecycle');
    expect(rows.find((r) => r.memoryItemId === 'new')?.edit.kind).toBe('available');
  });
});

describe('toMemoryView — the version chain is derived, and only forward pointers exist', () => {
  it('builds the backward link by INVERTING supersededBy, never from sourceRef', () => {
    // The DTO has `supersededBy` (forward) and no `supersedes`. `sourceRef` superficially looks like a
    // back-pointer and is caller-supplied and forgeable, so it must never be used as one.
    const rows = toMemoryView([item({ memoryItemId: 'v1', supersededBy: 'v2', sourceRef: 'attacker-controlled' }), item({ memoryItemId: 'v2' })], 'owner', false).rows;
    expect(rows.find((r) => r.memoryItemId === 'v2')?.previousVersionId).toBe('v1');
    expect(rows.find((r) => r.memoryItemId === 'v1')?.previousVersionId).toBeNull();
  });

  it('works in the order the SERVER actually sends — newest first', () => {
    // Every other chain fixture here lists the old version first, which cannot distinguish "inverted the
    // pointer" from "took the preceding array element". The repository orders `created_at desc, id desc`,
    // so production sends the reverse of those fixtures; an implementation that quietly relied on array
    // position would pass every other test in this file and fail in production only.
    const rows = toMemoryView([item({ memoryItemId: 'v2' }), item({ memoryItemId: 'v1', supersededBy: 'v2' })], 'owner', false).rows;
    expect(rows.find((r) => r.memoryItemId === 'v2')?.previousVersionId).toBe('v1');
    expect(rows.find((r) => r.memoryItemId === 'v1')?.previousVersionId).toBeNull();
  });

  it('marks an item superseded from the pointer, not from position', () => {
    const rows = toMemoryView([item({ memoryItemId: 'v1', supersededBy: 'v2' }), item({ memoryItemId: 'v2' })], 'owner', false).rows;
    expect(rows.find((r) => r.memoryItemId === 'v1')?.lifecycle).toBe('superseded');
    expect(rows.find((r) => r.memoryItemId === 'v2')?.lifecycle).toBe('active');
  });

  it('does not invent a predecessor when the superseding item is absent from the page', () => {
    // The forward pointer can name an id the capped page never returned. Inventing a link from it would
    // claim a version the screen cannot show.
    const rows = toMemoryView([item({ memoryItemId: 'v1', supersededBy: 'off-page' })], 'owner', false).rows;
    expect(rows[0]?.previousVersionId).toBeNull();
    expect(rows[0]?.lifecycle).toBe('superseded');
  });
});

describe('toMemoryView — the 100-item cap is silent, so the screen must not claim completeness', () => {
  it('marks history as NOT known when the page was capped', () => {
    // The list has no cursor, no total and no truncation flag. A full page means "there may be more",
    // and "this item has no earlier version" is then a claim the screen cannot support.
    const view = toMemoryView([item({ memoryItemId: 'm1' })], 'owner', true);
    expect(view.capped).toBe(true);
    expect(view.rows[0]?.historyKnown).toBe(false);
  });

  it('marks history as known only on an uncapped page', () => {
    const view = toMemoryView([item({ memoryItemId: 'm1' })], 'owner', false);
    expect(view.rows[0]?.historyKnown).toBe(true);
  });

  it('says so in the announced sentence when capped', () => {
    const sentence = describeMemory(toMemoryView([item({ memoryItemId: 'm1' })], 'owner', true));
    expect(sentence.toLowerCase()).toContain('newest');
  });
});

describe('toMemoryView — fields that must not be dressed up', () => {
  it('labels a null confidence as not scored rather than as zero', () => {
    // `confidence` is null on everything the product itself writes. Rendering null as 0 would show every
    // item as maximally uncertain; rendering an empty meter would imply a score exists.
    expect(toMemoryView([item({ memoryItemId: 'm1', confidence: null })], 'owner', false).rows[0]?.confidenceLabel).toBe('not scored');
  });

  it('shows a real confidence when the server sent one', () => {
    expect(toMemoryView([item({ memoryItemId: 'm1', confidence: 0.5 })], 'owner', false).rows[0]?.confidenceLabel).toContain('0.5');
  });

  it('carries sourceType and sourceRef through verbatim', () => {
    const row = toMemoryView([item({ memoryItemId: 'm1', sourceType: 'user_edit', sourceRef: 'memory:prev' })], 'owner', false).rows[0];
    expect(row?.sourceType).toBe('user_edit');
    expect(row?.sourceRef).toBe('memory:prev');
  });
});

describe('describeMemory — the polite sentence', () => {
  it('is identical for identical input, which is what stops it re-announcing', () => {
    const items = [item({ memoryItemId: 'm1' })];
    expect(describeMemory(toMemoryView(items, 'owner', false))).toBe(describeMemory(toMemoryView(items, 'owner', false)));
  });

  it('CHANGES when the state changes — the half that stability alone does not prove', () => {
    // Purity makes the region quiet; it is distinctness that makes it speak. A constant function would pass
    // the stability test above and announce nothing for the rest of the session, so the four states are
    // asserted to produce four different sentences.
    const sentences = [
      describeMemory(toMemoryView(null, 'owner', false)),
      describeMemory(toMemoryView([], 'owner', false)),
      describeMemory(toMemoryView([item({ memoryItemId: 'm1' })], 'owner', false)),
      describeMemory(toMemoryView([item({ memoryItemId: 'm1' })], 'owner', true)),
    ];
    expect(new Set(sentences).size).toBe(4);
  });

  it('does not claim to be showing everything stored, because deleted items are never listed', () => {
    const sentence = describeMemory(toMemoryView([item({ memoryItemId: 'm1' })], 'owner', false));
    expect(sentence).not.toContain('all ');
    expect(sentence.toLowerCase()).toContain('deleted items are not listed');
  });

  it('never says the platform has learned nothing when the list is empty', () => {
    // No shipped console surface creates memory items, so an empty table is the realistic first-run state.
    // It reflects an absent writer, not an absent understanding.
    const sentence = describeMemory(toMemoryView([], 'owner', false)).toLowerCase();
    expect(sentence).not.toContain('learned');
    expect(sentence).toContain('no memory items');
  });
});
