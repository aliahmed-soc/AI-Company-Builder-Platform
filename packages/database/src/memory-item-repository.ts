// @acbp/database — typed memory item repository (ACBP-P2-006; CDR-024).
//
// Operates on the append-only `memory_items` rows. Takes a plain executor and relies on the caller to run it
// under the correct RLS scope — every method requires a validated COMPANY scope (the dual-keyed policies deny
// anything else). Kysely parameterized queries only; no raw SQL interpolation. There is deliberately NO
// update/delete method: P2-006 creates + lists only (supersede/confirm/delete are P2-010/M3).
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, MemoryItemRow } from './schema.js';

export type MemoryItemExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to create a memory item. Identity (account/company) + defaults are server-set. */
export interface NewMemoryItemInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly type: string;
  readonly content: string;
  readonly sourceType: string;
  readonly sourceRef: string;
  readonly confidence: number | null;
  readonly createdByUserId: string | null;
}

/** Bounded list options. `limit` is clamped by the caller/use case; `type` filters to a single memory type;
 *  `currentOnly` restricts to live (not-yet-superseded) items. */
export interface ListMemoryItemsOptions {
  readonly type?: string;
  readonly currentOnly?: boolean;
  readonly limit: number;
}

export class MemoryItemRepository {
  readonly #db: MemoryItemExecutor;
  constructor(db: MemoryItemExecutor) {
    this.#db = db;
  }

  /**
   * Insert a memory item (created `proposed`, `superseded_by = null`). The type/source CHECKs and the
   * type-by-source-path CHECK are enforced by the table; the use case validates first for a bounded error.
   * Returns the server-generated row.
   */
  insert(input: NewMemoryItemInput): Promise<MemoryItemRow> {
    return this.#db
      .insertInto('memory_items')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        type: input.type,
        content: input.content,
        source_type: input.sourceType,
        source_ref: input.sourceRef,
        confidence: input.confidence,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * The company's memory items (RLS-confined), newest first with a deterministic total order
   * `(created_at desc, id desc)`, optionally filtered to a single `type`, bounded by `limit`.
   */
  list(options: ListMemoryItemsOptions): Promise<MemoryItemRow[]> {
    // Deleted items are ALWAYS omitted from the browser (CDR-025 §6; no includeDeleted toggle). The row stays in
    // storage for history/audit, but never surfaces through list/get.
    let q = this.#db.selectFrom('memory_items').selectAll().where('deleted_at', 'is', null);
    if (options.type !== undefined) q = q.where('type', '=', options.type);
    // `currentOnly` further restricts to live items (not yet superseded) — the browser's default view.
    if (options.currentOnly === true) q = q.where('superseded_by', 'is', null);
    return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  }

  /** A single memory item by id (RLS-confined; undefined when absent/invisible). */
  findById(id: string): Promise<MemoryItemRow | undefined> {
    return this.#db.selectFrom('memory_items').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /**
   * Point a still-CURRENT item's `superseded_by` at its correcting new version (ACBP-P2-010 edit). Version-guarded:
   * the UPDATE only fires while the row is still current (`superseded_by IS NULL`), so a concurrent edit that
   * already superseded it matches 0 rows — the caller maps that to a bounded conflict. Only `superseded_by` is
   * touched (the narrow column-level UPDATE grant, migration 0015); content/type/source stay immutable. Returns
   * the number of rows updated (1 on success, 0 on a lost race).
   */
  async supersede(oldId: string, newId: string): Promise<number> {
    const r = await this.#db.updateTable('memory_items').set({ superseded_by: newId }).where('id', '=', oldId).where('superseded_by', 'is', null).executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  /**
   * Soft-delete an item: set `deleted_at = now()` (SERVER clock) + `deleted_by_user_id`, guarded so ONLY a
   * current active item transitions (`superseded_by IS NULL AND deleted_at IS NULL`). A concurrent delete or a
   * supersede that already moved the row matches 0 rows → the caller maps that to a bounded conflict, so at most
   * one transaction performs the transition (and thus writes one audit event). Only the two delete columns are
   * touched (0016 grant); content/type/source stay immutable. Returns the number of rows updated.
   */
  async softDelete(id: string, deletedByUserId: string): Promise<number> {
    const r = await this.#db
      .updateTable('memory_items')
      .set({ deleted_at: sql<Date>`now()`, deleted_by_user_id: deletedByUserId })
      .where('id', '=', id)
      .where('superseded_by', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}
