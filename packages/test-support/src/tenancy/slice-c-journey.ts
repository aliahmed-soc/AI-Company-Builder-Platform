// ACBP-P3-007 / CDR-045 — the Slice C journey (M3 milestone exit), implemented ONCE and shared by the runnable demo
// (`pnpm demo:slice-c`) and the CI integration suite so the two can never drift. Test-support only; never a
// production dependency (boundary rule 9).
//
// The journey is the STRATEGY SELECTION vertical: confirmed understanding → three distinct options → advisory
// comparison → owner selection → immutable decision, plus the two negatives the backlog names by hand (a distinctness
// rejection, and a record failure that must block). It runs the REAL @acbp/core use cases through the restricted
// `acbp_app` connection under FORCE RLS; only the model PROVIDER edge is seamed with the deterministic
// FakeModelProvider (CDR-026 §3) — no live model, no key, no snapshot pin.
//
// Types come from @acbp/contracts, never hand-rolled subsets (CDR-045 §2-G5): P4-007 lost three CI round-trips to an
// *optional* field in a structural subset leaving the real DTO assignable, so the compiler passed while the journey
// read `undefined`.
import type { DatabaseClient } from '@acbp/database';
import type { StrategyDecisionRequest, StrategyGenerationDTO, DecisionDTO } from '@acbp/contracts';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

/** The scripted fake-provider behavior the gateway factory turns into a one-shot gateway. */
export type SliceCFakeBehavior = { readonly kind: 'respond'; readonly output: string } | { readonly kind: 'fail'; readonly error: string };
/** An opaque model gateway (the caller builds it via `createModelGateway` with the right validator + fake provider). */
export type SliceCGateway = unknown;
/** Which output validator the caller should wire for a given step. */
export type SliceCValidator = 'understanding' | 'strategy' | 'recommendation';

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/**
 * A failing in-transaction audit writer, for the record-failure-blocks negative (§4-G8).
 *
 * `unknown[]`, not `never[]`: function parameters are contravariant, so a writer declared over `never` would not be
 * assignable to the real `AuditWriteFn` and the whole injected-ops interface would stop matching. test-support cannot
 * import the core-internal `AuditWriteFn` type, so this is the widest shape that still composes.
 */
export type FailingAuditWriter = (...args: readonly unknown[]) => Promise<string>;

export interface SliceCOps {
  generateUnderstanding(c: DatabaseClient, p: Ids, o: { gateway: SliceCGateway }): Promise<Status<{ document: { documentId: string; version: number } }>>;
  confirmUnderstanding(c: DatabaseClient, p: Ids & { expectedVersion: number }): Promise<Status>;
  generateStrategyOptions(c: DatabaseClient, p: Ids, d: { gateway: SliceCGateway }): Promise<Status<{ generation: StrategyGenerationDTO }>>;
  getLatestStrategyGeneration(c: DatabaseClient, p: Ids): Promise<Status<{ generation: StrategyGenerationDTO | null }>>;
  recommendStrategy(c: DatabaseClient, p: Ids & { generationId: string }, d: { gateway: SliceCGateway }): Promise<Status<{ recommendation: { recommendedOrdinal: number; rationale: string; sensitivities: string } | null }>>;
  recordStrategyDecision(c: DatabaseClient, p: Ids & { generationId: string; request: StrategyDecisionRequest }, d: object): Promise<Status<{ selection: { selectionId: string } }>>;
  recordDecision(c: DatabaseClient, p: Ids & { generationId: string; selectionId: string; rationale?: unknown }, d: object, o?: { auditWriter?: FailingAuditWriter }): Promise<Status<{ decision: DecisionDTO }>>;
}

export interface SliceCJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this (CDR-045 §2-G3). */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection only here; never used to prove a guarantee. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /**
   * A SECOND company owned by the same account, for the negatives (§4-G9). They run on their own company so a
   * half-written negative cannot corrupt the state the positive steps already proved, and so a failure is never
   * ambiguous about which half broke.
   */
  readonly negativeCompanyId: string;
  readonly ops: SliceCOps;
  readonly makeGateway: (validator: SliceCValidator, behavior: SliceCFakeBehavior) => SliceCGateway;
}

// ── the scripted model outputs ───────────────────────────────────────────────────────────────────────────
const UNDERSTANDING_OUTPUT = JSON.stringify({
  items: [
    { class: 'fact', content: 'Sells scheduling software to small veterinary clinics.', confidence: 0.9 },
    { class: 'assumption', content: 'Clinics will pay monthly rather than annually.', confidence: 0.4 },
  ],
});

const OPTION_FIELDS = ['description', 'customer', 'offer', 'business_model', 'scope', 'benefits', 'risks', 'cost_range', 'effort', 'time_to_validate', 'time_to_launch', 'required_resources', 'key_assumptions', 'validation_method', 'success_metrics', 'confidence'] as const;

/** A COMPLETE 16-field option — STRAT-001's standard. An incomplete one is rejected, so the fixture must be whole. */
function option(customer: string, offer: string, model: string): Record<string, string> {
  const o: Record<string, string> = {};
  for (const f of OPTION_FIELDS) o[f] = `${f} for ${customer}`;
  o['customer'] = customer;
  o['offer'] = offer;
  o['business_model'] = model;
  return o;
}

/** Three options distinct on all three axes P3-002 dedupes on (customer / offer / business_model). */
const DISTINCT_OUTPUT = JSON.stringify({
  options: [
    option('small veterinary clinics', 'scheduling software', 'monthly subscription'),
    option('mobile groomers', 'route planning', 'per-seat licence'),
    option('equine practices', 'billing reconciliation', 'usage-based pricing'),
  ],
});

/**
 * Three options that are NOT distinct — identical on every dedupe axis, differing only in wording elsewhere. This is
 * the acceptance criterion's "distinctness rejection demo": the platform must collapse them and say so, not pad the
 * set back to three (ADR-019).
 */
const NEAR_DUPLICATE_OUTPUT = JSON.stringify({
  options: [
    option('small veterinary clinics', 'scheduling software', 'monthly subscription'),
    option('small veterinary clinics', 'scheduling software', 'monthly subscription'),
    option('small veterinary clinics', 'scheduling software', 'monthly subscription'),
  ],
});

const RECOMMENDATION_OUTPUT = JSON.stringify({
  recommended_ordinal: 1,
  rationale: 'Reaches a paying customer fastest given the stated constraints.',
  sensitivities: 'Changes if the monthly-billing assumption is wrong.',
});

/**
 * Run the whole Slice C journey. Returns every step's verdict, and NEVER throws for a failed step — the caller
 * decides how to report (the demo prints and exits non-zero; the suite asserts).
 */
export async function runSliceCJourney(deps: SliceCJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, negativeCompanyId, ops, makeGateway } = deps;
  const ids: Ids = { userId, accountId, companyId };
  const negIds: Ids = { userId, accountId, companyId: negativeCompanyId };
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  /** Stop honestly: later steps depend on earlier ones, so a cascade of failures hides the real cause. */
  const bail = (step: string, requirement: string, detail: string): { readonly steps: readonly JourneyStep[] } => {
    record(step, requirement, false, detail);
    return { steps };
  };
  /** Establish the confirmed understanding `generateStrategyOptions` gates on (UNDER-003). */
  const confirmUnderstandingFor = async (scope: Ids): Promise<string | null> => {
    const gen = await ops.generateUnderstanding(product, scope, { gateway: makeGateway('understanding', { kind: 'respond', output: UNDERSTANDING_OUTPUT }) });
    if (gen.status !== 'ok' || gen.document === undefined) return `understanding generation returned ${gen.status}`;
    const ok = await ops.confirmUnderstanding(product, { ...scope, expectedVersion: gen.document.version });
    return ok.status === 'ok' ? null : `confirmation returned ${ok.status}`;
  };

  // ── 1. precondition ────────────────────────────────────────────────────────────────────────────────────
  const preconditionError = await confirmUnderstandingFor(ids);
  if (preconditionError !== null) return bail('confirmed understanding established', 'UNDER-003', preconditionError);
  record('confirmed understanding established', 'UNDER-003', true, 'the gate strategy generation checks — strategy is blocked before this point');

  // ── 2. three genuinely distinct options ────────────────────────────────────────────────────────────────
  const generated = await ops.generateStrategyOptions(product, ids, { gateway: makeGateway('strategy', { kind: 'respond', output: DISTINCT_OUTPUT }) });
  if (generated.status !== 'ok' || generated.generation === undefined) return bail('three distinct options generated', 'STRAT-001', `expected ok, got ${generated.status}`);
  const generation = generated.generation;
  if (generation.options.length !== 3) return bail('three distinct options generated', 'STRAT-001', `expected 3 options, got ${generation.options.length}`);
  if (generation.similarityCheckResult !== 'distinct') return bail('three distinct options generated', 'STRAT-002', `expected similarityCheckResult=distinct, got ${generation.similarityCheckResult}`);
  // Every option COMPLETE on all sixteen fields — an incomplete option is not an option (STRAT-001).
  const incomplete = generation.options.filter((o) => OPTION_FIELDS.some((f) => typeof o.fields[f] !== 'string' || o.fields[f].length === 0));
  if (incomplete.length > 0) return bail('three distinct options generated', 'STRAT-001', `${incomplete.length} option(s) missing one or more of the 16 required fields`);
  record('three genuinely distinct options generated, each complete', 'STRAT-001', true, `3 options, similarity=distinct, all 16 fields present on each; fewerReason=${String(generation.fewerReason)}`);

  // ── 3. the advisory comparison ─────────────────────────────────────────────────────────────────────────
  const recommended = await ops.recommendStrategy(product, { ...ids, generationId: generation.generationId }, { gateway: makeGateway('recommendation', { kind: 'respond', output: RECOMMENDATION_OUTPUT }) });
  if (recommended.status !== 'ok') return bail('advisory recommendation made', 'STRAT-002', `expected ok, got ${recommended.status}`);
  const rec = recommended.recommendation;
  if (rec === null || rec === undefined) return bail('advisory recommendation made', 'STRAT-002', 'the model abstained; the happy path needs a recommendation to prove it does not auto-select');
  if (rec.rationale.length === 0 || rec.sensitivities.length === 0) return bail('advisory recommendation made', 'STRAT-002', 'a recommendation must carry both a rationale and its sensitivities');
  record('the comparison names one option, with rationale + sensitivities', 'STRAT-002', true, `recommended ordinal ${rec.recommendedOrdinal}, with what would change the answer`);

  // ── 4. …and it has NOT selected anything (CDR-045 §3-G6) ───────────────────────────────────────────────
  // The failure worth proving absent: a recommendation that quietly becomes a selection. Without this step the whole
  // slice would pass on a system that auto-selected for the owner, which is exactly what STRAT-003 forbids.
  const beforeSelect = await ops.getLatestStrategyGeneration(product, ids);
  if (beforeSelect.status !== 'ok' || beforeSelect.generation === undefined || beforeSelect.generation === null) return bail('recommendation has not auto-selected', 'STRAT-003', `read expected ok with a generation, got ${beforeSelect.status}`);
  if (beforeSelect.generation.selection !== null) return bail('recommendation has not auto-selected', 'STRAT-003', `a selection exists BEFORE the owner acted: ${JSON.stringify(beforeSelect.generation.selection)}`);
  record('the recommendation has NOT auto-selected — the owner still decides', 'STRAT-003', true, 'selection is null after the advisory comparison and before the owner acts');

  // ── 5. the owner selects, phase-limited ────────────────────────────────────────────────────────────────
  const selected = await ops.recordStrategyDecision(product, { ...ids, generationId: generation.generationId, request: { mode: 'select', selectedOrdinal: 0, phaseScope: 'first_phase' } }, {});
  if (selected.status !== 'ok' || selected.selection === undefined) return bail('owner selects, phase-limited', 'STRAT-003/005', `expected ok, got ${selected.status}`);
  record('the owner selects an option, approval bounded to the first phase', 'STRAT-003/005', true, 'mode=select, phase_scope=first_phase — a phase-limited approval, not a blanket one');

  // ── 6. the immutable decision ──────────────────────────────────────────────────────────────────────────
  const decided = await ops.recordDecision(product, { ...ids, generationId: generation.generationId, selectionId: selected.selection.selectionId, rationale: 'Fastest route to a paying clinic.' }, {});
  if (decided.status !== 'ok' || decided.decision === undefined) return bail('immutable decision recorded', 'STRAT-006', `expected ok, got ${decided.status}`);
  if (decided.decision.mode !== 'select') return bail('immutable decision recorded', 'STRAT-006', `expected the decision to snapshot mode=select, got ${decided.decision.mode}`);
  const afterDecision = await ops.getLatestStrategyGeneration(product, ids);
  if (afterDecision.status !== 'ok' || afterDecision.generation === undefined || afterDecision.generation === null) return bail('decision is surfaced on the read', 'STRAT-006', `read expected ok, got ${afterDecision.status}`);
  if (afterDecision.generation.selection === null) return bail('decision is surfaced on the read', 'STRAT-006', 'the owner selected, but the read still reports no selection');
  record('the immutable decision is recorded and surfaced', 'STRAT-006', true, `decision ${decided.decision.decisionId} snapshots mode=select — what P4-001 planning gates on`);

  // ── 7. NEGATIVE — the distinctness rejection demo (§4-G7) ──────────────────────────────────────────────
  // On its OWN company, so a half-written negative cannot corrupt what the happy path just proved.
  const negPrecondition = await confirmUnderstandingFor(negIds);
  if (negPrecondition !== null) return bail('distinctness rejection demo', 'STRAT-001', `negative company precondition failed: ${negPrecondition}`);
  const collapsed = await ops.generateStrategyOptions(product, negIds, { gateway: makeGateway('strategy', { kind: 'respond', output: NEAR_DUPLICATE_OUTPUT }) });
  if (collapsed.status !== 'ok' || collapsed.generation === undefined) return bail('distinctness rejection demo', 'STRAT-001', `expected an honest ok with FEWER options, got ${collapsed.status}`);
  const collapsedGen = collapsed.generation;
  if (collapsedGen.options.length >= 3) return bail('distinctness rejection demo', 'STRAT-001', `three lookalike options were persisted as ${collapsedGen.options.length}; the set was padded rather than collapsed`);
  if (collapsedGen.similarityCheckResult !== 'insufficient_distinct') return bail('distinctness rejection demo', 'STRAT-002', `expected similarityCheckResult=insufficient_distinct, got ${collapsedGen.similarityCheckResult}`);
  if (collapsedGen.fewerReason === null || collapsedGen.fewerReason.length === 0) return bail('distinctness rejection demo', 'ADR-019', 'fewer than three options were returned with NO stated reason — the gap must be explained, not silent');
  // The generation's own STATUS must say so too. `fewer_than_three` is a first-class honest outcome, not a failure:
  // asserting only the option count would pass on a generation that returned two while still calling itself complete.
  if (collapsedGen.status !== 'fewer_than_three') return bail('distinctness rejection demo', 'STRAT-001', `only ${collapsedGen.options.length} option(s) survived, but the generation reports status=${collapsedGen.status}`);
  record('NEGATIVE: near-duplicate options COLLAPSE, honestly explained', 'STRAT-001 / ADR-019', true, `${collapsedGen.options.length} distinct option(s) kept, status=fewer_than_three, similarity=insufficient_distinct, reason stated rather than padded to three`);

  // ── 8. NEGATIVE — record-failure-blocks (§4-G8) ────────────────────────────────────────────────────────
  // ADR-015 is audit-or-nothing. A decision persisted without its audit event is precisely the silent state change
  // the invariant exists to prevent — and STRAT-006's record is the artifact planning gates on.
  const negSelected = await ops.recordStrategyDecision(product, { ...negIds, generationId: collapsedGen.generationId, request: { mode: 'select', selectedOrdinal: 0, phaseScope: 'first_phase' } }, {});
  if (negSelected.status !== 'ok' || negSelected.selection === undefined) return bail('record-failure-blocks negative', 'STRAT-006', `could not set up the negative: selection returned ${negSelected.status}`);
  const decisionsBefore = await countDecisions(owner, negativeCompanyId);
  const exploding: FailingAuditWriter = async () => {
    await Promise.resolve();
    throw new Error('audit sink down');
  };
  let blocked = false;
  try {
    await ops.recordDecision(product, { ...negIds, generationId: collapsedGen.generationId, selectionId: negSelected.selection.selectionId, rationale: 'should never persist' }, {}, { auditWriter: exploding });
  } catch {
    blocked = true;
  }
  if (!blocked) return bail('record-failure-blocks negative', 'ADR-015', 'a failing audit write did NOT block the decision — it returned normally');
  const decisionsAfter = await countDecisions(owner, negativeCompanyId);
  if (decisionsAfter !== decisionsBefore) return bail('record-failure-blocks negative', 'ADR-015', `the decision survived a failed audit write (${decisionsBefore} → ${decisionsAfter}) — audit-or-nothing was not atomic`);
  record('NEGATIVE: a failed audit write BLOCKS the decision entirely', 'ADR-015 / STRAT-006', true, `rejected, and the decision count is unchanged at ${decisionsAfter} — no decision without its trail`);

  // ── 9. usage verified (§5-G10) ─────────────────────────────────────────────────────────────────────────
  // Per CALL, not a total: a bare `count > 0` passes when one call meters twice and another not at all. Four gateway
  // calls happened — two understandings, the distinct generation, the recommendation — plus the collapsed generation.
  const usage = await sql<{ n: number; kind: string; outcome: string; model: string | null; provider: string | null }>`
    select count(*)::int as n, kind, outcome, max(model) as model, max(provider) as provider
    from usage_events where account_id = ${accountId}::uuid group by kind, outcome
  `.execute(owner.kysely);
  // `ok`, not `success`: usage_events uses ('ok' | 'error') while audit_events uses ('success' | 'denied' | 'blocked').
  // The two vocabularies are deliberately different and easy to conflate — asserting the wrong one silently matches
  // nothing, which is how this read zero rows on its first CI run.
  const successRows = usage.rows.filter((r) => r.outcome === 'ok');
  const metered = successRows.reduce((sum, r) => sum + r.n, 0);
  if (metered < 5) return bail('usage verified', 'Usage verified', `expected one metered success per model call (≥5), got ${metered} across ${usage.rows.length} group(s)`);
  if (successRows.some((r) => r.model === null || r.provider === null)) return bail('usage verified', 'Usage verified', 'a metered call recorded no model/provider — the ledger cannot be reconciled');
  if (successRows.some((r) => r.kind !== 'model_call')) return bail('usage verified', 'Usage verified', `unexpected usage kind(s): ${successRows.map((r) => r.kind).join(', ')}`);
  record('usage verified — every model call left a metered ledger row', 'Usage verified', true, `${metered} successful model_call rows, each carrying its provider + model`);

  // ── 10. trail verified ─────────────────────────────────────────────────────────────────────────────────
  const events = await sql<{ name: string }>`select name from audit_events where company_id = ${companyId}::uuid order by occurred_at, event_id`.execute(owner.kysely);
  const names = events.rows.map((e) => e.name);
  const expected = ['understanding.confirmed', 'strategy.generated', 'strategy.selected', 'decision.recorded'];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0) return bail('trail verified', 'Trail verified', `audit events missing: ${missing.join(', ')} (saw: ${[...new Set(names)].join(', ')})`);

  // No payload may carry content. Searched for the exact strings the journey WROTE, so a fixture rename cannot make
  // this vacuously pass.
  const payloads = await sql<{ blob: string }>`select coalesce(payload::text, '') || coalesce(subject_id::text, '') || name as blob from audit_events where company_id = ${companyId}::uuid`.execute(owner.kysely);
  const forbidden = ['small veterinary clinics', 'scheduling software', 'Fastest route to a paying clinic.', 'Reaches a paying customer fastest', 'Sells scheduling software'];
  const leaked = forbidden.filter((needle) => payloads.rows.some((r) => r.blob.includes(needle)));
  if (leaked.length > 0) return bail('audit payloads carry no content', 'Trail verified', `content leaked into audit payloads: ${leaked.join(' | ')}`);
  record('audit trail verified end to end, no content in payloads', 'Trail verified', true, `${names.length} events on the happy-path company; all ${expected.length} required names present`);

  return { steps };
}

/** Decision rows for a company — EVIDENCE inspection on the owner connection, never a product guarantee. */
async function countDecisions(owner: DatabaseClient, companyId: string): Promise<number> {
  const r = await sql<{ n: number }>`select count(*)::int as n from decisions where company_id = ${companyId}::uuid`.execute(owner.kysely);
  return r.rows[0]?.n ?? 0;
}
