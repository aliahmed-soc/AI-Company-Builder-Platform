// @acbp/database — strategy repository (ACBP-P3-001; CDR-034 §3/§4).
//
// Operates on the immutable `strategy_generations` + `strategy_options` rows. Takes a plain executor and relies on the
// caller to run it under the correct COMPANY scope (the dual-keyed policies deny anything else); the use case writes the
// generation + its options + the `strategy.generated` audit event in ONE transaction. Kysely parameterized queries
// only; no raw SQL interpolation. Both tables are append-only (SELECT + INSERT) — there is no update/delete path.
import type { Kysely } from 'kysely';
import type { DatabaseSchema, StrategyGenerationRow, StrategyOptionRow, StrategyRecommendationRow, StrategySelectionRow, DecisionRow } from './schema.js';

export type StrategyExecutor = Kysely<DatabaseSchema>;

/** The fields a caller supplies to record a strategy generation (identity/created_at are server-set). */
export interface NewStrategyGenerationInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly understandingDocumentId: string;
  readonly understandingVersion: number;
  readonly status: string;
  readonly optionCount: number;
  readonly fewerReason: string | null;
  readonly similarityCheckResult: string;
  readonly modelFlaggedPartial: boolean;
  readonly createdByUserId: string;
}

export interface NewStrategyOptionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  readonly ordinal: number;
  readonly fields: Record<string, string>;
}

export interface ListStrategyGenerationsOptions {
  readonly limit: number;
}

/** The fields a caller supplies to record an advisory recommendation (identity/created_at are server-set). */
export interface NewStrategyRecommendationInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  readonly recommendedOptionId: string;
  readonly rationale: string;
  readonly sensitivities: string;
  readonly createdByUserId: string;
}

/**
 * The fields a caller supplies to record an owner decision (identity/created_at are server-set). Per-mode shape is
 * validated in the contract (`validateStrategyDecision`) and enforced again by the table CHECKs; the caller passes the
 * already-shaped nullable columns.
 */
export interface NewStrategySelectionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  readonly mode: string;
  readonly selectedOptionId: string | null;
  readonly chosenFields: Record<string, string> | null;
  readonly phaseScope: string | null;
  readonly reasons: string | null;
  readonly createdByUserId: string;
}

/**
 * The fields a caller supplies to record an immutable decision (identity/created_at are server-set). `rationale` is
 * OPTIONAL (CDR-038 §6-G2) — a missing rationale must never make a decision silently unrecorded.
 */
export interface NewDecisionInput {
  readonly accountId: string;
  readonly companyId: string;
  readonly generationId: string;
  readonly selectionId: string;
  /** Immutable snapshot of the hardened selection's mode (the P4-001 gate keys off a NON-reject decision). */
  readonly mode: string;
  readonly understandingVersion: number;
  readonly rationale: string | null;
  readonly createdByUserId: string;
}

export class StrategyRepository {
  readonly #db: StrategyExecutor;
  constructor(db: StrategyExecutor) {
    this.#db = db;
  }

  /** Insert one immutable strategy generation. RLS confines the write to the caller's company scope. */
  insertGeneration(input: NewStrategyGenerationInput): Promise<StrategyGenerationRow> {
    return this.#db
      .insertInto('strategy_generations')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        understanding_document_id: input.understandingDocumentId,
        understanding_version: input.understandingVersion,
        status: input.status,
        option_count: input.optionCount,
        fewer_reason: input.fewerReason,
        similarity_check_result: input.similarityCheckResult,
        model_flagged_partial: input.modelFlaggedPartial,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** Insert one immutable option row (the validated 16-field object). */
  insertOption(input: NewStrategyOptionInput): Promise<StrategyOptionRow> {
    return this.#db
      .insertInto('strategy_options')
      .values({ account_id: input.accountId, company_id: input.companyId, generation_id: input.generationId, ordinal: input.ordinal, fields: input.fields })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** A single generation by id (RLS-confined; undefined when absent/invisible). */
  findGeneration(id: string): Promise<StrategyGenerationRow | undefined> {
    return this.#db.selectFrom('strategy_generations').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The company's most recent generation (RLS-confined), or undefined when none exists yet. */
  latestGeneration(companyId: string): Promise<StrategyGenerationRow | undefined> {
    return this.#db.selectFrom('strategy_generations').selectAll().where('company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  }

  /** The company's generations (RLS-confined), newest first, bounded. */
  listGenerations(companyId: string, options: ListStrategyGenerationsOptions): Promise<StrategyGenerationRow[]> {
    return this.#db.selectFrom('strategy_generations').selectAll().where('company_id', '=', companyId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(options.limit).execute();
  }

  /** The options of a generation (RLS-confined), in ordinal order. */
  listOptions(generationId: string): Promise<StrategyOptionRow[]> {
    return this.#db.selectFrom('strategy_options').selectAll().where('generation_id', '=', generationId).orderBy('ordinal', 'asc').execute();
  }

  /** A single option by id (RLS-confined; undefined when absent/invisible). */
  findOption(id: string): Promise<StrategyOptionRow | undefined> {
    return this.#db.selectFrom('strategy_options').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Insert one immutable advisory recommendation row (append-only). */
  insertRecommendation(input: NewStrategyRecommendationInput): Promise<StrategyRecommendationRow> {
    return this.#db
      .insertInto('strategy_recommendations')
      .values({ account_id: input.accountId, company_id: input.companyId, generation_id: input.generationId, recommended_option_id: input.recommendedOptionId, rationale: input.rationale, sensitivities: input.sensitivities, created_by_user_id: input.createdByUserId })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The LATEST advisory recommendation for a generation (RLS-confined), or undefined when none exists. */
  latestRecommendation(generationId: string): Promise<StrategyRecommendationRow | undefined> {
    return this.#db.selectFrom('strategy_recommendations').selectAll().where('generation_id', '=', generationId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  }

  /** Insert one immutable owner selection row (append-only). The table CHECKs enforce the per-mode shape. */
  insertSelection(input: NewStrategySelectionInput): Promise<StrategySelectionRow> {
    return this.#db
      .insertInto('strategy_selections')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        generation_id: input.generationId,
        mode: input.mode,
        selected_option_id: input.selectedOptionId,
        chosen_fields: input.chosenFields,
        phase_scope: input.phaseScope,
        reasons: input.reasons,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The LATEST owner selection for a generation (RLS-confined), or undefined when none exists. */
  latestSelection(generationId: string): Promise<StrategySelectionRow | undefined> {
    return this.#db.selectFrom('strategy_selections').selectAll().where('generation_id', '=', generationId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  }

  /** A single selection by id (RLS-confined; undefined when absent/invisible). */
  findSelection(id: string): Promise<StrategySelectionRow | undefined> {
    return this.#db.selectFrom('strategy_selections').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Insert one immutable, audit-grade decision record (append-only). */
  insertDecision(input: NewDecisionInput): Promise<DecisionRow> {
    return this.#db
      .insertInto('decisions')
      .values({
        account_id: input.accountId,
        company_id: input.companyId,
        generation_id: input.generationId,
        selection_id: input.selectionId,
        mode: input.mode,
        understanding_version: input.understandingVersion,
        rationale: input.rationale,
        created_by_user_id: input.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /** The LATEST decision record for a generation (RLS-confined), or undefined when none exists. */
  latestDecision(generationId: string): Promise<DecisionRow | undefined> {
    return this.#db.selectFrom('decisions').selectAll().where('generation_id', '=', generationId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  }
}
