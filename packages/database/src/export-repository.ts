// @acbp/database — the company-scoped export reader (ACBP-P7-001; CDR-078 §6.1; EXPORT-001; invariant 19).
//
// ── WHY ONE GENERIC READER, AND NOT A METHOD PER ENTITY ──────────────────────────────────────────────────────
//
// A bespoke read per collection can forget a column, and nothing would ever say so: the archive would look
// complete to every test written against it, which is exactly ADR-002's failure — the founder discovers what is
// missing only after they have left. A generic whole-row read cannot forget a column. What it CAN do is pick up
// a new one, and that lands in the secret guard, which redacts, counts and reports.
//
// The trade only holds while "generic" cannot mean "any table the caller names". Three things keep it honest:
//
//   1. the table must be in `EXPORT_COLLECTIONS` — a closed set in `@acbp/contracts`, checked HERE rather than
//      trusted from the caller's type, because a type is a promise and this is a query builder;
//   2. the ORDER BY comes from the same declaration, never from an argument, so no caller can reorder an archive;
//   3. the read is BOUNDED — the caller's limit is validated, not defaulted.
//
// Kysely parameterized queries only. The table name is never interpolated into SQL text: it is a key from the
// closed set handed to Kysely's builder, which quotes identifiers itself.
import type { Kysely } from 'kysely';
import { isExportCollectionTable, exportOrderBy } from '@acbp/contracts';
import type { DatabaseSchema } from './schema.js';

export type ExportExecutor = Kysely<DatabaseSchema>;

/** One exported row, as read. Deliberately untyped per table — the reader's whole point is that it is total. */
export type ExportRow = Record<string, unknown>;

export class ExportRepository {
  readonly #db: ExportExecutor;
  constructor(db: ExportExecutor) {
    this.#db = db;
  }

  /**
   * Read one exported collection under the caller's company scope, in its declared order, up to `limit` rows.
   *
   * THROWS on an unexported table or an invalid limit, rather than returning `[]`. An empty array is how "this
   * collection has no rows" is reported, and a refusal that looked identical to it would put "nothing here" in an
   * archive where a programming error belongs. ENFORCED BY: "REFUSES a table outside the export allowlist" and
   * "REFUSES a limit that is not a positive whole number".
   *
   * The caller passes `cap + 1` and treats the extra row as truncation (CDR-078 §6-G7) — this method neither
   * knows nor decides the cap.
   *
   * DELIBERATELY NOT `async`: the validation throws SYNCHRONOUSLY. An async method turns every refusal into a
   * rejected promise, and a caller assembling reads before awaiting them would convert a programming error into
   * an unhandled rejection — a refusal nobody sees, in the one code path whose job is to be complete.
   */
  readCollection(table: string, limit: number): Promise<readonly ExportRow[]> {
    // ONE allowlist gate, not two. An earlier version also tested `exportOrderBy(table) === undefined` here, and
    // mutation testing showed the two conditions are EQUIVALENT — both derive from `EXPORT_COLLECTIONS` — so
    // deleting either left every test green. A second condition that no test can distinguish reads as a control
    // and is not one.
    if (!isExportCollectionTable(table)) {
      throw new Error(`Refusing to read '${String(table)}': not an exported collection.`);
    }
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      throw new Error('Refusing to read an export collection: limit must be a positive whole number.');
    }
    // ONE cast, at the boundary, and only to a SHAPE — an open row-per-table schema — so the builder accepts a
    // table and column named at runtime. Casting per call instead would put a `never` or an `any` on every line and
    // make it much harder to see that the only values reaching here came from the closed set checked above.
    // Deliberately after the refusals, never before.
    const db = this.#db as unknown as Kysely<Record<string, Record<string, unknown>>>;
    let query = db.selectFrom(table).selectAll();
    // Non-empty for every table the gate above accepts. ENFORCED BY the contracts suite's "declares a NON-EMPTY
    // sort key on every collection" — the `?? []` narrows the type and is unreachable while that holds.
    for (const column of exportOrderBy(table) ?? []) query = query.orderBy(column);
    return query.limit(limit).execute();
  }
}
