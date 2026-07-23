// @acbp/database — workspace-provisioning repositories (ACBP-P1-012; CDR-018).
//
// Operate on the provisioning checkpoint rows (`provisioning_steps`) and the append-only workspace-area
// registry (`company_workspace_areas`). Like the other repositories they take a plain executor and rely on the
// caller to run them under the correct RLS scope — every method here requires a validated COMPANY scope (the
// dual-keyed policies deny anything else). Kysely parameterized queries only; no raw SQL interpolation.
//
// Durable statuses are pending | completed | failed ONLY (CDR-018 §4): there is deliberately NO method that
// could commit a `running` state, and outcome mutations go through the two typed transition methods below,
// which write the step's committed outcome (attempt increment + timestamps + optional failure code) in ONE
// UPDATE — the caller wraps effect + outcome + audit in a single transaction.
import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema, ProvisioningStepRow } from './schema.js';

export type ProvisioningExecutor = Kysely<DatabaseSchema>;

/** The canonical (step, order) seed rows — mirrors @acbp/contracts PROVISIONING_STEPS (CHECK-pinned in 0010). */
const SEED_ROWS: ReadonlyArray<{ step: string; step_order: number }> = [
  { step: 'profile', step_order: 1 },
  { step: 'mission_draft', step_order: 2 },
  { step: 'research', step_order: 3 },
  { step: 'roadmap', step_order: 4 },
  { step: 'documents', step_order: 5 },
  { step: 'activity', step_order: 6 },
];

export class ProvisioningRepository {
  readonly #db: ProvisioningExecutor;
  constructor(db: ProvisioningExecutor) {
    this.#db = db;
  }

  /** Seed the six PENDING checkpoints for a company (creation bootstrap — same transaction as the company
   *  insert; run under the CompanyScope minted from the authoritative row). Plain INSERT: in the bootstrap the
   *  rows cannot exist yet, and a conflict is an internal bug that must fail the whole creation loudly. */
  async seedCheckpoints(accountId: string, companyId: string): Promise<void> {
    await this.#db
      .insertInto('provisioning_steps')
      .values(SEED_ROWS.map((r) => ({ account_id: accountId, company_id: companyId, step: r.step, step_order: r.step_order })))
      .execute();
  }

  /** All six checkpoint rows for a company in canonical order (RLS confines to the current company scope). */
  listSteps(companyId: string): Promise<ProvisioningStepRow[]> {
    return this.#db.selectFrom('provisioning_steps').selectAll().where('company_id', '=', companyId).orderBy('step_order', 'asc').execute();
  }

  /** Lock ONE checkpoint row `FOR UPDATE` and return it (or undefined when invisible/absent). The executor uses
   *  this at the top of each step transaction so concurrent resumes serialize on the row and re-check
   *  status/attempt AFTER acquiring the lock (no duplicate effects, no double attempt increment). */
  lockStep(companyId: string, step: string): Promise<ProvisioningStepRow | undefined> {
    return this.#db.selectFrom('provisioning_steps').selectAll().where('company_id', '=', companyId).where('step', '=', step).forUpdate().executeTakeFirst();
  }

  /** Commit a step attempt's SUCCESS outcome: attempt increment + started/completed timestamps, atomically with
   *  the step's material effect in the caller's transaction. Guarded on the CURRENT status/attempt (optimistic
   *  re-check under the row lock); returns the number of rows updated (0 = the guard failed — caller aborts). */
  async completeStep(companyId: string, step: string, fromAttempt: number): Promise<number> {
    const r = await this.#db
      .updateTable('provisioning_steps')
      .set({ status: 'completed', attempt: fromAttempt + 1, started_at: sql<Date>`now()`, completed_at: sql<Date>`now()`, failed_at: null, failure_code: null, updated_at: sql<Date>`now()` })
      .where('company_id', '=', companyId)
      .where('step', '=', step)
      .where('status', '!=', 'completed')
      .where('attempt', '=', fromAttempt)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }

  /** Commit a step attempt's controlled FAILURE outcome (closed failure code; bounded attempts enforced by the
   *  CHECK + the caller's cap logic). Same guard semantics as {@link completeStep}. */
  async failStep(companyId: string, step: string, fromAttempt: number, failureCode: string): Promise<number> {
    const r = await this.#db
      .updateTable('provisioning_steps')
      .set({ status: 'failed', attempt: fromAttempt + 1, started_at: sql<Date>`now()`, failed_at: sql<Date>`now()`, completed_at: null, failure_code: failureCode, updated_at: sql<Date>`now()` })
      .where('company_id', '=', companyId)
      .where('step', '=', step)
      .where('status', '!=', 'completed')
      .where('attempt', '=', fromAttempt)
      .executeTakeFirst();
    return Number(r.numUpdatedRows);
  }
}

export class WorkspaceAreaRepository {
  readonly #db: ProvisioningExecutor;
  constructor(db: ProvisioningExecutor) {
    this.#db = db;
  }

  /** Idempotently register a workspace area (the material effect of the four creating steps). ON CONFLICT
   *  DO NOTHING keyed to the exact (company_id, area) PK — a re-run of a step never duplicates or errors. */
  async insertArea(accountId: string, companyId: string, area: string): Promise<void> {
    await this.#db
      .insertInto('company_workspace_areas')
      .values({ account_id: accountId, company_id: companyId, area })
      .onConflict((oc) => oc.columns(['company_id', 'area']).doNothing())
      .execute();
  }

  /** The registered areas for a company (RLS-confined). */
  listAreas(companyId: string): Promise<Array<{ area: string }>> {
    return this.#db.selectFrom('company_workspace_areas').select('area').where('company_id', '=', companyId).orderBy('area', 'asc').execute();
  }
}
