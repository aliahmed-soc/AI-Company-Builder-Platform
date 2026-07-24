// @acbp/database — typed memory item repository (ACBP-P2-006; CDR-024).
//
// Operates on the append-only `memory_items` rows. Takes a plain executor and relies on the caller to run it
// under the correct RLS scope — every method requires a validated COMPANY scope (the dual-keyed policies deny
// anything else). Kysely parameterized queries only; no raw SQL interpolation. There is deliberately NO
// update/delete method: P2-006 creates + lists only (supersede/confirm/delete are P2-010/M3).
import type { Kysely } from 'kysely';
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

/** Bounded list options. `limit` is clamped by the caller/use case; `type` filters to a single memory type. */
export interface ListMemoryItemsOptions {
  readonly type?: string;
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
    let q = this.#db.selectFrom('memory_items').selectAll();
    if (options.type !== undefined) q = q.where('type', '=', options.type);
    return q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  }

  /** A single memory item by id (RLS-confined; undefined when absent/invisible). */
  findById(id: string): Promise<MemoryItemRow | undefined> {
    return this.#db.selectFrom('memory_items').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
