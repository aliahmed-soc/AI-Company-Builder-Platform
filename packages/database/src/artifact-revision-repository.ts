// @acbp/database — artifact revision requests (ACBP-P5-012; CDR-064; TASK-005 lineage; J-13).
//
// APPEND-ONLY: there is no update and no delete here, because the table grants neither. A revision request is a
// record that the owner asked for something at a moment in time; the TASK it created is the lineage (J-13).
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, ArtifactRevisionRow } from './schema.js';

export type ArtifactRevisionExecutor = Kysely<DatabaseSchema>;

export interface NewArtifactRevisionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly originalArtifactId: string;
  /** The NEW LINKED TASK created for the revision (J-13) - not a run on the finished original. */
  readonly newTaskId: string;
  /** Already trimmed and bounded by `validateRevisionGuidance` — this layer stores what it is given. */
  readonly guidance: string;
  readonly idempotencyKey: string;
  readonly requestedByUserId: string;
}

export class ArtifactRevisionRepository {
  readonly #db: ArtifactRevisionExecutor;
  constructor(db: ArtifactRevisionExecutor) {
    this.#db = db;
  }

  /**
   * Record one revision request.
   *
   * `undefined` means the idempotency constraint refused it — this key already requested a revision in this company.
   * That is an ordinary retry, not a fault, and the caller returns the FIRST request rather than an error.
   *
   * TARGETED AT THE ONE CONSTRAINT that can legitimately refuse a well-formed row, never a blanket 23505. A conflict
   * this method did not anticipate would otherwise be reported to the caller as "already requested", which for an
   * operation that spends a credit is the worst available lie.
   *
   * BY NAME here, and that is correct precisely because it is a REAL named CONSTRAINT: `idempotency_key` is NOT NULL
   * on this table, so the uniqueness needs no predicate and `addUniqueConstraint` was available. P5-014's reservation
   * key had to be a PARTIAL index — only reservations carry a key — and naming a partial index as a constraint is
   * what raised 42704 on every reservation (D1). `tools/check-conflict-targets.mjs` knows the difference and fails
   * the build if this ever becomes an index.
   */
  insert(input: NewArtifactRevisionInput): Promise<ArtifactRevisionRow | undefined> {
    return this.#db
      .insertInto('artifact_revisions')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        original_artifact_id: input.originalArtifactId,
        new_task_id: input.newTaskId,
        guidance: input.guidance,
        idempotency_key: input.idempotencyKey,
        requested_by_user_id: input.requestedByUserId,
      })
      .onConflict((oc) => oc.constraint('artifact_revisions_company_key_uq').doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The request a key already made. RLS confines this to the caller's company. */
  findByKey(companyId: string, idempotencyKey: string): Promise<ArtifactRevisionRow | undefined> {
    return this.#db
      .selectFrom('artifact_revisions')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
  }

  /**
   * The revision request that created a task, if any.
   *
   * THIS IS THE LINEAGE LOOKUP (CDR-064 G1). Given an artifact, the TASK its run belongs to answers "what was this a
   * revision of" — derived rather than duplicated onto `artifacts`, so it cannot drift.
   */
  findByTask(newTaskId: string): Promise<ArtifactRevisionRow | undefined> {
    return this.#db.selectFrom('artifact_revisions').selectAll().where('new_task_id', '=', newTaskId).executeTakeFirst();
  }

  /** Every revision asked of one artifact, newest first — the founder-facing "versions" list. */
  listForArtifact(originalArtifactId: string, limit: number): Promise<ArtifactRevisionRow[]> {
    return this.#db
      .selectFrom('artifact_revisions')
      .selectAll()
      .where('original_artifact_id', '=', originalArtifactId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  /** Whether an artifact has any revision at all — used by the read to mark a document as superseded. */
  async countForArtifact(originalArtifactId: string): Promise<number> {
    const row = await this.#db
      .selectFrom('artifact_revisions')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('original_artifact_id', '=', originalArtifactId)
      .executeTakeFirst();
    return row?.n ?? 0;
  }
}
