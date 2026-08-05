// @acbp/contracts — the export manifest (ACBP-P7-001; CDR-078 §3; EXPORT-001, NFR-014).
import { describe, expect, it } from 'vitest';
import { SECRET_PLACEHOLDER } from '../context/context.js';
import {
  EXPORT_OMISSION_REASONS,
  isExportOmissionReason,
  buildExportManifest,
  sanitizeExportText,
  sanitizeExportValue,
  manifestIsFaithful,
  type ExportManifestItem,
  type ExportOmission,
} from './manifest.js';

const item = (over: Partial<ExportManifestItem> = {}): ExportManifestItem => ({
  itemType: 'understanding_document',
  itemId: 'doc-1',
  path: 'understanding/doc-1.json',
  sha256: 'a'.repeat(64),
  rowCount: 1,
  redactionCount: 0,
  ...over,
});

describe('sanitizeExportText', () => {
  it('passes ordinary business prose through untouched, with no redactions', () => {
    const r = sanitizeExportText('We will target independent bakeries in Cairo.');
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(r.text).toBe('We will target independent bakeries in Cairo.');
    expect(r.redactionCount).toBe(0);
  });

  it('REDACTS a secret rather than dropping the whole item — and counts it', () => {
    // THE TENSION THIS RESOLVES. Acceptance asks for BOTH "archive matches in-product data" AND "zero secrets".
    // When a founder has typed their own key into their own document those conflict, and SECURITY-ARCHITECTURE
    // settles it: "archives never contain secret values". So the value goes and the surrounding document stays —
    // dropping the whole document would lose the founder's actual work over one span.
    //
    // The count is what keeps this honest: a redaction that is not reported is an archive quietly differing from
    // the product with nothing saying so.
    const r = sanitizeExportText('Our key is zzSyntheticEntropyFixtureOneForExportTests77 and the plan is to launch in May.');
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(r.text).toContain(SECRET_PLACEHOLDER);
    expect(r.text).not.toContain('zzSyntheticEntropyFixtureOneForExportTests77');
    expect(r.text).toContain('launch in May');
    expect(r.redactionCount).toBe(1);
  });

  it('EXCLUDES what it cannot scan, rather than including it unscanned', () => {
    // CDR-078 §3-G3.3, and the asymmetry is the whole point: a missing document is a complaint, a leaked secret
    // is unrecoverable. Anything that is not a string cannot be run through the blocklist, so it is omitted and
    // enumerated instead of being trusted.
    const unscannable: unknown[] = [undefined, null, 42, {}, [], true];
    for (const bad of unscannable) {
      const r = sanitizeExportText(bad as string);
      expect(r.status).toBe('excluded');
      if (r.status !== 'excluded') throw new Error('unreachable');
      expect(r.reason).toBe('unreadable');
    }
  });

  it('counts every distinct redacted span, not just the first', () => {
    const r = sanitizeExportText('zzSyntheticEntropyFixtureOneForExportTests77 then zzSyntheticEntropyFixtureTwoForExportTests99');
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(r.redactionCount).toBe(2);
  });

  it('counts only the NEWLY redacted spans when the text already carries a placeholder', () => {
    // WRITTEN BECAUSE MUTATION TESTING EXPOSED A HOLE. Deleting the "subtract the placeholders already present"
    // logic left all twelve original cases passing: the re-run case below feeds CLEAN text, which short-circuits
    // before the counting code is ever reached. This is the only shape that reaches it — a partially-sanitized
    // document carrying an earlier redaction AND a fresh secret, which is exactly what re-exporting an edited
    // document looks like.
    //
    // Without the subtraction the old placeholder is reported as a new redaction, inflating the number a founder
    // uses to judge how far the archive departs from their product.
    const mixed = `already ${SECRET_PLACEHOLDER} and new zzSyntheticEntropyFixtureOneForExportTests77`;
    const r = sanitizeExportText(mixed);
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(r.redactionCount).toBe(1);
    expect(r.text).not.toContain('zzSyntheticEntropyFixtureOneForExportTests77');
  });

  it('leaves an already-redacted placeholder alone and does not double-count', () => {
    // Re-running an export must not inflate the count or nest placeholders — canon marks export "re-runnable".
    const once = sanitizeExportText('key zzSyntheticEntropyFixtureOneForExportTests77 here');
    if (once.status !== 'included') throw new Error('unreachable');
    const twice = sanitizeExportText(once.text);
    if (twice.status !== 'included') throw new Error('unreachable');
    expect(twice.text).toBe(once.text);
    expect(twice.redactionCount).toBe(0);
  });
});

describe('sanitizeExportValue', () => {
  it('walks INTO nested JSON and redacts a secret buried at depth', () => {
    // CDR-078 §6.2. `sanitizeExportText` handles one text field; a database row is not a text field. A secret
    // pasted into `payload.notes[2]` is exactly as gone as one in a top-level column, and a walker that only
    // looked at the top level would ship it.
    const r = sanitizeExportValue({ title: 'Q3 plan', payload: { notes: ['fine', 'also fine', 'token zzSyntheticEntropyFixtureOneForExportTests77'] } });
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(JSON.stringify(r.value)).not.toContain('zzSyntheticEntropyFixtureOneForExportTests77');
    expect(JSON.stringify(r.value)).toContain('Q3 plan');
    expect(r.redactionCount).toBe(1);
  });

  it('sums redactions across every branch, not just the first one it finds', () => {
    const r = sanitizeExportValue({ a: 'zzSyntheticEntropyFixtureOneForExportTests77', b: { c: 'zzSyntheticEntropyFixtureTwoForExportTests99' } });
    expect(r.status).toBe('included');
    if (r.status !== 'included') throw new Error('unreachable');
    expect(r.redactionCount).toBe(2);
  });

  it('passes scalars through unchanged and normalises a Date to ISO-8601', () => {
    // Timestamps arrive from the driver as Date objects. NFR-014 wants open formats, and a Date serialised by
    // accident is whatever JSON.stringify decides; making it explicit is what keeps the archive readable.
    const r = sanitizeExportValue({ n: 42, ok: true, nothing: null, when: new Date('2026-08-05T00:00:00.000Z') });
    expect(r).toEqual({ status: 'included', value: { n: 42, ok: true, nothing: null, when: '2026-08-05T00:00:00.000Z' }, redactionCount: 0 });
  });

  it('EXCLUDES THE WHOLE VALUE when any leaf cannot be represented', () => {
    // CDR-078 §6-G4. Dropping just the offending field would leave a row that looks complete and is not — a lie
    // about that row. An enumerated omission is a complaint the founder can act on.
    // `Uint8Array` is what a `bytea` column would arrive as; `JSON.stringify` renders it `{"0":120}`, which is a
    // faithful-looking object that is not the bytes. Class instances and Map/Set collapse to `{}` the same way.
    const unrepresentable: unknown[] = [undefined, () => 1, Symbol('s'), 10n, Number.NaN, Number.POSITIVE_INFINITY, new Map(), new Set(), new Uint8Array([1, 2])];
    for (const bad of unrepresentable) {
      expect(sanitizeExportValue({ good: 'fine', bad })).toEqual({ status: 'excluded', reason: 'unreadable' });
    }
  });

  it('EXCLUDES rather than redacting when a secret sits in a KEY', () => {
    // Redacting keys would collide: two secret-shaped keys both become the placeholder, and one silently
    // overwrites the other — data loss disguised as redaction. Excluding the row says so instead.
    expect(sanitizeExportValue({ zzSyntheticEntropyFixtureOneForExportTests77: 'value' })).toEqual({ status: 'excluded', reason: 'unreadable' });
  });

  it('refuses a structure nested past the depth bound instead of recursing forever', () => {
    // The walker takes `unknown`. A cycle or a pathological depth must cost a refusal, not the process.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 64; i += 1) deep = { deep };
    expect(sanitizeExportValue(deep)).toEqual({ status: 'excluded', reason: 'unreadable' });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(sanitizeExportValue(cyclic)).toEqual({ status: 'excluded', reason: 'unreadable' });
  });

  it('keeps an empty object, an empty array and an empty string — absent is not the same as blank', () => {
    expect(sanitizeExportValue({ o: {}, a: [], s: '' })).toEqual({ status: 'included', value: { o: {}, a: [], s: '' }, redactionCount: 0 });
  });
});

describe('EXPORT_OMISSION_REASONS', () => {
  it('is a closed vocabulary a reader can switch on exhaustively', () => {
    // Free-text reasons would make "why is this missing" unanswerable by anything but a human reading prose,
    // and the manifest exists precisely so a founder can act on the gap.
    expect([...EXPORT_OMISSION_REASONS]).toEqual(['unreadable', 'ownership_unverified', 'truncated']);
    expect(isExportOmissionReason('unreadable')).toBe(true);
    expect(isExportOmissionReason('because_reasons')).toBe(false);
    expect(isExportOmissionReason(undefined)).toBe(false);
  });

  it('has no reason NOTHING can produce — `unsupported_format` was removed for that (CDR-078 §6.5)', () => {
    // It shipped in the manifest slice and never acquired a producer: artifact BYTES are not copied by this
    // ticket, so no stored format is ever rejected. A reader switching on the vocabulary would have treated it
    // as a case that can occur. "Catalogued, reaches nothing" is the failure CDR-074 §5.4 and CDR-075 §4.3 both
    // had to disclose; leaving it here would have been a third, self-inflicted instance.
    expect(EXPORT_OMISSION_REASONS).not.toContain('unsupported_format');
  });

  it('has no reason meaning "contained a secret" — that is a redaction, not an omission', () => {
    // Naming one would invite the wrong behaviour: dropping a whole document over one span. Secrets are redacted
    // in place and counted; only genuinely unusable items are omitted.
    expect(EXPORT_OMISSION_REASONS).not.toContain('contains_secret');
  });
});

describe('buildExportManifest', () => {
  const omission = (over: Partial<ExportOmission> = {}): ExportOmission => ({ itemType: 'artifact', itemId: 'art-9', reason: 'unreadable', ...over });

  it('reports counts derived from the items it was given, never from an intended total', () => {
    // CDR-078 §3-G5. A manifest built from the query plan agrees with itself and disagrees with the archive —
    // CDR-073 §0's shape. There is deliberately NO `expectedCount` parameter: the only number available here is
    // what was actually emitted.
    const m = buildExportManifest({
      accountId: 'acc-1',
      companyId: 'co-1',
      generatedAt: '2026-08-05T00:00:00.000Z',
      items: [item(), item({ itemId: 'doc-2', path: 'understanding/doc-2.json' })],
      omissions: [omission()],
    });
    expect(m.itemCount).toBe(2);
    expect(m.omissionCount).toBe(1);
    expect(m.items).toHaveLength(2);
    expect(m.omissions).toHaveLength(1);
  });

  it('is COMPLETE only when nothing was omitted', () => {
    const clean = buildExportManifest({ accountId: 'acc-1', companyId: 'co-1', generatedAt: '2026-08-05T00:00:00.000Z', items: [item()], omissions: [] });
    const partial = buildExportManifest({ accountId: 'acc-1', companyId: 'co-1', generatedAt: '2026-08-05T00:00:00.000Z', items: [item()], omissions: [omission()] });
    expect(clean.complete).toBe(true);
    expect(partial.complete).toBe(false);
  });

  it('an EMPTY export is complete, and that is not a contradiction', () => {
    // A company with nothing to export has had everything it owns exported. Reporting `complete: false` here
    // would tell a founder something went wrong when nothing did.
    const m = buildExportManifest({ accountId: 'acc-1', companyId: 'co-1', generatedAt: '2026-08-05T00:00:00.000Z', items: [], omissions: [] });
    expect(m.complete).toBe(true);
    expect(m.itemCount).toBe(0);
  });

  it('surfaces the total redaction count across items', () => {
    const m = buildExportManifest({
      accountId: 'acc-1',
      companyId: 'co-1',
      generatedAt: '2026-08-05T00:00:00.000Z',
      items: [item({ redactionCount: 2 }), item({ itemId: 'doc-2', path: 'p2', redactionCount: 3 })],
      omissions: [],
    });
    expect(m.redactionCount).toBe(5);
  });
});

describe('manifestIsFaithful', () => {
  it('is TRUE only when nothing was omitted AND nothing was redacted', () => {
    // The precise answer to "is this everything, exactly as it was?" — which `complete` alone cannot give,
    // because a fully-complete archive can still differ from the product wherever a secret was removed.
    const base = { accountId: 'acc-1', companyId: 'co-1', generatedAt: '2026-08-05T00:00:00.000Z' };
    expect(manifestIsFaithful(buildExportManifest({ ...base, items: [item()], omissions: [] }))).toBe(true);
    expect(manifestIsFaithful(buildExportManifest({ ...base, items: [item({ redactionCount: 1 })], omissions: [] }))).toBe(false);
    expect(manifestIsFaithful(buildExportManifest({ ...base, items: [item()], omissions: [{ itemType: 'artifact', itemId: 'a', reason: 'unreadable' }] }))).toBe(false);
  });
});
