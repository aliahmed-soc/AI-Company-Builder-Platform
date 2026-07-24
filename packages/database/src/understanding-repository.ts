// @acbp/database — understanding-generation repository (ACBP-P2-008; CDR-029 §5/§6).
//
// Operates on the versioned, append-only `understanding_documents` + `understanding_items` rows. Takes a plain
// executor and relies on the caller to run it under the correct COMPANY scope (the dual-keyed policies deny
// anything else); the use case writes the document + its items + the audit event in ONE transaction. Kysely
// parameterized queries only; no raw SQL interpolation. There is deliberately NO update/delete method — a version
// is immutable; a re-generation is a new version (review/correct is P2-009).
import type { Kysely } from 'kysely';
import type { DatabaseSchema, UnderstandingDocumentRow, UnderstandingItemRow } from './schema.js';

export type UnderstandingExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to create an understanding document version (identity is server-set upstream). */
export interface NewUnderstandingDocumentInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly version: number;
  readonly status: string;
  readonly overallConfidence: number;
  readonly createdByUserId: string | null;
}

/** The fields a caller supplies to create one classified understanding item. */
export interface NewUnderstandingItemInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly documentId: string;
  readonly itemClass: string;
  readonly content: string;
  readonly confidence: number;
  readonly sourceRef: string | null;
}

export interface ListUnderstandingOptions {
  readonly limit: number;
}

export class UnderstandingRepository {
  readonly #db: UnderstandingExecutor;
  constructor(db: UnderstandingExecutor) {
    this.#db = db;
  }

  /** The next document version for a company (max + 1, or 1 for the first). RLS confines to the scope. */
  async nextVersion(companyId: string): Promise<number> {
    const r = await this.#db.selectFrom('understanding_documents').select((eb) => eb.fn.max('version').as('maxv')).where('company_id', '=', companyId).executeTakeFirst();
    const max = r?.maxv;
    return (typeof max === 'number' ? max : 0) + 1;
  }

  /**
   * Insert an understanding document version. `ON CONFLICT (company_id, version) DO NOTHING` makes a CONCURRENT
   * generation at the same computed version GRACEFUL — the loser inserts nothing and returns `undefined`, and the
   * caller recomputes the next version and retries (a valid, gap-free chain; never an uncaught duplicate-key throw).
   * Returns the inserted row, or `undefined` on a version race.
   */
  insertDocument(input: NewUnderstandingDocumentInput): Promise<UnderstandingDocumentRow | undefined> {
    return this.#db
      .insertInto('understanding_documents')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        version: input.version,
        status: input.status,
        overall_confidence: input.overallConfidence,
        created_by_user_id: input.createdByUserId,
      })
      .onConflict((oc) => oc.columns(['company_id', 'version']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** Insert one classified item of a document version. */
  insertItem(input: NewUnderstandingItemInput): Promise<UnderstandingItemRow> {
    return this.#db
      .insertInto('understanding_items')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        document_id: input.documentId,
        item_class: input.itemClass,
        content: input.content,
        confidence: input.confidence,
        source_ref: input.sourceRef,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The company's understanding document versions (RLS-confined), newest version first, bounded. */
  listDocuments(options: ListUnderstandingOptions): Promise<UnderstandingDocumentRow[]> {
    return this.#db.selectFrom('understanding_documents').selectAll().orderBy('version', 'desc').limit(options.limit).execute();
  }

  /** A single document by id (RLS-confined; undefined when absent/invisible). */
  findDocument(id: string): Promise<UnderstandingDocumentRow | undefined> {
    return this.#db.selectFrom('understanding_documents').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The items of a document version (RLS-confined), in insertion order. */
  listItems(documentId: string): Promise<UnderstandingItemRow[]> {
    return this.#db.selectFrom('understanding_items').selectAll().where('document_id', '=', documentId).orderBy('id', 'asc').execute();
  }
}
