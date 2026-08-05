// @acbp/contracts — the export classification and its coverage engine (ACBP-P7-001; CDR-078 §6).
import { describe, expect, it } from 'vitest';
import {
  EXPORT_COLLECTIONS,
  EXPORT_EXCLUSIONS,
  EXPORT_EXCLUSION_REASONS,
  exportCollectionTables,
  isExportCollectionTable,
  exportCoverage,
  exportOrderBy,
} from './collections.js';

/** Every company-scoped table, as the classification claims them. The real schema is checked in real-PG. */
const classified = [...exportCollectionTables(), ...EXPORT_EXCLUSIONS.map((e) => e.table)];

describe('the export classification', () => {
  it('names every table EXACTLY ONCE across the two lists', () => {
    // CDR-078 §6-G1. A table named twice — in both lists, or twice in one — makes "is this exported?" a question
    // with two answers, and the coverage guard below would still pass because the union would still cover it.
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const table of classified) {
      if (seen.has(table)) duplicated.push(table);
      seen.add(table);
    }
    expect(duplicated).toEqual([]);
  });

  it('gives every exclusion a reason from the closed vocabulary', () => {
    // Free-text reasons would make the exclusion list unreviewable: the owner has to be able to disagree with a
    // RULING (CDR-078 §7.3 flags exactly that), and a ruling has to be a value, not a sentence.
    for (const exclusion of EXPORT_EXCLUSIONS) {
      expect(EXPORT_EXCLUSION_REASONS).toContain(exclusion.reason);
    }
  });

  it('declares a NON-EMPTY sort key on every collection', () => {
    // Without one the row order is whatever PostgreSQL returns, which makes the per-item sha256 in the manifest
    // meaningless: two exports of unchanged data would carry different digests, and a founder checking an archive
    // against its own inventory could never tell a reordering from a corruption.
    for (const collection of EXPORT_COLLECTIONS) {
      expect(collection.orderBy.length).toBeGreaterThan(0);
    }
  });

  it('sorts the two tables WITHOUT an `id` column by their real composite keys', () => {
    // `company_profiles` is keyed by version and `interview_answers` by (question_id, revision). A blanket
    // `order by id` would have thrown on both — and a blanket `order by created_at` would have ordered them by a
    // non-unique column, which is a shuffle with extra steps.
    expect(exportOrderBy('company_profiles')).toEqual(['version']);
    expect(exportOrderBy('interview_answers')).toEqual(['question_id', 'revision']);
  });

  it('has no sort key for a table it does not export', () => {
    // The repository derives ordering from this lookup, so a miss must be a refusal rather than an empty ORDER BY.
    expect(exportOrderBy('audit_events')).toBeUndefined();
    expect(exportOrderBy('nope')).toBeUndefined();
  });

  it('carries a note on every entry, so a reader never has to infer the ruling', () => {
    for (const entry of [...EXPORT_COLLECTIONS, ...EXPORT_EXCLUSIONS]) {
      expect(entry.note.length).toBeGreaterThan(0);
    }
  });

  it('excludes the tables holding OTHER PEOPLE, the audit trail, and the platform books', () => {
    // The three exclusion rulings with the most consequence, pinned by name. `memberships` carries colleagues'
    // identities; `audit_events` has its own reason-captured export surface (API-CONTRACTS :75); `usage_events`
    // is the platform's billing record. If any of these silently becomes exported, this fails.
    const excluded = new Set(EXPORT_EXCLUSIONS.map((e) => e.table));
    for (const table of ['memberships', 'company_memberships', 'audit_events', 'usage_events', 'credit_transactions']) {
      expect(excluded.has(table)).toBe(true);
      expect(isExportCollectionTable(table)).toBe(false);
    }
  });

  it('exports the founder’s own work — their words, their understanding, their plan, their documents', () => {
    // The other direction, and the one acceptance actually names. Each of these IS the founder's work product;
    // an archive without them does not "match in-product data" whatever else it contains.
    for (const table of ['interview_answers', 'memory_items', 'understanding_documents', 'strategy_options', 'decisions', 'roadmaps', 'tasks', 'artifacts']) {
      expect(isExportCollectionTable(table)).toBe(true);
    }
  });

  it('rejects anything not in the allowlist, including near-misses and non-strings', () => {
    // This predicate is what keeps "generic reader" from meaning "any table the caller names" (CDR-078 §6.1).
    for (const bad of ['tasks; drop table tasks', 'TASKS', 'task', '', undefined, null, 42, {}]) {
      expect(isExportCollectionTable(bad)).toBe(false);
    }
  });
});

describe('exportCoverage', () => {
  it('reports NOTHING unclassified or stale when the live schema matches the lists', () => {
    expect(exportCoverage(classified)).toEqual({ unclassified: [], stale: [] });
  });

  it('reports a NEW company-scoped table as unclassified', () => {
    // CDR-078 §6-G2, and the whole reason this function exists: a future migration adds a table, nobody rules on
    // it, and the archive silently stops matching the product. This is what fails instead.
    expect(exportCoverage([...classified, 'brand_new_founder_table'])).toEqual({ unclassified: ['brand_new_founder_table'], stale: [] });
  });

  it('reports a classified table that no longer exists as stale', () => {
    // The opposite drift: a dropped or renamed table leaves an entry claiming to export something that is gone.
    // Left unreported, the export would fail at read time on a table the classification still swears is live.
    const withoutTasks = classified.filter((t) => t !== 'tasks');
    expect(exportCoverage(withoutTasks)).toEqual({ unclassified: [], stale: ['tasks'] });
  });

  it('reports BOTH directions at once rather than stopping at the first', () => {
    // A guard that returns on the first problem makes the second one a second CI round-trip.
    const drifted = [...classified.filter((t) => t !== 'goals'), 'another_new_table'];
    expect(exportCoverage(drifted)).toEqual({ unclassified: ['another_new_table'], stale: ['goals'] });
  });

  it('returns sorted, de-duplicated names so a failure message is stable', () => {
    const result = exportCoverage([...classified, 'zzz_table', 'aaa_table', 'zzz_table']);
    expect(result.unclassified).toEqual(['aaa_table', 'zzz_table']);
  });

  it('treats a non-array input as a schema it could not read, and reports every table stale', () => {
    // Fail LOUD, not open. An empty or unreadable table list must never look like "everything is classified".
    expect(exportCoverage(undefined as unknown as string[]).stale).toEqual([...classified].sort());
  });
});
