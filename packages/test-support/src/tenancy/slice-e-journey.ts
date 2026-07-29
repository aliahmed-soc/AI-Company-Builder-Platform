// ACBP-P5-015 / CDR-065 — the Slice E journey (M5 milestone exit), implemented ONCE and shared by the runnable demo
// (`pnpm demo:slice-e`) and the CI integration suite so the two can never drift. Test-support only; never a production
// dependency (boundary rule 9).
//
// The journey is the SAFE INTERNAL EXECUTION vertical: preflight → queue → run → research document → provenance →
// completion → settlement → ledger → activity/audit → revision, followed by the negative set the backlog's security
// column asks for. It runs the REAL @acbp/core use cases through the restricted `acbp_app` connection under FORCE RLS;
// only the three edges OUTSIDE the trust boundary are seamed (model provider, research fetcher, object storage) —
// CDR-065 §2-G3.
//
// Like every earlier journey, the use cases are INJECTED by the caller rather than imported: @acbp/core's own tests
// import @acbp/test-support, so test-support must not import @acbp/core (that would be a workspace-graph cycle).
//
// TWO THINGS THIS JOURNEY DOES NOT PROVE, stated here because a green run reads like proof of more than it is:
//   1. It does NOT prove the product reserves a credit when a task is queued. Nothing does that yet — CDR-065 §2-G1.
//      The journey reserves explicitly, as the caller, and step 4's text says so in the demo output.
//   2. It does NOT demonstrate the ACT-004 activity VIEWS or USAGE-001 ROLLUPS. Those are P6-008/P6-009 and do not
//      exist. What is reconciled here is the ledger and the event streams that do (CDR-065 §5-G9).
import type { DatabaseClient } from '@acbp/database';
// Real contract types wherever one exists. Slice D was burned twice by hand-rolled structural subsets that
// type-checked perfectly while being wrong about a field NAME, and only failed minutes into a real-PostgreSQL CI run.
import { CREDITS_PER_MANUAL_RUN, RISK_CLASSES } from '@acbp/contracts';
import type { ArtifactRevisionDTO, RiskClass, RunFailureCategory } from '@acbp/contracts';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

/** The scripted fake-provider behavior the caller's gateway factory turns into a one-shot gateway. */
export type SliceEFakeBehavior = { readonly kind: 'respond'; readonly output: string } | { readonly kind: 'fail'; readonly error: string };
/** An opaque model gateway — the caller built it via `createModelGateway` with `researchOutputValidator`. */
export type SliceEGateway = unknown;

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/**
 * The artifact shape `runResearch` and `listRunArtifacts` return (core's `ArtifactDTO`).
 *
 * STRUCTURAL, unavoidably: `ArtifactDTO` is declared in `@acbp/core/artifacts/persist.ts`, and test-support cannot
 * import core. Kept to the three fields actually asserted, so the gap between this and the real DTO is as small as it
 * can be, and every field here is read from a value the product returned.
 *
 * NOTE THE `id`. It is NOT `artifactId` — that is the LINEAGE read's field name (see {@link SliceELineageArtifact}),
 * and the two really do differ. Writing `artifactId` here type-checks against nothing and yields `undefined` at
 * runtime; Slice D lost two CI runs to exactly this, which is why both shapes are spelled out separately.
 */
export interface SliceEArtifact {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
}

/** What `readArtifactLineage` returns for the artifact itself — a DIFFERENT shape, keyed `artifactId`. */
export interface SliceELineageArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly title: string;
}

/** The @acbp/core use cases the journey drives, injected by the caller (the caller passes the real functions). */
export interface SliceEOps {
  createTask(c: DatabaseClient, p: Ids & { title: string; description?: string | null }): Promise<Status<{ task: { taskId: string } }>>;
  planTask(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: { state: string } }>>;
  preflightRun(c: DatabaseClient, p: Ids): Promise<Status<{ balance: number; cost: number; affordable: boolean; sideEffectClass: RiskClass }>>;
  startRun(c: DatabaseClient, p: Ids & { taskId: string; attempt: number }): Promise<Status<{ run: { id: string; state: string; attempt: number } }>>;
  reserveCredit(c: DatabaseClient, p: Ids & { taskRunId: string; idempotencyKey: string }): Promise<Status<{ entry: { id: string; credits: number }; balanceAfter: number; balance: number; cost: number }>>;
  runResearch(
    c: DatabaseClient,
    p: Ids & { runId: string; taskType: string; question: string; workerVersion: number; modelVersion: string },
    d: { gateway: SliceEGateway; fetcher: unknown; storage: unknown },
  ): Promise<Status<{ artifact: SliceEArtifact; sourcedClaims: number; unverifiedClaims: number; reason: string }>>;
  listRunArtifacts(c: DatabaseClient, p: Ids & { runId: string }): Promise<readonly SliceEArtifact[] | 'forbidden'>;
  succeedRun(c: DatabaseClient, p: Ids & { runId: string }): Promise<Status<{ run: { state: string } }>>;
  /** `failureCategory` is the CLOSED `RunFailureCategory` union and is OPTIONAL on the real params — a category is
   *  required only when finishing as failed, and refused on success. Typed from the contract so the journey cannot
   *  pass a category that does not exist. */
  failRun(c: DatabaseClient, p: Ids & { runId: string; failureCategory?: RunFailureCategory }): Promise<Status<{ run: { state: string; failureCategory: string | null } }>>;
  completeTask(c: DatabaseClient, p: Ids & { taskId: string; runId: string; evidence: unknown }): Promise<Status<{ artifactCount: number }>>;
  settleRun(c: DatabaseClient, p: Ids & { taskRunId: string }): Promise<Status<{ settlement: string; balanceAfter: number }>>;
  readCreditLedger(c: DatabaseClient, p: { userId: string; accountId: string; limit?: number }): Promise<Status<{ balance: number; entries: readonly { id: string; kind: string; credits: number; runId: string | null }[] }>>;
  /**
   * `ActivityPage.items` — NOT `events` — holding `ActivityEventDTO`s whose discriminator is `type`, NOT
   * `activityType`. Both names were wrong in the first draft and the compiler caught both, which is the entire reason
   * the ops object is annotated rather than cast. `limit` is `unknown` on the real params (it is validated, not
   * trusted), so it is `unknown` here.
   */
  getCompanyActivity(c: DatabaseClient, p: Ids & { limit?: unknown }): Promise<Status<{ page: { items: readonly { type: string }[] } }>>;
  requestRevision(c: DatabaseClient, p: Ids & { artifactId: string; guidance: string; idempotencyKey: string }): Promise<Status<{ revision: ArtifactRevisionDTO; newTaskId: string; deduplicated: boolean }>>;
  readArtifactLineage(c: DatabaseClient, p: Ids & { artifactId: string }): Promise<Status<{ artifact: SliceELineageArtifact; revisedFrom: ArtifactRevisionDTO | null; revisions: readonly ArtifactRevisionDTO[] }>>;
}

export interface SliceEJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this (CDR-065 §2-G2). */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection and the two preconditions the product cannot reach. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  readonly ops: SliceEOps;
  /** Build a one-shot gateway wired to the deterministic fake provider + `researchOutputValidator`. */
  readonly makeGateway: (behavior: SliceEFakeBehavior) => SliceEGateway;
  /** Build a fresh in-memory fetcher already seeded with the journey's sources for `question`. */
  readonly makeFetcher: (question: string, sources: readonly SliceESource[]) => unknown;
  /** Build a fresh in-memory object storage. */
  readonly makeStorage: () => unknown;
}

/** Mirrors `FetchedSource` from @acbp/contracts — restated so the caller can build sources without importing it. */
export interface SliceESource {
  readonly url: string;
  readonly title: string;
  readonly retrievedAt: string;
  readonly content: string;
}

// ── the scripted inputs ──────────────────────────────────────────────────────────────────────────────────
// Deterministic and inline: a milestone exit is a claim about the PLATFORM, so its inputs must be fixed. A randomised
// payload would make a failure unreproducible, which is the opposite of what a milestone exit is for.

const QUESTION = 'How large is the UK independent gym market?';
const RETRIEVED_AT = '2026-07-29T09:00:00.000Z';
const TASK_TYPE = 'market_research';

const SOURCE_A: SliceESource = { url: 'https://example.test/uk-gym-report', title: 'UK gym report 2026', retrievedAt: RETRIEVED_AT, content: 'Ordinary research prose about the independent gym market.' };
const SOURCE_B: SliceESource = { url: 'https://example.test/segment-data', title: 'Segment data', retrievedAt: RETRIEVED_AT, content: 'Segment breakdown by member count and region.' };
const SOURCES: readonly SliceESource[] = [SOURCE_A, SOURCE_B];

const cite = (s: SliceESource) => ({ url: s.url, title: s.title, retrievedAt: s.retrievedAt });

/**
 * The research document the worker is scripted to produce.
 *
 * The THIRD claim is deliberately UNVERIFIED. WORK-002's promise is "a citation or an admission, never an invention",
 * and the admission half is the half that rots untested — a fixture where every claim happened to be cited would let
 * the honest-gap path decay without any test noticing. Same reasoning as CDR-044 §4-G8's missing rationale.
 */
const RESEARCH_OUTPUT = JSON.stringify({
  title: 'UK independent gym market',
  summary: 'What the retrieved sources say about market size.',
  claims: [
    { statement: 'The independent segment is reported separately from chains.', sources: [cite(SOURCE_A)] },
    { statement: 'Member counts are broken down by region.', sources: [cite(SOURCE_B)] },
    { statement: 'Growth is expected to continue next year.', unverifiedReason: 'No retrieved source states a forward projection.' },
  ],
});

/**
 * The same document, but citing a URL the fetcher NEVER returned. This is the fabricated-citation negative: WORK-002's
 * actual promise is that this cannot reach storage, and a research document whose citations were never checked is
 * worse than no document, because a founder will act on it.
 */
const FABRICATED_OUTPUT = JSON.stringify({
  title: 'UK independent gym market',
  summary: 'What the sources say.',
  claims: [{ statement: 'The market tripled last year.', sources: [{ url: 'https://example.test/never-fetched', title: 'Invented source', retrievedAt: RETRIEVED_AT }] }],
});

/**
 * Run the whole Slice E journey. Returns every step's verdict. NEVER throws for a failed step — the caller decides how
 * to report (the demo prints and exits non-zero; the suite asserts), so a failure is always visible with its evidence
 * rather than as an opaque stack.
 */
export async function runSliceEJourney(deps: SliceEJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, ops, makeGateway, makeFetcher, makeStorage } = deps;
  const ids: Ids = { userId, accountId, companyId };
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  /** Stop the sequence honestly: later steps depend on earlier ones, so a cascade of failures hides the real cause. */
  const bail = (step: string, requirement: string, detail: string): { readonly steps: readonly JourneyStep[] } => {
    record(step, requirement, false, detail);
    return { steps };
  };

  /**
   * A research task in `queued`, which is the only startable state.
   *
   * `createTask` → `planTask` is the REAL product path as far as `planned`. The last hop is done on the OWNER
   * connection because `planned→queued` is legal in the contract and implemented by NO use case (CDR-065 §3-G5c) —
   * the same shape as Slice D's owner-side `failed`. `task_type` is stamped here too: `CreateTaskParams` carries no
   * type, and "pick a research task" has to mean something.
   */
  const queuedResearchTask = async (title: string): Promise<string | undefined> => {
    const created = await ops.createTask(product, { ...ids, title });
    if (created.status !== 'ok' || created.task === undefined) return undefined;
    const taskId = created.task.taskId;
    const planned = await ops.planTask(product, { ...ids, taskId });
    if (planned.status !== 'ok') return undefined;
    await sql`update tasks set state = 'queued', task_type = ${TASK_TYPE} where id = ${taskId}::uuid`.execute(owner.kysely);
    return taskId;
  };

  const researchParams = (runId: string) => ({ ...ids, runId, taskType: TASK_TYPE, question: QUESTION, workerVersion: 1, modelVersion: 'fake@1' });
  const researchDeps = (behavior: SliceEFakeBehavior) => ({ gateway: makeGateway(behavior), fetcher: makeFetcher(QUESTION, SOURCES), storage: makeStorage() });

  // The account needs a balance, and the PRODUCT ROLE HAS NO GRANT PATH — deliberately (CDR-058 §4). Minting on the
  // owner connection is therefore a precondition, not a demonstration. Two runs' worth: the happy path consumes one,
  // and the negatives reserve-and-release around the other.
  const granted = CREDITS_PER_MANUAL_RUN * 2;
  await sql`insert into credit_transactions (account_id, kind, credits) values (${accountId}::uuid, 'grant', ${granted})`.execute(owner.kysely);

  // ── 1. preflight: what will this cost, before anything is committed (TASK-004) ──────────────────────────
  const pre = await ops.preflightRun(product, ids);
  if (pre.status !== 'ok' || pre.cost === undefined || pre.balance === undefined) return bail('preflight', 'TASK-004', `expected ok, got ${pre.status}`);
  if (!pre.affordable) return bail('preflight', 'TASK-004', `granted ${granted} credits but preflight reports the run unaffordable at cost ${pre.cost}`);
  // MEMBERSHIP in canon's closed set AND the value CDR-058 §4 records. D8 was a test asserting `internal_only`, a
  // fifth name that exists nowhere in the set — so the membership half is the one that would have caught it.
  if (!(RISK_CLASSES as readonly string[]).includes(pre.sideEffectClass as string)) return bail('preflight shows the side-effect class', 'TASK-004', `sideEffectClass ${String(pre.sideEffectClass)} is outside canon's closed RiskClass set`);
  if (pre.sideEffectClass !== 'informational') return bail('preflight shows the side-effect class', 'TASK-004', `expected informational (CDR-058 §4 — nothing external can happen yet), got ${String(pre.sideEffectClass)}`);
  record('preflight states cost, balance and side-effect class before anything runs', 'TASK-004', true, `cost ${pre.cost}, balance ${pre.balance}, affordable, class=${String(pre.sideEffectClass)} — the founder sees the price before committing`);

  // ── 2. a research task, queued ─────────────────────────────────────────────────────────────────────────
  const taskId = await queuedResearchTask('Size the UK independent gym market');
  if (taskId === undefined) return bail('a research task is queued', 'TASK-001', 'createTask/planTask did not reach planned');
  record('a research task reaches the queue', 'TASK-001', true, `task ${taskId} — created and planned through the product; planned→queued set on the owner connection because NO use case implements it (CDR-065 §3-G5c)`);

  // ── 3. the run starts ──────────────────────────────────────────────────────────────────────────────────
  const started = await ops.startRun(product, { ...ids, taskId, attempt: 1 });
  if (started.status !== 'ok' || started.run === undefined) return bail('run starts', 'TASK-004', `expected ok, got ${started.status}`);
  const runId = started.run.id;
  if (started.run.state !== 'running' || started.run.attempt !== 1) return bail('run starts', 'TASK-004', `expected attempt 1 running, got attempt ${started.run.attempt} ${started.run.state}`);
  // THE TASK'S OWN STATE, moved on the owner connection for the same reason as `planned→queued` (CDR-065 §3-G5c).
  // `startRun` advances the RUN's state machine and writes `task.started`, but it does not touch `tasks.state` — so
  // after a real start the task still reads `queued` while its run is executing. Every execution-side task transition
  // is unimplemented, not just the first one; this is the second half of the same documented gap.
  await sql`update tasks set state = 'running' where id = ${taskId}::uuid`.execute(owner.kysely);
  record('the run is claimed and running', 'TASK-004', true, `run ${runId}, attempt 1 — the claim is exclusive, so a second coordinator is refused rather than duplicated. The TASK's own queued→running is set on the owner connection: startRun advances the run, not the task (CDR-065 §3-G5c)`);

  // ── 4. the credit is reserved BEFORE the work (CDR-065 §3-G5b) ──────────────────────────────────────────
  const reserved = await ops.reserveCredit(product, { ...ids, taskRunId: runId, idempotencyKey: `slice-e-${runId}` });
  if (reserved.status !== 'ok' || reserved.balanceAfter === undefined) return bail('credit reserved before the work', 'BILL-002', `expected ok, got ${reserved.status}`);
  if (reserved.balanceAfter !== pre.balance - pre.cost) return bail('credit reserved before the work', 'BILL-002', `expected balance ${pre.balance - pre.cost} after reserving ${pre.cost}, got ${reserved.balanceAfter}`);
  record('one credit is reserved before the worker is invoked', 'BILL-002 / TASK-004', true, `balance ${pre.balance} → ${reserved.balanceAfter}. RESERVED BY THIS JOURNEY, not by the queue transition — nothing wires that yet (CDR-065 §2-G1)`);

  // ── 5. the research worker runs ────────────────────────────────────────────────────────────────────────
  const research = await ops.runResearch(product, researchParams(runId), researchDeps({ kind: 'respond', output: RESEARCH_OUTPUT }));
  if (research.status !== 'ok' || research.artifact === undefined) return bail('research runs', 'WORK-002', `expected ok, got ${research.status}${research.reason === undefined ? '' : ` (${research.reason})`}`);
  if ((research.sourcedClaims ?? 0) < 1) return bail('every claim is cited or admitted', 'WORK-002', 'no claim carried a citation');
  if ((research.unverifiedClaims ?? 0) < 1) return bail('every claim is cited or admitted', 'WORK-002', 'no claim was marked unverified — the admission path was never exercised, so it could rot without any test noticing');
  record('research produces a document where every claim is cited or admitted', 'WORK-002', true, `${research.sourcedClaims} cited, ${research.unverifiedClaims} honestly marked unverified — never invented`);

  // ── 6. provenance: the artifact records the run that made it ───────────────────────────────────────────
  const artifacts = await ops.listRunArtifacts(product, { ...ids, runId });
  if (artifacts === 'forbidden') return bail('artifact provenance', 'TASK-005', 'listRunArtifacts refused the run that just produced the artifact');
  if (artifacts.length !== 1) return bail('artifact provenance', 'TASK-005', `expected exactly 1 artifact for run ${runId}, got ${artifacts.length}`);
  const artifact = artifacts[0];
  if (artifact === undefined || artifact.runId !== runId) return bail('artifact provenance', 'TASK-005', `artifact does not point back at its run (${String(artifact?.runId)} ≠ ${runId})`);
  record('the document records which run produced it', 'TASK-005 / ADR-013', true, `artifact ${artifact.id} → run ${runId}, read back through the product`);

  // ── 7. the run succeeds and the task completes against that evidence ───────────────────────────────────
  const succeeded = await ops.succeedRun(product, { ...ids, runId });
  if (succeeded.status !== 'ok') return bail('run succeeds', 'TASK-006', `expected ok, got ${succeeded.status}`);
  // `kind` is REQUIRED: `CompletionEvidence` is a closed union of exactly two shapes, and a bare `{artifactIds}` is
  // `unknown_shape`. The discriminator is what stops an artifactless completion from arriving as an empty array.
  const completed = await ops.completeTask(product, { ...ids, taskId, runId, evidence: { kind: 'artifacts', artifactIds: [artifact.id] } });
  if (completed.status !== 'ok') return bail('task completes with evidence', 'TASK-005', `expected ok, got ${completed.status}${completed.reason === undefined ? '' : ` (${String(completed.reason)})`}`);
  if (completed.artifactCount !== 1) return bail('task completes with evidence', 'TASK-005', `expected 1 cited artifact, got ${String(completed.artifactCount)}`);
  record('the task completes, citing the artifact it produced', 'TASK-005', true, `${completed.artifactCount} artifact cited — completion is refused if the evidence names anything this run did not produce`);

  // ── 8. settlement ──────────────────────────────────────────────────────────────────────────────────────
  const settled = await ops.settleRun(product, { ...ids, taskRunId: runId });
  if (settled.status !== 'ok') return bail('settlement', 'BILL-002', `expected ok, got ${settled.status}`);
  if (settled.settlement !== 'consume') return bail('settlement', 'BILL-002', `a SUCCEEDED run must consume its reservation, got ${String(settled.settlement)}`);
  record('a succeeded run consumes its reservation', 'BILL-002', true, `settlement=consume, balance ${String(settled.balanceAfter)} — the reservation is what was charged; consumption is a marker, not a second debit (D9)`);

  // ── 9. the ledger reconciles (USAGE-001, CDR-065 §5-G8) ────────────────────────────────────────────────
  const LEDGER_LIMIT = 100;
  const ledger = await ops.readCreditLedger(product, { userId, accountId, limit: LEDGER_LIMIT });
  if (ledger.status !== 'ok' || ledger.entries === undefined || ledger.balance === undefined) return bail('ledger reconciles', 'USAGE-001', `expected ok, got ${ledger.status}`);
  // WITHOUT THIS the reconciliation below is vacuous: a truncated page would sum to something that merely happens not
  // to match, or worse, happens to match. Silent truncation reading as "everything reconciled" is the failure here.
  if (ledger.entries.length >= LEDGER_LIMIT) return bail('ledger reconciles', 'USAGE-001', `the ledger page is full (${ledger.entries.length} ≥ ${LEDGER_LIMIT}) — the sum below would be over a truncated page`);
  const summed = ledger.entries.reduce((n, e) => n + e.credits, 0);
  if (summed !== ledger.balance) return bail('ledger reconciles', 'USAGE-001', `the product's own balance (${ledger.balance}) disagrees with the sum of the entries it lists (${summed})`);
  if (ledger.balance !== granted - CREDITS_PER_MANUAL_RUN) return bail('ledger reconciles', 'USAGE-001', `expected ${granted - CREDITS_PER_MANUAL_RUN} after one consumed run, got ${ledger.balance}`);
  const kinds = ledger.entries.map((e) => e.kind);
  if (!kinds.includes('reservation') || !kinds.includes('consumption')) return bail('ledger reconciles', 'USAGE-001', `expected both a reservation and a consumption in the trail, saw: ${[...new Set(kinds)].join(', ')}`);
  record('the ledger reconciles against the balance the product reports', 'USAGE-001 / BILL-002', true, `${ledger.entries.length} entries summing to ${summed} = reported balance ${ledger.balance}; both derivations are the product's, not the journey's`);

  // ── 10. the trail: activity + audit, carrying no content ───────────────────────────────────────────────
  const activity = await ops.getCompanyActivity(product, { ...ids, limit: 50 });
  if (activity.status !== 'ok' || activity.page === undefined) return bail('activity is visible', 'ACT-001', `expected ok, got ${activity.status}`);
  if (activity.page.items.length === 0) return bail('activity is visible', 'ACT-001', 'the founder-facing activity stream is empty after a whole run');

  const events = await sql<{ name: string }>`select name from audit_events where company_id = ${companyId}::uuid order by occurred_at, event_id`.execute(owner.kysely);
  const names = events.rows.map((e) => e.name);
  const expected = ['task.created', 'task.started', 'credit.reserved', 'task.completed'];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0) return bail('trail verified', 'Trail verified', `audit events missing: ${missing.join(', ')} (saw: ${[...new Set(names)].join(', ')})`);

  // No payload may carry content — checked against the strings the journey ACTUALLY wrote, so a rename in the fixture
  // cannot make this check vacuously pass.
  const payloads = await sql<{ blob: string }>`select coalesce(payload::text, '') || coalesce(subject_id::text, '') || name as blob from audit_events where company_id = ${companyId}::uuid`.execute(owner.kysely);
  const forbidden = [QUESTION, 'Size the UK independent gym market', 'UK independent gym market', SOURCE_A.url, SOURCE_A.content, 'Growth is expected to continue next year.'];
  const leaked = forbidden.filter((needle) => payloads.rows.some((r) => r.blob.includes(needle)));
  if (leaked.length > 0) return bail('audit payloads carry no content', 'NFR-008', `content leaked into audit metadata: ${leaked.join(' | ')}`);
  record('activity and audit both record the run, and no payload carries content', 'ACT-001 / ACT-002 / NFR-008', true, `${activity.page.items.length} activity event(s), ${names.length} audit event(s); ${expected.length} required names present, 0 content leaks`);

  // ── 11. revision (J-13) — and it charges NOTHING at request time ───────────────────────────────────────
  const balanceBeforeRevision = ledger.balance;
  const revision = await ops.requestRevision(product, { ...ids, artifactId: artifact.id, guidance: 'Add regional breakdown and cite a forward projection.', idempotencyKey: `slice-e-rev-${artifact.id}` });
  if (revision.status !== 'ok' || revision.revision === undefined || revision.newTaskId === undefined) return bail('revision requested', 'TASK-005 / J-13', `expected ok, got ${revision.status}`);
  if (revision.newTaskId === taskId) return bail('revision creates a NEW linked task', 'J-13', 'the revision re-used the original task — J-13 says "new linked task created", and running→completed is terminal');
  const afterRevision = await ops.readCreditLedger(product, { userId, accountId, limit: LEDGER_LIMIT });
  if (afterRevision.status !== 'ok' || afterRevision.balance !== balanceBeforeRevision) {
    return bail('a revision request charges nothing', 'BILL-002', `balance moved from ${balanceBeforeRevision} to ${String(afterRevision.balance)} — the new task meters when it is QUEUED, and charging here would be the D9 double-charge in a new place (CDR-064 G4)`);
  }
  record('a revision creates a new linked task and charges nothing yet', 'TASK-005 / J-13', true, `artifact ${artifact.id} → new task ${revision.newTaskId}; balance unchanged at ${balanceBeforeRevision} — the new task meters when it is queued, not when it is asked for`);

  // ── 12. lineage: both versions retained ────────────────────────────────────────────────────────────────
  const lineage = await ops.readArtifactLineage(product, { ...ids, artifactId: artifact.id });
  if (lineage.status !== 'ok' || lineage.artifact === undefined) return bail('lineage visible', 'TASK-005 / J-13', `expected ok, got ${lineage.status}`);
  // BOTH VERSIONS RETAINED is the half a demo loses silently: the original must still read back, unchanged.
  if (lineage.artifact.artifactId !== artifact.id) return bail('both versions retained', 'J-13', 'the original artifact no longer reads back as itself');
  if (lineage.revisedFrom !== null) return bail('lineage visible', 'J-13', 'the ORIGINAL artifact reports an ancestor — it has none');
  const asked = lineage.revisions ?? [];
  if (asked.length !== 1 || asked[0]?.newTaskId !== revision.newTaskId) return bail('lineage visible', 'J-13', `expected exactly the one revision just requested, got ${asked.length}`);
  record('the lineage is visible and both versions are retained', 'TASK-005 / J-13', true, `original ${artifact.id} still reads back with no ancestor; 1 revision recorded pointing at task ${revision.newTaskId}`);

  // ══ THE NEGATIVE SET ═══════════════════════════════════════════════════════════════════════════════════
  // Everything above proves the platform does the right thing when it works. These prove it does not LIE when it
  // does not — which is the property the backlog's security column names, and the harder one to keep.

  // ── 13. no hollow success: a failed generation produces NO artifact and an honest category ─────────────
  const failTaskId = await queuedResearchTask('Research task that will fail');
  if (failTaskId === undefined) return bail('no-hollow-success setup', 'TASK-006', 'could not queue the second task');
  const failRunStart = await ops.startRun(product, { ...ids, taskId: failTaskId, attempt: 1 });
  if (failRunStart.status !== 'ok' || failRunStart.run === undefined) return bail('no-hollow-success setup', 'TASK-006', `startRun expected ok, got ${failRunStart.status}`);
  const failRunId = failRunStart.run.id;
  const failReserve = await ops.reserveCredit(product, { ...ids, taskRunId: failRunId, idempotencyKey: `slice-e-${failRunId}` });
  if (failReserve.status !== 'ok') return bail('no-hollow-success setup', 'BILL-002', `reserveCredit expected ok, got ${failReserve.status}`);

  const generationFailed = await ops.runResearch(product, researchParams(failRunId), researchDeps({ kind: 'fail', error: 'provider unavailable' }));
  // THE EXACT STATUS, not merely "not ok". `!== 'ok'` would pass for `blank_question` or `invalid_task_type` — i.e.
  // it would stay green even if the generation path were never reached and the failure came from somewhere else
  // entirely. A negative that cannot tell which thing failed is not evidence about the thing it names (D11).
  if (generationFailed.status !== 'generation_failed') return bail('a failed generation reports failure', 'TASK-006', `expected generation_failed, got ${generationFailed.status} — a status other than 'ok' is not enough: this negative has to prove the GENERATION failed, not that something did`);
  const failArtifacts = await ops.listRunArtifacts(product, { ...ids, runId: failRunId });
  if (failArtifacts === 'forbidden') return bail('a failed run persists nothing', 'TASK-006', 'listRunArtifacts refused');
  if (failArtifacts.length !== 0) return bail('a failed run persists nothing', 'TASK-006', `${failArtifacts.length} artifact(s) survived a failed run — a partial document reads as a complete answer to a founder who cannot see what was dropped`);

  const failed = await ops.failRun(product, { ...ids, runId: failRunId, failureCategory: 'provider_error' });
  if (failed.status !== 'ok' || failed.run === undefined) return bail('failure is recorded with a category', 'TASK-006', `failRun expected ok, got ${failed.status}`);
  if (failed.run.state !== 'failed' || failed.run.failureCategory !== 'provider_error') return bail('failure is recorded with a category', 'TASK-006', `expected failed/provider_error, got ${failed.run.state}/${String(failed.run.failureCategory)} — "no blank failures" means a category`);
  record('a failed run reports failure, persists nothing, and names a category', 'TASK-006 / TASK-010', true, `status=${generationFailed.status}, 0 artifacts, category=provider_error — the no-hollow-success negative`);

  // ── 14. the failed run RELEASES its reservation ────────────────────────────────────────────────────────
  const releaseSettle = await ops.settleRun(product, { ...ids, taskRunId: failRunId });
  if (releaseSettle.status !== 'ok') return bail('a failed run releases its credit', 'BILL-002', `expected ok, got ${releaseSettle.status}`);
  if (releaseSettle.settlement !== 'release') return bail('a failed run releases its credit', 'BILL-002', `a FAILED run must release, got ${String(releaseSettle.settlement)} — charging for work that produced nothing is the worst available outcome`);
  record('a failed run gives the credit back', 'BILL-002', true, `settlement=release, balance ${String(releaseSettle.balanceAfter)} — the founder is not charged for a document they never received`);

  // ── 15. a fabricated citation cannot reach storage (WORK-002) ──────────────────────────────────────────
  const fabTaskId = await queuedResearchTask('Research task with a fabricated citation');
  if (fabTaskId === undefined) return bail('fabricated-citation setup', 'WORK-002', 'could not queue the third task');
  const fabStart = await ops.startRun(product, { ...ids, taskId: fabTaskId, attempt: 1 });
  if (fabStart.status !== 'ok' || fabStart.run === undefined) return bail('fabricated-citation setup', 'WORK-002', `startRun expected ok, got ${fabStart.status}`);
  const fabRunId = fabStart.run.id;
  const fabricated = await ops.runResearch(product, researchParams(fabRunId), researchDeps({ kind: 'respond', output: FABRICATED_OUTPUT }));
  // `uncertified` EXACTLY. Anything looser and this step would stay green if the document were rejected for some
  // unrelated reason before certification ever ran — which would leave WORK-002's actual promise untested while
  // reading like proof of it.
  if (fabricated.status !== 'uncertified') return bail('a fabricated citation is refused', 'WORK-002', `expected uncertified, got ${fabricated.status} — the refusal must come from CERTIFICATION, or this proves nothing about invented citations`);
  const fabArtifacts = await ops.listRunArtifacts(product, { ...ids, runId: fabRunId });
  if (fabArtifacts === 'forbidden') return bail('a fabricated citation persists nothing', 'WORK-002', 'listRunArtifacts refused');
  if (fabArtifacts.length !== 0) return bail('a fabricated citation persists nothing', 'WORK-002', `${fabArtifacts.length} artifact(s) persisted despite failing certification`);
  record('a fabricated citation is refused and nothing is stored', 'WORK-002', true, `status=${fabricated.status} — certification happens BEFORE persist, so an uncertified document cannot reach storage`);

  // ── 16. an unaffordable account cannot start work (TASK-004) ───────────────────────────────────────────
  // Drain what is left through the PRODUCT: reserve against the fabricated run and never settle it. No owner-side
  // arithmetic — the refusal has to come from the same balance derivation the product uses everywhere else.
  const drain = await ops.reserveCredit(product, { ...ids, taskRunId: fabRunId, idempotencyKey: `slice-e-drain-${fabRunId}` });
  if (drain.status !== 'ok') return bail('unaffordable setup', 'TASK-004', `expected the last credit to reserve, got ${drain.status}`);

  const brokeTaskId = await queuedResearchTask('Research task with no credits left');
  if (brokeTaskId === undefined) return bail('unaffordable setup', 'TASK-004', 'could not queue the fourth task');
  const brokePre = await ops.preflightRun(product, ids);
  if (brokePre.status !== 'ok' || brokePre.affordable !== false) return bail('preflight refuses honestly when broke', 'TASK-004', `expected affordable=false at balance ${String(brokePre.balance)}, got ${String(brokePre.affordable)}`);
  const brokeStart = await ops.startRun(product, { ...ids, taskId: brokeTaskId, attempt: 1 });
  if (brokeStart.status !== 'ok' || brokeStart.run === undefined) return bail('unaffordable setup', 'TASK-004', `startRun expected ok, got ${brokeStart.status}`);
  const refused = await ops.reserveCredit(product, { ...ids, taskRunId: brokeStart.run.id, idempotencyKey: `slice-e-broke-${brokeStart.run.id}` });
  if (refused.status !== 'insufficient_credits') return bail('an unaffordable run is refused', 'TASK-004', `expected insufficient_credits, got ${refused.status}`);
  if (refused.balance === undefined || refused.cost === undefined) return bail('the refusal carries the numbers', 'TASK-004', 'insufficient_credits arrived without the balance and cost the founder needs to act on it');
  const brokeArtifacts = await ops.listRunArtifacts(product, { ...ids, runId: brokeStart.run.id });
  if (brokeArtifacts === 'forbidden' || brokeArtifacts.length !== 0) return bail('an unaffordable run does no work', 'TASK-004', 'an artifact exists for a run that was never paid for');
  record('an unaffordable run is refused with the numbers, and does no work', 'TASK-004 / BILL-002', true, `preflight said affordable=false; reserveCredit refused with balance=${refused.balance}, cost=${refused.cost}; 0 artifacts produced`);

  return { steps };
}
