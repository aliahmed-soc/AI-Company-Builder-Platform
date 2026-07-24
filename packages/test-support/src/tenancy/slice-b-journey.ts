// ACBP-P2-012 / CDR-031 — the Slice B journey (M2/M3 milestone exit), implemented ONCE and shared by the runnable
// demo (`pnpm demo:slice-b`) and the CI integration suite so the two can never drift. Test-support only; never a
// production dependency (boundary rule 9).
//
// The journey is the founder-discovery vertical slice: interview → adaptive follow-ups → classification (facts vs
// assumptions) → understanding generation → edit → confirm → correction, ending in the fallback-flag negative demo.
// It runs the REAL @acbp/core use cases through the restricted `acbp_app` connection under FORCE RLS; only the model
// PROVIDER edge is seamed with the deterministic FakeModelProvider (CDR-026 §3) — no live model, no key, no snapshot
// pin.
//
// Like `runSliceAJourney` (which takes its route handlers), the use cases + the gateway factory are INJECTED by the
// caller rather than imported here: @acbp/core's own tests import @acbp/test-support, so test-support must not import
// @acbp/core (that would be a workspace-graph cycle). The two callers (the CI suite and the demo) are each allowed to
// import @acbp/core and supply the real functions, keeping the shared journey cycle-free and the demo drift-free.
import type { DatabaseClient } from '@acbp/database';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

/** The scripted fake-provider behavior the gateway factory turns into a one-shot gateway (a subset of the adapter's). */
export type SliceBFakeBehavior = { readonly kind: 'respond'; readonly output: string } | { readonly kind: 'fail'; readonly error: string };
/** An opaque model gateway (the caller builds it via `createModelGateway` with the right validator + fake provider). */
export type SliceBGateway = unknown;

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Qids = Ids & { readonly sessionId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/**
 * The @acbp/core use cases the journey drives, injected by the caller (structural types — the caller passes the real,
 * more-precisely-typed functions). `gateway` is opaque here; the caller's `makeGateway` produced it.
 */
export interface SliceBOps {
  startInterviewSession(c: DatabaseClient, p: Ids): Promise<Status<{ session: { sessionId: string; state: string } }>>;
  suspendInterviewSession(c: DatabaseClient, p: Ids): Promise<Status<{ session: { state: string } }>>;
  resumeInterviewSession(c: DatabaseClient, p: Ids): Promise<Status<{ session: { state: string } }>>;
  getInterviewSession(c: DatabaseClient, p: Ids): Promise<Status<{ session: { state: string } }>>;
  addInterviewQuestion(c: DatabaseClient, p: Qids & { prompt: string }): Promise<Status<{ question: { questionId: string } }>>;
  generateAdaptiveBatch(c: DatabaseClient, p: Qids & { focusArea: string }, o: { gateway: SliceBGateway }): Promise<Status<{ source: string; questions: ReadonlyArray<{ source: string }> }>>;
  evaluateAnswer(c: DatabaseClient, p: Qids & { questionId: string; answerText: string }, o: { gateway: SliceBGateway }): Promise<Status<{ verdict: string }>>;
  suggestAssumptionForSkip(c: DatabaseClient, p: Qids & { questionId: string }, o: { gateway: SliceBGateway }): Promise<Status>;
  getSessionQa(c: DatabaseClient, p: Qids): Promise<Status<{ qa: { items: ReadonlyArray<unknown> } }>>;
  listMemoryItems(c: DatabaseClient, p: Ids): Promise<Status<{ items: ReadonlyArray<{ type: string; sourceType: string }> }>>;
  generateUnderstanding(c: DatabaseClient, p: Ids, o: { gateway: SliceBGateway }): Promise<Status<{ document: { documentId: string; version: number; items: ReadonlyArray<unknown> } }>>;
  recordUnderstandingReview(c: DatabaseClient, p: Ids & { itemId: string; decision: string; note?: string | null; expectedVersion: number }): Promise<Status>;
  confirmUnderstanding(c: DatabaseClient, p: Ids & { expectedVersion: number }): Promise<Status>;
  correctUnderstanding(c: DatabaseClient, p: Ids & { expectedVersion: number; correctionRef: string }): Promise<Status<{ dependentsFlagged: number }>>;
  isCurrentUnderstandingConfirmed(c: DatabaseClient, p: Ids): Promise<Status<{ confirmed: boolean; version: number | null }>>;
}

export interface SliceBJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this. */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection only; never used to prove a guarantee. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** The injected @acbp/core use cases (the caller passes the real functions). */
  readonly ops: SliceBOps;
  /** Build a one-shot gateway wired to the deterministic fake provider + the given validator. */
  readonly makeGateway: (validator: 'interview' | 'understanding', behavior: SliceBFakeBehavior) => SliceBGateway;
}

/**
 * Run the whole Slice B journey. Returns every step's verdict. NEVER throws for a failed step — the caller decides
 * how to report (the demo prints and exits non-zero; the suite asserts), so a failure is always visible with its
 * evidence rather than as an opaque stack.
 */
export async function runSliceBJourney(deps: SliceBJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, ops, makeGateway } = deps;
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  const iBase = { userId, accountId, companyId };
  const usageCount = async (): Promise<number> => (await sql<{ n: number }>`select count(*)::int as n from usage_events where company_id = ${companyId}::uuid`.execute(owner.kysely)).rows[0]!.n;

  // ── 1. Start interview (not_started → in_progress) ─────────────────────────────────────────────────
  const started = await ops.startInterviewSession(product, iBase);
  const sessionId = started.session?.sessionId ?? '';
  record('interview starts (not_started → in_progress)', 'DISC-001', started.status === 'ok' && started.session?.state === 'in_progress', `startInterviewSession → ${started.status}, state=${started.session?.state ?? 'n/a'}`);
  const qBase = { userId, accountId, companyId, sessionId };

  // ── 2. Adaptive follow-ups (≤3, source=adaptive, metered) ──────────────────────────────────────────
  const batch = await ops.generateAdaptiveBatch(product, { ...qBase, focusArea: 'target market' }, { gateway: makeGateway('interview', { kind: 'respond', output: '{"questions":["Who is your customer?","What problem do you solve?"]}' }) });
  const batchQs = batch.questions ?? [];
  record('adaptive follow-ups respond to the focus area (≤3, flagged adaptive)', 'DISC-002/003', batch.status === 'ok' && batch.source === 'adaptive' && batchQs.length > 0 && batchQs.length <= 3, `generateAdaptiveBatch → ${batch.status}, source=${batch.source ?? 'n/a'}, ${String(batchQs.length)} question(s)`);

  // ── 3. Classification — a CLEAR answer becomes a user_fact memory item (MEM-001) ───────────────────
  const q1 = await ops.addInterviewQuestion(product, { ...qBase, prompt: 'Who is your target customer?' });
  const clear = await ops.evaluateAnswer(product, { ...qBase, questionId: q1.question?.questionId ?? '', answerText: 'Small coffee shops in Cairo.' }, { gateway: makeGateway('interview', { kind: 'respond', output: '{"verdict":"clear"}' }) });
  const memAfterFact = await ops.listMemoryItems(product, iBase);
  const hasFact = (memAfterFact.items ?? []).some((i) => i.type === 'user_fact' && i.sourceType === 'interview_answer');
  record('a clear answer is classified as a user_fact memory item', 'MEM-001', clear.status === 'ok' && clear.verdict === 'clear' && hasFact, `evaluateAnswer verdict=${clear.verdict ?? clear.status}; user_fact present=${String(hasFact)}`);

  // ── 4. Classification — an "I don't know" becomes a labeled ai_assumption (facts stay distinct) ────
  const q2 = await ops.addInterviewQuestion(product, { ...qBase, prompt: 'What is your pricing model?' });
  const assumed = await ops.suggestAssumptionForSkip(product, { ...qBase, questionId: q2.question?.questionId ?? '' }, { gateway: makeGateway('interview', { kind: 'respond', output: '{"assumption":"Assuming a monthly subscription at an entry price point."}' }) });
  const memAfterAssume = ((await ops.listMemoryItems(product, iBase)).items) ?? [];
  const hasAssumption = memAfterAssume.some((i) => i.type === 'ai_assumption' && i.sourceType === 'model_generation');
  const factsStayDistinct = memAfterAssume.some((i) => i.type === 'user_fact') && hasAssumption;
  record('an "I don\'t know" is a labeled ai_assumption, distinct from facts', 'MEM-001/UNDER-002', assumed.status === 'ok' && factsStayDistinct, `ai_assumption present=${String(hasAssumption)}; facts+assumptions both distinct=${String(factsStayDistinct)}`);

  // ── 5. Resumability — suspend then resume round-trips state; Q&A intact (DISC-007) ─────────────────
  const suspended = await ops.suspendInterviewSession(product, iBase);
  const resumed = await ops.resumeInterviewSession(product, iBase);
  const afterResume = await ops.getInterviewSession(product, iBase);
  const qaAfter = await ops.getSessionQa(product, qBase);
  const stateRoundTrips = suspended.session?.state === 'waiting_for_user' && resumed.session?.state === 'in_progress' && afterResume.session?.state === 'in_progress';
  const qaIntact = (qaAfter.qa?.items.length ?? 0) >= 2;
  record('the session suspends and resumes exactly, Q&A intact', 'DISC-007', stateRoundTrips && qaIntact, `suspend→${suspended.session?.state ?? suspended.status}, resume→${resumed.session?.state ?? resumed.status}; Q&A items after resume=${String(qaAfter.qa?.items.length ?? 0)}`);

  // ── 6. Understanding generated from the confirmed/typed memory (UNDER-001) ─────────────────────────
  const gen = await ops.generateUnderstanding(product, iBase, { gateway: makeGateway('understanding', { kind: 'respond', output: '{"items":[{"class":"fact","content":"Serves small coffee shops in Cairo.","confidence":0.9},{"class":"assumption","content":"Monthly subscription pricing.","confidence":0.4},{"class":"open_question","content":"Channel strategy is undefined.","confidence":0.2}]}' }) });
  const docId = gen.document?.documentId ?? '';
  const version = gen.document?.version ?? 0;
  record('an understanding document is generated + versioned + classified', 'UNDER-001', gen.status === 'ok' && (gen.document?.items.length ?? 0) === 3 && version === 1, `generateUnderstanding → ${gen.status}, v=${String(version)}, ${String(gen.document?.items.length ?? 0)} classified item(s)`);

  // ── 7. Planning is BLOCKED pre-confirm (the strategy gate is closed) ───────────────────────────────
  const gatePre = await ops.isCurrentUnderstandingConfirmed(product, iBase);
  record('planning is blocked before confirmation (gate closed)', 'UNDER-003', gatePre.status === 'ok' && gatePre.confirmed === false && gatePre.version === version, `isCurrentUnderstandingConfirmed → confirmed=${String(gatePre.confirmed ?? gatePre.status)}`);

  // ── 8. Edit — an owner review decision on an item of the current version (UNDER-003) ───────────────
  const anItem = await sql<{ id: string }>`select id from understanding_items where document_id = ${docId}::uuid order by id limit 1`.execute(owner.kysely);
  const itemId = anItem.rows[0]?.id ?? '';
  const edited = await ops.recordUnderstandingReview(product, { ...iBase, itemId, decision: 'edited', note: 'Corrected: single-origin specialty coffee shops.', expectedVersion: version });
  record('the owner edits an understanding item (review recorded)', 'UNDER-003', edited.status === 'ok', `recordUnderstandingReview(edited) → ${edited.status}`);

  // ── 9. Confirm gates planning (strategy unlocked) ──────────────────────────────────────────────────
  const confirmed = await ops.confirmUnderstanding(product, { ...iBase, expectedVersion: version });
  const gatePost = await ops.isCurrentUnderstandingConfirmed(product, iBase);
  record('confirming the understanding unlocks strategy (gate opens)', 'UNDER-003', confirmed.status === 'ok' && gatePost.confirmed === true, `confirmUnderstanding → ${confirmed.status}; gate now confirmed=${String(gatePost.confirmed ?? gatePost.status)}`);

  // ── 10. A correction supersedes the confirmation → dependents flagged, planning re-blocked (DISC-008)
  const corrected = await ops.correctUnderstanding(product, { ...iBase, expectedVersion: version, correctionRef: itemId });
  const gateAfterCorrection = await ops.isCurrentUnderstandingConfirmed(product, iBase);
  record('a correction supersedes the confirmation and re-blocks planning', 'DISC-008', corrected.status === 'ok' && (corrected.dependentsFlagged ?? 0) >= 1 && gateAfterCorrection.confirmed === false, `correctUnderstanding → ${corrected.status}, dependentsFlagged=${String(corrected.dependentsFlagged ?? 'n/a')}; gate re-closed=${String(gateAfterCorrection.confirmed === false)}`);

  // ── 11. Usage events verified (one per model call; metered, not billed) ────────────────────────────
  const usage = await usageCount();
  // 4 model calls in the happy path: adaptive batch + evaluateAnswer(clear) + suggestAssumptionForSkip + generateUnderstanding.
  record('usage events recorded per model call (metered, not billed)', 'USAGE-001', usage >= 4, `${String(usage)} usage_events row(s) for the company (>= 4 model calls)`);

  // ── 12. Audit trail verified (tenant + actor stamped) ──────────────────────────────────────────────
  const audits = await owner.kysely.selectFrom('audit_events').select(['name', 'account_id', 'actor_id']).where('company_id', '=', companyId).execute();
  const names = new Set(audits.map((a) => a.name));
  const expectedAudits = ['interview.started', 'memory.item_created', 'understanding.generated', 'understanding.confirmed', 'understanding.corrected'];
  const allPresent = expectedAudits.every((n) => names.has(n));
  const tenantActorCorrect = audits.length > 0 && audits.every((a) => a.account_id === accountId && a.actor_id === userId);
  record('the durable audit trail records the whole slice, tenant + actor stamped', 'ACT-001/NFR-001', allPresent && tenantActorCorrect, `events={${[...names].sort().join(', ')}}; all expected present=${String(allPresent)}; tenant+actor stamped=${String(tenantActorCorrect)}`);

  // ── 13. NEGATIVE — fallback-flag demo (ADR-019 non-silent fallback) ────────────────────────────────
  // (a) A follow-up generation FAILURE falls back to the static bank, HONESTLY flagged `static_fallback`.
  const fallbackBatch = await ops.generateAdaptiveBatch(product, { ...qBase, focusArea: 'operations' }, { gateway: makeGateway('interview', { kind: 'fail', error: 'provider_unavailable' }) });
  const fbQs = fallbackBatch.questions ?? [];
  const honestFallback = fallbackBatch.status === 'ok' && fallbackBatch.source === 'static_fallback' && fbQs.length > 0 && fbQs.every((q) => q.source === 'static_fallback');
  // (b) An understanding-generation FAILURE returns generation_failed and persists NOTHING (no silent fabricated doc).
  const docsBefore = (await sql<{ n: number }>`select count(*)::int as n from understanding_documents where company_id = ${companyId}::uuid`.execute(owner.kysely)).rows[0]!.n;
  const failedGen = await ops.generateUnderstanding(product, iBase, { gateway: makeGateway('understanding', { kind: 'fail', error: 'provider_unavailable' }) });
  const docsAfter = (await sql<{ n: number }>`select count(*)::int as n from understanding_documents where company_id = ${companyId}::uuid`.execute(owner.kysely)).rows[0]!.n;
  const noSilentGen = failedGen.status === 'generation_failed' && docsAfter === docsBefore;
  record('NEGATIVE: fallbacks are flagged, never silent — static_fallback surfaced + generation persists nothing on failure', 'ADR-019', honestFallback && noSilentGen, `follow-up fallback flagged static_fallback=${String(honestFallback)}; understanding generation_failed with no new document=${String(noSilentGen)} (docs ${String(docsBefore)}→${String(docsAfter)})`);

  return { steps };
}
