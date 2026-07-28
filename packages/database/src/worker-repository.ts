// @acbp/database — worker definitions and per-company state (ACBP-P5-004; CDR-056; WORK-001/006).
//
// Two stores with two different owners: the platform says what a worker IS (`worker_definitions`, SELECT-only), and
// the company owner says whether it may run HERE (`company_worker_states`, dual-keyed FORCE RLS).
//
// Kysely parameterized queries only.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseSchema, WorkerDefinitionRow, CompanyWorkerStateRow } from './schema.js';

export type WorkerExecutor = Kysely<DatabaseSchema>;

export interface SetCompanyWorkerStateInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly workerId: string;
  readonly state: string;
  readonly reason?: string | null;
  readonly changedByUserId: string;
}

export class WorkerRepository {
  readonly #db: WorkerExecutor;
  constructor(db: WorkerExecutor) {
    this.#db = db;
  }

  /** The ACTIVE definition at its highest version. `undefined` means unregistered — WORK-001's failure clause. */
  findActiveDefinition(workerId: string): Promise<WorkerDefinitionRow | undefined> {
    return this.#db
      .selectFrom('worker_definitions')
      .selectAll()
      .where('worker_id', '=', workerId)
      .where('status', '=', 'active')
      .orderBy('version', 'desc')
      .executeTakeFirst();
  }

  /** Every active definition, newest version per worker first. The registry listing (WORK-001). */
  listActiveDefinitions(): Promise<WorkerDefinitionRow[]> {
    return this.#db.selectFrom('worker_definitions').selectAll().where('status', '=', 'active').orderBy('worker_id').orderBy('version', 'desc').execute();
  }

  /** This company's state for a worker. `undefined` means no state was ever set, which reads as `enabled`. */
  findCompanyState(workerId: string): Promise<CompanyWorkerStateRow | undefined> {
    return this.#db.selectFrom('company_worker_states').selectAll().where('worker_id', '=', workerId).executeTakeFirst();
  }

  listCompanyStates(): Promise<CompanyWorkerStateRow[]> {
    return this.#db.selectFrom('company_worker_states').selectAll().orderBy('worker_id').execute();
  }

  /**
   * Set the state, creating the row if the owner has never touched this worker before.
   *
   * UPSERT rather than read-then-write: two owners toggling the same worker at once would otherwise race, and the
   * loser's insert would fail on the unique constraint rather than simply applying second. `updated_at` moves so the
   * read path can show WHEN, and `changed_by_user_id` moves so it can show WHO.
   */
  setCompanyState(input: SetCompanyWorkerStateInput): Promise<CompanyWorkerStateRow | undefined> {
    return this.#db
      .insertInto('company_worker_states')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        worker_id: input.workerId,
        state: input.state,
        reason: input.reason ?? null,
        changed_by_user_id: input.changedByUserId,
      })
      .onConflict((oc) =>
        oc.columns(['company_id', 'worker_id']).doUpdateSet({
          state: input.state,
          reason: input.reason ?? null,
          changed_by_user_id: input.changedByUserId,
          updated_at: sql<Date>`now()`,
        }),
      )
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * The ACTIVE class of each named tool, for the MVP-boundary check. Global registry, so no tenancy applies.
   *
   * ONE ROW PER TOOL, at its highest active version (review pass 1). Without `distinct on`, a tool with a v1 and a
   * v2 returns both — and since the boundary check refuses if ANY row is external-effect, a tool RE-classified down
   * from external to informational would still be refused by its own history. A tool absent from the result is a tool
   * the registry does not have, which the caller must treat as unclassified rather than as absent from the check.
   */
  async toolRiskClasses(toolIds: readonly string[]): Promise<Array<{ tool_id: string; risk_class: string | null }>> {
    if (toolIds.length === 0) return [];
    const rows = await sql<{ tool_id: string; risk_class: string | null }>`
      select distinct on (tool_id) tool_id, risk_class from public.tool_definitions
      where status = 'active' and tool_id = any(${sql.val([...toolIds])}::text[])
      order by tool_id, version desc
    `.execute(this.#db);
    return rows.rows;
  }
}
