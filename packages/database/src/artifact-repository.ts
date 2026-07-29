// @acbp/database — artifacts (ACBP-P5-011; CDR-060; TASK-005; NFR-014).
//
// SELECT and INSERT only, because the table grants nothing else. There is deliberately no `update` and no `delete`
// method here: a superseded artifact is a NEW row (P5-012's revision lineage), and the provenance a row carries has
// to stay the provenance it was written with.
import type { Kysely } from 'kysely';
import type { ArtifactRow, DatabaseSchema } from './schema.js';

export type ArtifactExecutor = Kysely<DatabaseSchema>;

export interface NewArtifactInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly objectKey: string;
  readonly contentHash: string;
  readonly format: string;
  readonly sizeBytes: number;
  readonly runId: string;
  readonly workerId: string;
  readonly workerVersion: number;
  readonly modelVersion: string;
  readonly title: string;
}

export class ArtifactRepository {
  readonly #db: ArtifactExecutor;
  constructor(db: ArtifactExecutor) {
    this.#db = db;
  }

  /**
   * Record an artifact, idempotently.
   *
   * ALWAYS RETURNS A ROW. `ON CONFLICT DO NOTHING` returns nothing when the unique index fires, and a caller that
   * treated that as failure would fail a task whose artifact is safely stored — the hollow success inverted, and just
   * as wrong. So the conflict path re-reads the existing row and returns it: a retry of the same run writing the same
   * bytes gets back the artifact it already has.
   *
   * The conflict is scoped to the EXACT content-addressing index `(company_id, content_hash, run_id)` rather than to
   * a bare unique violation. A different constraint failing — the tenant-pinned run FK, a CHECK, the prefix guard —
   * is a real defect and must surface, not be swallowed as "already stored".
   */
  async insert(input: NewArtifactInput): Promise<ArtifactRow> {
    const inserted = await this.#db
      .insertInto('artifacts')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        object_key: input.objectKey,
        content_hash: input.contentHash,
        format: input.format,
        size_bytes: input.sizeBytes,
        run_id: input.runId,
        worker_id: input.workerId,
        worker_version: input.workerVersion,
        model_version: input.modelVersion,
        title: input.title,
      })
      .onConflict((oc) => oc.columns(['company_id', 'content_hash', 'run_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return inserted;

    const existing = await this.findByContentForRun(input.companyId, input.contentHash, input.runId);
    if (existing === undefined) {
      // Reachable only if the row vanished between the conflict and this read, which the table's lack of a DELETE
      // grant makes impossible for the app role. Throwing beats returning a fabricated row: TASK-005's rule is that a
      // persist we cannot confirm FAILS the task.
      throw new Error('artifact insert conflicted but no existing row was found');
    }
    return existing;
  }

  findById(artifactId: string): Promise<ArtifactRow | undefined> {
    return this.#db.selectFrom('artifacts').selectAll().where('id', '=', artifactId).executeTakeFirst();
  }

  /** The idempotence lookup, matching the unique index exactly. RLS confines it to the caller's company anyway. */
  findByContentForRun(companyId: string, contentHash: string, runId: string): Promise<ArtifactRow | undefined> {
    return this.#db
      .selectFrom('artifacts')
      .selectAll()
      .where('company_id', '=', companyId)
      .where('content_hash', '=', contentHash)
      .where('run_id', '=', runId)
      .executeTakeFirst();
  }

  /** Everything one run produced. A run may legitimately produce several artifacts — a plan and its summary. */
  listForRun(runId: string): Promise<ArtifactRow[]> {
    return this.#db.selectFrom('artifacts').selectAll().where('run_id', '=', runId).orderBy('created_at', 'asc').execute();
  }

  /** The company's artifacts, newest first. Bounded by an explicit limit — an unbounded list is a future outage. */
  listForCompany(companyId: string, limit: number): Promise<ArtifactRow[]> {
    return this.#db
      .selectFrom('artifacts')
      .selectAll()
      .where('company_id', '=', companyId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }
}
