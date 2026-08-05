// @acbp/database — the export reader's refusals and its query shape (ACBP-P7-001; CDR-078 §6.1).
//
// What the reader RETURNS is proven against real PostgreSQL. What it REFUSES, and the ORDER BY it builds, are
// proven here: both are decided before any row exists, and a real-PG test on a handful of rows would pass on
// insertion-order luck even with the ordering removed entirely.
import { describe, it, expect } from 'vitest';
import { ExportRepository, type ExportExecutor } from './export-repository.js';

interface Recorded {
  table?: unknown;
  orderBy: unknown[];
  limit?: unknown;
}

/** A stand-in that records the query the repository builds. Never reached by the refusal cases below. */
function recordingExecutor(rows: Record<string, unknown>[] = []): { db: ExportExecutor; recorded: Recorded } {
  const recorded: Recorded = { orderBy: [] };
  const chain = {
    selectAll: () => chain,
    orderBy: (column: unknown) => {
      recorded.orderBy.push(column);
      return chain;
    },
    limit: (n: unknown) => {
      recorded.limit = n;
      return chain;
    },
    execute: () => Promise.resolve(rows),
  };
  const db = {
    selectFrom: (table: unknown) => {
      recorded.table = table;
      return chain;
    },
  };
  return { db: db as unknown as ExportExecutor, recorded };
}

describe('ExportRepository.readCollection', () => {
  it('REFUSES a table outside the export allowlist, before touching the database', () => {
    // The whole trade in CDR-078 §6.1: a generic reader is safer than a mapper per entity ONLY while "generic"
    // cannot mean "any table the caller names". The refusal comes first, so a wrong name never reaches a query.
    const { db, recorded } = recordingExecutor();
    const repo = new ExportRepository(db);
    for (const table of ['audit_events', 'memberships', 'users', 'tasks; drop table tasks', 'TASKS', '']) {
      expect(() => repo.readCollection(table, 10)).toThrow(/not an exported collection/i);
    }
    expect(recorded.table).toBeUndefined();
  });

  it('REFUSES a limit that is not a positive whole number', () => {
    // An unbounded or nonsensical read is the memory hazard CDR-078 §6.4 bounds. `0` and `-1` would silently
    // return nothing, which reads as "this collection is empty" — the under-delivery failure ADR-002 is about.
    const { db, recorded } = recordingExecutor();
    const repo = new ExportRepository(db);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number]) {
      expect(() => repo.readCollection('tasks', limit)).toThrow(/limit/i);
    }
    expect(recorded.table).toBeUndefined();
  });

  it('orders by the DECLARED sort key and bounds the read', async () => {
    const { db, recorded } = recordingExecutor([{ id: 'a' }]);
    await new ExportRepository(db).readCollection('tasks', 25);
    expect(recorded.table).toBe('tasks');
    expect(recorded.orderBy).toEqual(['id']);
    expect(recorded.limit).toBe(25);
  });

  it('orders a composite-key collection by EVERY declared column, most significant first', async () => {
    // `interview_answers` has no `id`. Ordering it by `question_id` alone leaves revisions of the same answer in
    // arbitrary order — a partial sort looks sorted and is not, which is the failure mode worth pinning.
    const { db, recorded } = recordingExecutor();
    await new ExportRepository(db).readCollection('interview_answers', 5);
    expect(recorded.orderBy).toEqual(['question_id', 'revision']);
  });

  it('throws SYNCHRONOUSLY on a refusal, so an un-awaited call cannot swallow it', () => {
    // An `async` method would turn every refusal into a rejected promise. A caller that assembles reads before
    // awaiting them would then convert a programming error into an unhandled rejection — a refusal nobody sees,
    // in the one code path whose entire job is to be complete.
    const { db } = recordingExecutor();
    const repo = new ExportRepository(db);
    let threwSynchronously = false;
    try {
      // Deliberately NOT awaited: an async method would make this a rejected promise instead of a throw, and the
      // `catch` below would never run.
      void repo.readCollection('audit_events', 10);
    } catch {
      threwSynchronously = true;
    }
    expect(threwSynchronously).toBe(true);
  });
});
