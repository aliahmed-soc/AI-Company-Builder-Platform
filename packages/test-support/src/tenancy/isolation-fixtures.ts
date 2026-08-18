// ACBP-API-010 — MODEL-FREE fixture builders for tenant-data rows that sit behind a multi-table
// constraint chain. Test-only; never imported by production code.
//
// WHY THIS FILE EXISTS.
//
// Three adversarial matrices in `http-routes.adversarial.integration.test.ts` proved only that a route
// REFUSES AT COMPANY SCOPE, and each said so in its own comment: no roadmap, no artifact and no approval
// request was ever seeded, so none of them could prove the stronger and far more interesting property —
// that a foreign row which PROVABLY EXISTS still stays invisible. A negative that passes just as well
// against an empty table is not evidence of isolation; it is evidence of an empty table.
//
// The obvious way to seed these rows is through the core use cases, and `runMvpLoopJourney` does exactly
// that — but it reaches a roadmap and an artifact only by driving `generateRoadmap` / `runResearch` with a
// FAKE MODEL GATEWAY and an injected `ops` bundle. The adversarial HTTP suite has neither: it drives real
// Next route handlers and seeds through the owner connection. So these builders take the other road and
// INSERT DIRECTLY, which is the same thing the CDR-089 block in that file already does for `task_runs`.
//
// WHAT THAT MEANS FOR WHAT THESE FIXTURES PROVE, said plainly so nobody reads more into a green run:
//
//   • They are DATABASE-LEVEL fixtures. They satisfy the schema's constraints; they do NOT go through the
//     contract validation a use case would apply (the 16-field strategy-option standard is the clearest
//     example — `strategy_options.fields` only has to be a JSON object as far as PostgreSQL is concerned).
//   • They therefore prove NOTHING about whether the write paths are correct. That is the use-case suites'
//     job and they already do it.
//   • What they DO give the adversarial matrices is the one thing those matrices lacked: a real, existing,
//     foreign-tenant row to be invisible. Isolation is the only claim they support, and the only one made.
//
// EVERY BUILDER ENDS BY RE-READING ITS OWN ROW AND THROWING IF IT IS ABSENT. That is not defensive noise:
// a builder that quietly returned an id for a row that was rolled back, truncated, or never written would
// turn every downstream "the foreign row is invisible" assertion into a vacuous pass — the exact failure
// this whole file was written to close. A fixture that cannot produce the identity under test must fail
// loudly, at the fixture, not silently downstream.
import { createHash } from 'node:crypto';
import type { DatabaseClient } from '@acbp/database';

/** Identity of the tenant a fixture is planted in, plus the string that must never escape it. */
export interface ForeignFixtureParams {
  readonly accountId: string;
  readonly companyId: string;
  /** An existing internal user id — every chain here has at least one NOT NULL actor column. */
  readonly userId: string;
  /**
   * A distinctive string written into a field the corresponding READ actually returns, so a cross-tenant
   * assertion can search a response body for it. Pick something that cannot occur by chance.
   */
  readonly marker: string;
}

/**
 * The guard every builder ends with.
 *
 * Throws rather than returning a sentinel because the caller cannot act on a sentinel usefully: by the time
 * a test is asserting invisibility it has already committed to the row existing. `beforeEach` is the right
 * place for this to blow up.
 */
function mustExist<T>(found: T, what: string): asserts found is NonNullable<T> {
  if (found === undefined || found === null) {
    throw new Error(`isolation fixture: ${what} was not readable on the owner connection immediately after insert — every assertion that depends on it would pass vacuously, so this fails here instead.`);
  }
}

/** A seeded `task` + `task_runs` pair. Both artifact and approval chains hang off this. */
export interface SeededRun {
  readonly taskId: string;
  readonly runId: string;
}

/**
 * tasks → task_runs.
 *
 * THIS IS THE HOP TWO DISCLOSURES GOT WRONG. Both the artifact block and the approvals block said their
 * `run_id` carried "an FK to `runs`". There is no `runs` table in this schema — there never has been. The
 * real constraints are `artifacts_run_fk` and `approval_requests_run_fk`, both TENANT-PINNED composites
 * (`[run_id, company_id] → task_runs[id, company_id]`), and `task_runs` needs only four columns because
 * `state` defaults to 'queued'. Four literals, one table that the same test file was already seeding.
 */
export async function seedForeignRun(owner: DatabaseClient, params: ForeignFixtureParams): Promise<SeededRun> {
  const task = await owner.kysely
    .insertInto('tasks')
    .values({ account_id: params.accountId, company_id: params.companyId, title: `${params.marker} task`, created_by_user_id: params.userId })
    .returning('id')
    .executeTakeFirstOrThrow();
  const run = await owner.kysely
    .insertInto('task_runs')
    .values({ account_id: params.accountId, company_id: params.companyId, task_id: task.id, attempt: 1 })
    .returning('id')
    .executeTakeFirstOrThrow();

  const back = await owner.kysely.selectFrom('task_runs').select('id').where('id', '=', run.id).executeTakeFirst();
  mustExist(back, `task_run ${run.id} in company ${params.companyId}`);
  return { taskId: task.id, runId: run.id };
}

export interface SeededArtifact extends SeededRun {
  readonly artifactId: string;
  /** Carries the marker, and IS returned by the artifact read — so a leak is detectable in a response body. */
  readonly title: string;
}

/**
 * tasks → task_runs → artifacts.
 *
 * Every remaining NOT NULL on `artifacts` is literal-satisfiable, and the three interesting CHECKs are
 * honoured rather than worked around:
 *
 *   • `artifacts_key_is_company_prefixed` — the key is derived from this company's id, lowercased, and
 *     contains no '..', mirroring the production derivation (CDR-060 G2) so the stored row is internally
 *     consistent instead of merely constraint-passing.
 *
 *     WHAT THAT DERIVATION DOES NOT BUY, said plainly because an earlier version of this comment claimed it
 *     did: it does NOT make a fixture planted in the wrong company fail at the database. `object_key` and
 *     `company_id` are both derived from the SAME `params.companyId`, so the CHECK compares a value against
 *     itself and holds for every possible company — including a wrong one. The constraint is a real control
 *     over production writes, where the two values have independent origins; here it is satisfied by
 *     construction. What actually catches a misplanted fixture is the caller's existence assertion, which
 *     pins the returned id to the company the test expects.
 *   • `artifacts_content_hash_shape` — a REAL sha256 of the body text, not 64 hand-typed characters. It
 *     costs nothing and the row is then internally consistent.
 *   • `artifacts_size_bounded` / `artifacts_provenance_present` — actual byte length, non-blank provenance.
 */
export async function seedForeignArtifact(owner: DatabaseClient, params: ForeignFixtureParams): Promise<SeededArtifact> {
  const run = await seedForeignRun(owner, params);
  const body = `${params.marker} — artifact body planted in company ${params.companyId}`;
  const contentHash = createHash('sha256').update(body).digest('hex');
  const title = `${params.marker} artifact`;

  const artifact = await owner.kysely
    .insertInto('artifacts')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      // Derived, exactly as CDR-060 G2 requires of the production path.
      object_key: `company/${params.companyId.toLowerCase()}/${contentHash}.md`,
      content_hash: contentHash,
      format: 'markdown',
      size_bytes: Buffer.byteLength(body, 'utf8'),
      run_id: run.runId,
      worker_id: 'isolation-fixture',
      worker_version: 1,
      model_version: 'fixture-none',
      title,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const back = await owner.kysely.selectFrom('artifacts').select('id').where('id', '=', artifact.id).executeTakeFirst();
  mustExist(back, `artifact ${artifact.id} in company ${params.companyId}`);
  return { ...run, artifactId: artifact.id, title };
}

export interface SeededApprovalRequest extends SeededRun {
  readonly requestId: string;
  readonly policyId: string;
  /** Carries the marker, and IS one of the inbox's allowlisted fields. */
  readonly preview: string;
}

/**
 * tasks → task_runs → policies → approval_requests.
 *
 * The `policies` hop is the one the old disclosure omitted entirely: `approval_requests_policy_fk` is a
 * three-column composite (`policy_id, policy_version, company_id`) and both policy columns are NOT NULL,
 * so an approval request cannot exist without a policy in the SAME company. `policy_eval_id` IS nullable,
 * so no `policy_evaluations` row is needed — which is why this chain is four inserts and not five.
 *
 * Two constraints that reject the obvious lazy values, honoured deliberately:
 *   • `approval_requests_reversibility_matches_risk` — reversibility is DERIVED, not chosen. Only
 *     `sensitive_irreversible` may pair with 'irreversible'; everything else must say 'reversible'.
 *   • `policies_autonomy_level_range` (migration 0049, added by ALTER long after the table was created —
 *     reading only the CREATE TABLE would miss that this column exists and is NOT NULL).
 */
export async function seedForeignApprovalRequest(owner: DatabaseClient, params: ForeignFixtureParams): Promise<SeededApprovalRequest> {
  const run = await seedForeignRun(owner, params);
  const policy = await owner.kysely
    .insertInto('policies')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      version: 1,
      baseline: 'require_approval',
      rules: JSON.stringify([]),
      autonomy_level: 2,
      created_by_user_id: params.userId,
    })
    .returning(['id', 'version'])
    .executeTakeFirstOrThrow();

  const preview = `${params.marker} — approval preview`;
  const request = await owner.kysely
    .insertInto('approval_requests')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      run_id: run.runId,
      tool_id: 'isolation_fixture_tool',
      tool_version: 1,
      action: `${params.marker} action`,
      reason: `${params.marker} reason`,
      expected_result: `${params.marker} expected result`,
      data: JSON.stringify({ marker: params.marker }),
      estimated_cost_credits: 0,
      risk_class: 'internal_reversible',
      // NOT a free choice — see the constraint named above.
      reversibility: 'reversible',
      preview,
      scope: 'one_action',
      policy_id: policy.id,
      policy_version: policy.version,
      payload_hash: createHash('sha256').update(preview).digest('hex'),
      binding_version: 1,
      expires_at: new Date(Date.now() + 3_600_000),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const back = await owner.kysely.selectFrom('approval_requests').select('id').where('id', '=', request.id).executeTakeFirst();
  mustExist(back, `approval_request ${request.id} in company ${params.companyId}`);
  return { ...run, requestId: request.id, policyId: policy.id, preview };
}

export interface SeededRoadmap {
  readonly roadmapId: string;
  readonly decisionId: string;
  readonly selectionId: string;
  readonly generationId: string;
  readonly documentId: string;
  /** Carries the marker. `RoadmapDTO.goals` is part of the read, so a leak shows up in the body. */
  readonly goalTitle: string;
}

/**
 * understanding_documents → strategy_generations → strategy_options → strategy_selections → decisions →
 * roadmaps → goals.
 *
 * THE CHAIN THE ROADMAP DISCLOSURE DESCRIBED ACCURATELY — it was the one block of the three whose stated
 * blocker was real. `roadmaps.decision_id` is NOT NULL; `decisions` needs BOTH a generation and a selection
 * (and pins them together with a composite FK); `strategy_selections` needs a generation; a generation needs
 * an understanding document.
 *
 * The fixture is built to be INTERNALLY COHERENT rather than merely constraint-passing, because a fixture
 * that contradicts itself is a bad witness even when PostgreSQL accepts it:
 *
 *   • `strategy_generations_status_count_consistent` lets 'complete' through only with `option_count >= 3`.
 *     Rather than declare three options and seed none, three real `strategy_options` rows are inserted, so
 *     the count column matches reality.
 *   • `strategy_selections_mode_shape` for mode 'select' demands a non-null `selected_option_id` with
 *     `chosen_fields` and `reasons` both null. The selection therefore points at option 0, and the composite
 *     `strategy_selections_option_fk` guarantees that option belongs to the SAME generation.
 *   • `roadmaps_supersedes_shape` ties version 1 to a null `supersedes_roadmap_id`, and
 *     `roadmaps_edit_reason_shape` ties origin 'generated' to a null `edit_reason`. Both are respected.
 */
export async function seedForeignRoadmap(owner: DatabaseClient, params: ForeignFixtureParams): Promise<SeededRoadmap> {
  const doc = await owner.kysely
    .insertInto('understanding_documents')
    .values({ account_id: params.accountId, company_id: params.companyId, version: 1, status: 'complete', overall_confidence: 0.9, created_by_user_id: params.userId })
    .returning('id')
    .executeTakeFirstOrThrow();

  const generation = await owner.kysely
    .insertInto('strategy_generations')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      understanding_document_id: doc.id,
      understanding_version: 1,
      status: 'complete',
      option_count: 3,
      similarity_check_result: 'distinct',
      created_by_user_id: params.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const options = await owner.kysely
    .insertInto('strategy_options')
    .values(
      [0, 1, 2].map((ordinal) => ({
        account_id: params.accountId,
        company_id: params.companyId,
        generation_id: generation.id,
        ordinal,
        // An OBJECT, not a JSON string — `strategy_options.fields` and `policies.rules` are both jsonb but
        // their generated insert types differ (`Record<string, string>` here, `string` there), and the
        // compiler is the only thing that says so. Only `jsonb_typeof(fields) = 'object'` is enforced at the
        // database; the 16-field contract standard is a use-case concern and this fixture deliberately does
        // not stand in for the suites that test it.
        fields: { name: `${params.marker} option ${String(ordinal)}` },
      })),
    )
    .returning(['id', 'ordinal'])
    .execute();
  const chosen = options.find((o) => o.ordinal === 0);
  mustExist(chosen, `strategy option 0 for generation ${generation.id}`);

  const selection = await owner.kysely
    .insertInto('strategy_selections')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      generation_id: generation.id,
      mode: 'select',
      selected_option_id: chosen.id,
      phase_scope: 'whole_plan',
      created_by_user_id: params.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const decision = await owner.kysely
    .insertInto('decisions')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      generation_id: generation.id,
      selection_id: selection.id,
      mode: 'select',
      understanding_version: 1,
      created_by_user_id: params.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const roadmap = await owner.kysely
    .insertInto('roadmaps')
    .values({
      account_id: params.accountId,
      company_id: params.companyId,
      version: 1,
      decision_id: decision.id,
      status: 'complete',
      origin: 'generated',
      supersedes_roadmap_id: null,
      edit_reason: null,
      created_by_user_id: params.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const goalTitle = `${params.marker} goal`;
  await owner.kysely
    .insertInto('goals')
    .values({ account_id: params.accountId, company_id: params.companyId, roadmap_id: roadmap.id, ordinal: 0, title: goalTitle })
    .execute();

  // The whole chain, re-read through its terminal row. A roadmap that cannot be read back here would make
  // every "B's roadmap stays invisible" assertion downstream true for the wrong reason.
  const back = await owner.kysely.selectFrom('roadmaps').select('id').where('id', '=', roadmap.id).executeTakeFirst();
  mustExist(back, `roadmap ${roadmap.id} in company ${params.companyId}`);
  const goalBack = await owner.kysely.selectFrom('goals').select('id').where('roadmap_id', '=', roadmap.id).executeTakeFirst();
  mustExist(goalBack, `goal carrying the marker on roadmap ${roadmap.id}`);

  return { roadmapId: roadmap.id, decisionId: decision.id, selectionId: selection.id, generationId: generation.id, documentId: doc.id, goalTitle };
}
